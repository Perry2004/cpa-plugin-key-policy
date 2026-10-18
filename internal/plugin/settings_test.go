package plugin

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"testing"
)

func TestSchedulerSettingsManagementAndRestartPersistence(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "state.json")
	app := configureSettingsApp(t, statePath)

	patchResponse := callManagementForTest(t, app, http.MethodPatch, "/v0/management/plugins/cpa-key-policy/settings", []byte(`{"global_weighted_round_robin":true}`))
	assertGlobalWeightedSetting(t, patchResponse, http.StatusOK, true)

	getResponse := callManagementForTest(t, app, http.MethodGet, "/v0/management/plugins/cpa-key-policy/settings", nil)
	assertGlobalWeightedSetting(t, getResponse, http.StatusOK, true)

	restarted := configureSettingsApp(t, statePath)
	restartedResponse := callManagementForTest(t, restarted, http.MethodGet, "/v0/management/plugins/cpa-key-policy/settings", nil)
	assertGlobalWeightedSetting(t, restartedResponse, http.StatusOK, true)
}

func TestSchedulerSettingsRejectsMissingValue(t *testing.T) {
	app := configureSettingsApp(t, filepath.Join(t.TempDir(), "state.json"))
	response := callManagementForTest(t, app, http.MethodPatch, "/v0/management/plugins/cpa-key-policy/settings", []byte(`{}`))
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("缺少设置时状态码 = %d，期望 %d，响应体 = %s", response.StatusCode, http.StatusBadRequest, response.Body)
	}
}

func configureSettingsApp(t *testing.T, statePath string) *App {
	t.Helper()
	app := newTestApp(t)
	configYAML := []byte("enabled: true\nstate_file: \"" + filepath.ToSlash(statePath) + "\"\nglobal_weighted_round_robin: false\n")
	request, err := json.Marshal(LifecycleRequest{ConfigYAML: configYAML})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := app.HandleMethod(MethodPluginReconfigure, request); err != nil {
		t.Fatalf("配置调度设置测试应用失败: %v", err)
	}
	return app
}

func callManagementForTest(t *testing.T, app *App, method, path string, body []byte) ManagementResponse {
	t.Helper()
	request, err := json.Marshal(ManagementRequest{Method: method, Path: path, Body: body})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := app.HandleMethod(MethodManagementHandle, request)
	if err != nil {
		t.Fatal(err)
	}
	return managementResponseFromEnvelope(t, raw)
}

func assertGlobalWeightedSetting(t *testing.T, response ManagementResponse, expectedStatus int, expectedValue bool) {
	t.Helper()
	if response.StatusCode != expectedStatus {
		t.Fatalf("设置接口状态码 = %d，期望 %d，响应体 = %s", response.StatusCode, expectedStatus, response.Body)
	}
	var payload struct {
		GlobalWeightedRoundRobin bool `json:"global_weighted_round_robin"`
	}
	if err := json.Unmarshal(response.Body, &payload); err != nil {
		t.Fatalf("解析设置接口响应失败: %v，响应体 = %s", err, response.Body)
	}
	if payload.GlobalWeightedRoundRobin != expectedValue {
		t.Fatalf("全局加权轮询 = %v，期望 %v", payload.GlobalWeightedRoundRobin, expectedValue)
	}
}
