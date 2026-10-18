package policy

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const liteLLMURL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"

type ModelPrice map[string]json.RawMessage
type priceSnapshot struct {
	FetchedAt time.Time             `json:"fetched_at"`
	Models    map[string]ModelPrice `json:"models"`
}

// PriceCatalog shares one last-good catalog between billing and the management UI.
// Refreshes are bounded, single-flight and never block usage callbacks.
type PriceCatalog struct {
	mu         sync.RWMutex
	snapshot   priceSnapshot
	path, url  string
	client     *http.Client
	refreshing bool
	attempted  time.Time
}

func NewPriceCatalog(path string) *PriceCatalog {
	c := &PriceCatalog{path: path, url: liteLLMURL, client: &http.Client{Timeout: 10 * time.Second}}
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, &c.snapshot)
	}
	return c
}
func (c *PriceCatalog) Refresh() error {
	c.mu.Lock()
	if c.refreshing || (!c.snapshot.FetchedAt.IsZero() && time.Since(c.snapshot.FetchedAt) < 24*time.Hour) || time.Since(c.attempted) < time.Minute {
		c.mu.Unlock()
		return nil
	}
	c.refreshing = true
	c.attempted = time.Now()
	c.mu.Unlock()
	defer func() { c.mu.Lock(); c.refreshing = false; c.mu.Unlock() }()
	res, err := c.client.Get(c.url)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fmt.Errorf("LiteLLM prices: HTTP %d", res.StatusCode)
	}
	var raw map[string]ModelPrice
	if err = json.NewDecoder(io.LimitReader(res.Body, 32<<20)).Decode(&raw); err != nil {
		return err
	}
	models := make(map[string]ModelPrice)
	for name, p := range raw {
		if name != "sample_spec" && (p.rate("input_cost_per_token", 0) != nil || p.rate("output_cost_per_token", 0) != nil) {
			models[strings.ToLower(name)] = p
		}
	}
	if len(models) == 0 {
		return fmt.Errorf("LiteLLM prices: empty catalog")
	}
	snap := priceSnapshot{time.Now().UTC(), models}
	if c.path != "" {
		b, _ := json.Marshal(snap)
		if err = atomicWriteStateFile(c.path, b); err != nil {
			return err
		}
	}
	c.mu.Lock()
	c.snapshot = snap
	c.mu.Unlock()
	return nil
}
func (c *PriceCatalog) Models() map[string]ModelPrice {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := make(map[string]ModelPrice, len(c.snapshot.Models))
	for model, p := range c.snapshot.Models {
		row := ModelPrice{}
		for _, field := range []string{"input_cost_per_token", "output_cost_per_token", "cache_read_input_token_cost"} {
			if v, ok := p[field]; ok {
				row[field] = v
			}
		}
		out[model] = row
	}
	return out
}
func (c *PriceCatalog) Lookup(provider, model string) ModelPrice {
	c.mu.RLock()
	stale := time.Since(c.snapshot.FetchedAt) >= 24*time.Hour
	c.mu.RUnlock()
	if stale {
		go c.Refresh()
	}
	provider = strings.ToLower(strings.TrimSpace(provider))
	model = strings.ToLower(strings.TrimSpace(model))
	if provider == "codex" {
		provider = "openai"
	}
	if provider == "claude" {
		provider = "anthropic"
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	if p := c.snapshot.Models[provider+"/"+model]; p != nil {
		return p
	}
	return c.snapshot.Models[model]
}
func (p ModelPrice) rate(field string, context int64) *float64 {
	return p.tierRate(field, context, "")
}
func (p ModelPrice) tierRate(field string, context int64, tier string) *float64 {
	suffixTier := ""
	switch strings.ToLower(strings.TrimSpace(tier)) {
	case "", "default", "standard", "auto":
	default:
		suffixTier = "_" + strings.ToLower(strings.TrimSpace(tier))
	}
	key := field + suffixTier
	var highest int64
	for k := range p {
		candidate := k
		if suffixTier != "" {
			if !strings.HasSuffix(k, suffixTier) {
				continue
			}
			candidate = strings.TrimSuffix(k, suffixTier)
		}
		suffix, ok := strings.CutPrefix(candidate, field+"_above_")
		if !ok {
			continue
		}
		suffix = strings.TrimSuffix(suffix, "_tokens")
		mult := int64(1)
		if strings.HasSuffix(suffix, "k") {
			mult = 1000
			suffix = strings.TrimSuffix(suffix, "k")
		}
		n, e := strconv.ParseInt(suffix, 10, 64)
		n *= mult
		if e == nil && context > n && n > highest {
			highest = n
			key = k
		}
	}
	var v float64
	if b := p[key]; len(b) == 0 || string(b) == "null" || json.Unmarshal(b, &v) != nil || math.IsNaN(v) || math.IsInf(v, 0) || v < 0 {
		return nil
	}
	return &v
}

// Cost uses CPA's consumed tokens, including provider-specific cache semantics.
// A missing rate matters only when that token category was consumed.
func (p ModelPrice) Cost(provider string, d UsageDetail) (cost, cacheCost float64, cache, input int64, known bool) {
	input = max(0, d.InputTokens)
	output := max(0, d.OutputTokens)
	cache = max(0, d.CacheReadTokens)
	if cache == 0 {
		cache = max(0, d.CachedTokens)
	}
	creation := max(0, d.CacheCreationTokens)
	if !isCacheAdditiveProvider(provider) {
		cache = min(cache, input)
		input -= cache
		creation = 0
	}
	context := input + cache + creation
	known = p != nil
	for _, part := range []struct {
		n     int64
		field string
		cache bool
	}{{input, "input_cost_per_token", false}, {output, "output_cost_per_token", false}, {cache, "cache_read_input_token_cost", true}, {creation, "cache_creation_input_token_cost", false}} {
		if part.n == 0 {
			continue
		}
		rate := p.tierRate(part.field, context, d.ServiceTier)
		if rate == nil {
			known = false
			continue
		}
		amount := float64(part.n) * *rate
		cost += amount
		if part.cache {
			cacheCost += amount
		}
	}
	if !known {
		cost = 0
		cacheCost = 0
	}
	return cost, cacheCost, cache, input + creation, known
}
func (s *Store) SetPriceCatalog(c *PriceCatalog) { s.mu.Lock(); s.prices = c; s.mu.Unlock() }
func (s *Store) PriceCatalog() *PriceCatalog     { s.mu.RLock(); defer s.mu.RUnlock(); return s.prices }
