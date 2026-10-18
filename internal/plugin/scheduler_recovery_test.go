package plugin

import (
	"encoding/json"
	"testing"
)

func TestSchedulerTrustsCPAEligibilityAfterErrors(t *testing.T) {
	for _, mode := range []string{"ungrouped", "grouped", "global"} {
		t.Run(mode, func(t *testing.T) {
			app, key := configureTestApp(t)
			if mode == "global" {
				app, key = configureGlobalSchedulerApp(t)
			}
			group := ""
			if mode == "grouped" {
				group = "team"
			}
			req := SchedulerPickRequest{Provider: "codex", Model: "gpt-5-codex", Options: SchedulerPickOptions{Headers: map[string][]string{"Authorization": {"Bearer " + key}}, Metadata: map[string]any{"group": group}}}
			// Eligibility belongs to the host. Historical status must not prevent
			// recovery for any failure class or after the host's cooldown expires.
			for _, status := range []string{"error", "expired", "unavailable", "cooldown", "quota_exhausted", "unknown"} {
				req.Candidates = []SchedulerAuthCandidate{{ID: "retry", Provider: "codex", Status: status, Attributes: map[string]string{"plan_type": "team"}}}
				got := schedulerPickForTest(t, app, req)
				if !got.Handled || got.AuthID != "retry" {
					t.Fatalf("status %q: %+v", status, got)
				}
			}
			// When CPA excludes a credential, never recreate it or clear host state.
			req.Candidates = nil
			raw, err := json.Marshal(req)
			if err != nil {
				t.Fatal(err)
			}
			raw, err = app.HandleMethod(MethodSchedulerPick, raw)
			if err != nil {
				t.Fatal(err)
			}
			var got SchedulerPickResponse
			if err := unmarshalOK(raw, &got); err != nil {
				t.Fatal(err)
			}
			if got.Handled || got.AuthID != "" {
				t.Fatalf("empty host pool: %+v", got)
			}
		})
	}
}

func TestSchedulerRecoveryPreservesWeightsAndGroupIsolation(t *testing.T) {
	app, key := configureTestApp(t)
	req := SchedulerPickRequest{Provider: "codex", Options: SchedulerPickOptions{Headers: map[string][]string{"Authorization": {"Bearer " + key}}, Metadata: map[string]any{"group": "team"}}, Candidates: []SchedulerAuthCandidate{
		{ID: "a", Provider: "codex", Status: "error", Attributes: map[string]string{"plan_type": "team", "weight": "2"}},
		{ID: "b", Provider: "codex", Status: "error", Attributes: map[string]string{"plan_type": "team", "weight": "1"}},
		{ID: "other", Provider: "codex", Priority: 100, Attributes: map[string]string{"plan_type": "pro"}},
	}}
	counts := map[string]int{}
	for i := 0; i < 6; i++ {
		counts[schedulerPickForTest(t, app, req).AuthID]++
	}
	if counts["a"] != 4 || counts["b"] != 2 || counts["other"] != 0 {
		t.Fatalf("weights/group: %v", counts)
	}
	req.Candidates = req.Candidates[2:]
	raw, _ := json.Marshal(req)
	result, err := app.HandleMethod(MethodSchedulerPick, raw)
	if err != nil {
		t.Fatal(err)
	}
	var env Envelope
	if err := json.Unmarshal(result, &env); err != nil {
		t.Fatal(err)
	}
	if env.OK || env.Error == nil || env.Error.HTTPStatus != 503 || env.Error.Message != "cpa-key-policy: no available credential candidates in the requested group" {
		t.Fatalf("group failure: %s", result)
	}
}
