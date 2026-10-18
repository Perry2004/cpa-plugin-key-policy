package policy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func testPrice(raw string) ModelPrice {
	var p ModelPrice
	_ = json.Unmarshal([]byte(raw), &p)
	return p
}
func TestAutomaticCost(t *testing.T) {
	p := testPrice(`{"input_cost_per_token":0.000002,"output_cost_per_token":0.00001,"cache_read_input_token_cost":0,"cache_creation_input_token_cost":0.000003,"input_cost_per_token_priority":0.000004,"output_cost_per_token_priority":0.00002,"cache_read_input_token_cost_priority":0,"input_cost_per_token_above_272k_tokens":0.000004,"output_cost_per_token_above_272k_tokens":0.000015,"cache_read_input_token_cost_above_272k_tokens":0}`)
	for _, tc := range []struct {
		name, provider string
		detail         UsageDetail
		price          ModelPrice
		want           float64
		known          bool
	}{
		{"subset and free cache", "codex", UsageDetail{InputTokens: 1000, CachedTokens: 400, OutputTokens: 100}, p, .0022, true},
		{"additive cache writes", "claude", UsageDetail{InputTokens: 1000, CacheReadTokens: 400, CacheCreationTokens: 100, OutputTokens: 100}, p, .0033, true},
		{"cache only", "claude", UsageDetail{CacheReadTokens: 400}, p, 0, true},
		{"priority", "codex", UsageDetail{InputTokens: 1000, CachedTokens: 400, OutputTokens: 100, ServiceTier: "priority"}, p, .0044, true},
		{"long context", "codex", UsageDetail{InputTokens: 300000, OutputTokens: 100}, p, 1.2015, true},
		{"missing model", "codex", UsageDetail{InputTokens: 1000}, nil, 0, false},
		{"missing output rate", "codex", UsageDetail{InputTokens: 1000, OutputTokens: 1}, testPrice(`{"input_cost_per_token":0}`), 0, false},
		{"missing cache rate", "codex", UsageDetail{InputTokens: 1000, CachedTokens: 100}, testPrice(`{"input_cost_per_token":0}`), 0, false},
		{"free model", "codex", UsageDetail{InputTokens: 1000, OutputTokens: 100}, testPrice(`{"input_cost_per_token":0,"output_cost_per_token":0}`), 0, true},
		{"invalid rate", "codex", UsageDetail{InputTokens: 1}, testPrice(`{"input_cost_per_token":-1}`), 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, _, _, _, known := tc.price.Cost(tc.provider, tc.detail)
			if known != tc.known || got < tc.want-1e-9 || got > tc.want+1e-9 {
				t.Fatalf("got %v/%v want %v/%v", got, known, tc.want, tc.known)
			}
		})
	}
}
func TestCatalogRefreshCacheAndFailure(t *testing.T) {
	var count atomic.Int32
	var fail atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		count.Add(1)
		if fail.Load() {
			http.Error(w, "offline", 503)
			return
		}
		w.Write([]byte(`{"sample_spec":{},"m":{"input_cost_per_token":0.000002},"openai/m":{"input_cost_per_token":0.000003},"free":{"input_cost_per_token":0,"output_cost_per_token":0}}`))
	}))
	defer srv.Close()
	path := filepath.Join(t.TempDir(), "prices.json")
	c := NewPriceCatalog(path)
	c.url = srv.URL
	var wg sync.WaitGroup
	for range 20 {
		wg.Add(1)
		go func() { defer wg.Done(); _ = c.Refresh() }()
	}
	wg.Wait()
	if count.Load() != 1 {
		t.Fatal("refresh not coalesced", count.Load())
	}
	if *c.Lookup("codex", "M").rate("input_cost_per_token", 0) != .000003 {
		t.Fatal("provider lookup")
	}
	if c.Lookup("codex", "m-new") != nil {
		t.Fatal("guessed model")
	}
	loaded := NewPriceCatalog(path)
	if loaded.Lookup("", "free") == nil {
		t.Fatal("cache not loaded")
	}
	c.mu.Lock()
	c.snapshot.FetchedAt = time.Now().Add(-48 * time.Hour)
	c.attempted = time.Time{}
	c.mu.Unlock()
	fail.Store(true)
	if c.Refresh() == nil {
		t.Fatal("expected refresh failure")
	}
	if c.Lookup("", "m") == nil {
		t.Fatal("lost last good prices")
	}
}
func TestAutomaticUsageRecordsUnknownAndPersists(t *testing.T) {
	s := NewStore()
	cfg := DefaultConfig()
	cfg.StateFile = filepath.Join(t.TempDir(), "state.json")
	hash, _ := HashKey("cpa_test")
	cfg.Keys = []KeyConfig{{ID: "k", Enabled: true, KeyHash: hash, Models: []ModelRule{{Alias: "friendly", Provider: "codex", TargetModel: "m", InputPricePerMillion: 999, OutputPricePerMillion: 999}}}}
	if err := s.Configure(cfg); err != nil {
		t.Fatal(err)
	}
	c := NewPriceCatalog("")
	c.snapshot = priceSnapshot{time.Now(), map[string]ModelPrice{"m": testPrice(`{"input_cost_per_token":0.000002,"output_cost_per_token":0.00001,"cache_read_input_token_cost":0.0000001}`), "other": testPrice(`{"input_cost_per_token":0.000004}`)}}
	s.SetPriceCatalog(c)
	if got := s.RecordUsage("k", "friendly", "m", false, UsageDetail{InputTokens: 1000, CachedTokens: 400, OutputTokens: 100}); got < .00224-1e-9 || got > .00224+1e-9 {
		t.Fatal("automatic cost", got)
	}
	if got := s.RecordUsage("k", "friendly", "other", false, UsageDetail{InputTokens: 1000}); got != .004 {
		t.Fatal("actual model", got)
	}
	s.RecordUsage("k", "friendly", "missing", false, UsageDetail{InputTokens: 1000, OutputTokens: 100})
	_, rows, _ := s.AliasUsageFor("k")
	w := rows[0].Daily
	if w.CallCount != 3 || w.UnpricedRequests != 1 || w.InputTokens != 2600 || w.OutputTokens != 200 || w.CacheReadTokens != 400 {
		t.Fatalf("usage %+v", w)
	}
	s.StopUsageFlusher()
	fresh := NewStore()
	cfg.Keys = nil
	if err := fresh.Configure(cfg); err != nil {
		t.Fatal(err)
	}
	_, rows, _ = fresh.AliasUsageFor("k")
	if rows[0].Daily.UnpricedRequests != 1 {
		t.Fatal("unknown count lost on restart")
	}
}
