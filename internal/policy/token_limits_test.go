package policy

import (
	"net/http"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestConsumedTokens(t *testing.T) {
	for _, tc := range []struct {
		name, provider string
		detail         UsageDetail
		want           int64
	}{
		{"canonical total includes reasoning", "antigravity", UsageDetail{InputTokens: 12, OutputTokens: 3, ReasoningTokens: 113, TotalTokens: 128}, 128},
		{"Gemini fallback reasoning", "antigravity", UsageDetail{InputTokens: 12, OutputTokens: 3, ReasoningTokens: 113}, 128},
		{"OpenAI reasoning already in output", "codex", UsageDetail{InputTokens: 100, OutputTokens: 50, ReasoningTokens: 30, CachedTokens: 80}, 150},
		{"Claude cache is additive", "claude", UsageDetail{InputTokens: 10, OutputTokens: 20, CacheReadTokens: 40, CachedTokens: 40, CacheCreationTokens: 30}, 100},
		{"cache only", "claude", UsageDetail{CacheReadTokens: 50}, 50},
		{"negative counters", "gemini", UsageDetail{InputTokens: -1, OutputTokens: -2, ReasoningTokens: -3}, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.detail.ConsumedTokens(tc.provider); got != tc.want {
				t.Fatalf("got %d want %d", got, tc.want)
			}
		})
	}
}

func TestTokenLimitsUnpricedPersistenceAndWindows(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	s := NewStore()
	s.SetClock(func() time.Time { return now })
	cfg := DefaultConfig()
	cfg.StateFile = filepath.Join(t.TempDir(), "state.json")
	cfg.Keys = []KeyConfig{{ID: "tokens", Enabled: true, KeyHash: hashForUsageTest(t, "cpa_token_quota"), DailyLimitTokens: 100, WeeklyLimitTokens: 200, Models: []ModelRule{{Alias: "unknown", Provider: "antigravity", TargetModel: "unknown"}}}}
	if err := s.Configure(cfg); err != nil {
		t.Fatal(err)
	}
	catalog := NewPriceCatalog("")
	catalog.snapshot = priceSnapshot{FetchedAt: time.Now(), Models: map[string]ModelPrice{}}
	s.SetPriceCatalog(catalog)
	headers := http.Header{"Authorization": {"Bearer cpa_token_quota"}}
	auth := func(store *Store) AuthDecision {
		return store.Authenticate("POST", "/v1/responses", headers, nil, []byte(`{"model":"unknown"}`))
	}
	if !auth(s).Allowed {
		t.Fatal("new key blocked")
	}
	s.RecordUsage("tokens", "unknown", "unknown", false, UsageDetail{InputTokens: 12, OutputTokens: 3, ReasoningTokens: 85, TotalTokens: 100})
	if d := auth(s); d.Allowed || d.Reason != "daily_tokens_exceeded" {
		t.Fatalf("daily limit: %+v", d)
	}
	sum := s.UsageSummaryFor(s.Keys()[0])
	if sum.DailyTokens != 100 || sum.DailyUSD != 0 || sum.DailyUnpricedRequests != 1 {
		t.Fatalf("unpriced usage: %+v", sum)
	}
	s.StopUsageFlusher()
	fresh := NewStore()
	fresh.SetClock(func() time.Time { return now })
	cfg.Keys = nil
	if err := fresh.Configure(cfg); err != nil {
		t.Fatal(err)
	}
	if d := auth(fresh); d.Allowed || d.Reason != "daily_tokens_exceeded" {
		t.Fatalf("restart lost quota: %+v", d)
	}
	fresh.SetPriceCatalog(catalog)
	now = now.Add(24 * time.Hour)
	if !auth(fresh).Allowed {
		t.Fatal("daily quota did not reset")
	}
	fresh.RecordUsage("tokens", "unknown", "unknown", true, UsageDetail{TotalTokens: 100, InputTokens: 100})
	key := fresh.Keys()[0]
	key.DailyLimitTokens = 0
	if err := fresh.UpsertKey(key, true); err != nil {
		t.Fatal(err)
	}
	if d := auth(fresh); d.Allowed || d.Reason != "weekly_tokens_exceeded" {
		t.Fatalf("weekly limit: %+v", d)
	}
	now = now.Add(7 * 24 * time.Hour)
	if !auth(fresh).Allowed {
		t.Fatal("weekly quota did not reset")
	}
	key = fresh.Keys()[0]
	key.WeeklyLimitTokens = 0
	if err := fresh.UpsertKey(key, true); err != nil {
		t.Fatal(err)
	}
	fresh.RecordUsage("tokens", "unknown", "unknown", false, UsageDetail{TotalTokens: 1000000})
	if !auth(fresh).Allowed {
		t.Fatal("zero limits must remain unlimited")
	}
	fresh.StopUsageFlusher()
}

func TestTokenLedgerConcurrentAccounting(t *testing.T) {
	ledger := newUsageLedger(time.Now)
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); ledger.RecordTokens("key", "model", 7) }()
	}
	wg.Wait()
	sum := ledger.Summary(KeyConfig{ID: "key"})
	if sum.DailyTokens != 700 || sum.WeeklyTokens != 700 {
		t.Fatalf("lost concurrent usage: %+v", sum)
	}
	snapshot := ledger.snapshot()
	if snapshot["key"].ByAlias["model"].Daily.TotalTokens != 700 {
		t.Fatal("alias totals differ")
	}
}
