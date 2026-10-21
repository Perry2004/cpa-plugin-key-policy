package plugin

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestTokenQuotaManagementAPI(t *testing.T) {
	app, _ := configureTestApp(t)
	call := func(method string, body string) ManagementResponse {
		t.Helper()
		req, _ := json.Marshal(ManagementRequest{Method: method, Path: "/v0/management/plugins/cpa-key-policy/keys", Body: json.RawMessage(body)})
		raw, err := app.HandleMethod(MethodManagementHandle, req)
		if err != nil {
			t.Fatal(err)
		}
		return managementResponseFromEnvelope(t, raw)
	}
	for _, tc := range []struct {
		body string
		want int
	}{
		{`{"id":"team-a","daily_limit_tokens":-1}`, 400},
		{`{"id":"team-a","weekly_limit_tokens":-1}`, 400},
		{`{"id":"team-a","daily_limit_tokens":1.5}`, 400},
		{`{"id":"team-a","daily_limit_tokens":100,"weekly_limit_tokens":200}`, 200},
		{`{"id":"team-a","name":"renamed"}`, 200},
	} {
		r := call(http.MethodPatch, tc.body)
		if r.StatusCode != tc.want {
			t.Fatalf("%s: status %d: %s", tc.body, r.StatusCode, r.Body)
		}
		if tc.want == 200 {
			var data struct {
				Key publicKey `json:"key"`
			}
			if err := json.Unmarshal(r.Body, &data); err != nil {
				t.Fatal(err)
			}
			if data.Key.DailyLimitTokens != 100 || data.Key.WeeklyLimitTokens != 200 || data.Key.Usage.DailyLimitTokens != 100 {
				t.Fatalf("limits lost: %+v", data.Key)
			}
		}
	}
	r := call(http.MethodPost, `{"id":"new-quota","daily_limit_tokens":300,"weekly_limit_tokens":400}`)
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("create: %s", r.Body)
	}
	var created struct {
		Key publicKey `json:"key"`
	}
	if err := json.Unmarshal(r.Body, &created); err != nil {
		t.Fatal(err)
	}
	if created.Key.DailyLimitTokens != 300 || created.Key.WeeklyLimitTokens != 400 {
		t.Fatal("create lost token quotas")
	}
	r = call(http.MethodPatch, `{"id":"team-a","daily_limit_tokens":0,"weekly_limit_tokens":0}`)
	if r.StatusCode != 200 {
		t.Fatalf("clear: %s", r.Body)
	}
}
