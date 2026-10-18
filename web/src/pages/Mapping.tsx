import AutomaticPrice from "../components/AutomaticPrice";
import { useEffect, useState, useCallback } from "react";
import { useNavigate, useParams, useLocation } from "react-router-dom";
import { useT } from "../i18n";
import type { AliasMapping, AliasTarget, ClassifyRule, ClassifyPreviewResponse, CredentialDescriptor } from "../types";
import {
  fetchAliases,
  upsertAlias,
  deleteAlias,
  fetchClassifyRules,
  upsertClassifyRule,
  deleteClassifyRule,
  reorderClassifyRules,
  classifyPreview,
  fetchCredentialDescriptors,
  fetchSchedulerSettings,
  updateSchedulerSettings,
} from "../api/mappings";

export default function Mapping() {
  const t = useT();
  const loc = useLocation();
  const [tab, setTab] = useState<"alias" | "classify">("alias");

  // Pick up returned state (new targets from ModelPick, etc.)
  useEffect(() => {
    if (loc.state?.mappingTab) setTab(loc.state.mappingTab);
  }, [loc.state]);

  return (
    <div className="map-page">
      <div className="map-page-head">
        <h1>{t("mapping.title")}</h1>
      </div>
      <div className="map-tabs">
        <button className={"map-tab" + (tab === "alias" ? " active" : "")} onClick={() => setTab("alias")}>
          {t("mapping.aliasTab")}
        </button>
        <button className={"map-tab" + (tab === "classify" ? " active" : "")} onClick={() => setTab("classify")}>
          {t("mapping.classifyTab")}
        </button>
      </div>
      {tab === "alias" ? <AliasListTab /> : <ClassifyTab />}
    </div>
  );
}

// --- Alias List Tab ---

function AliasListTab() {
  const t = useT();
  const nav = useNavigate();
  const [aliases, setAliases] = useState<AliasMapping[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [globalWeighted, setGlobalWeighted] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, settings] = await Promise.all([
        fetchAliases(),
        fetchSchedulerSettings(),
      ]);
      setAliases(list);
      setGlobalWeighted(settings.global_weighted_round_robin);
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleDelete = async (aliasName: string) => {
    try {
      await deleteAlias(aliasName);
      await load();
    } catch (e: unknown) {
      setError(String(e));
    }
  };

  const handleGlobalWeightedChange = async (enabled: boolean) => {
    const previous = globalWeighted;
    setGlobalWeighted(enabled);
    setSettingsSaving(true);
    setError("");
    try {
      const settings = await updateSchedulerSettings(enabled);
      setGlobalWeighted(settings.global_weighted_round_robin);
    } catch (e: unknown) {
      setGlobalWeighted(previous);
      setError(t("mapping.globalWeightedSaveFailed") + ": " + String(e));
    } finally {
      setSettingsSaving(false);
    }
  };

  return (
    <>
      <div className="map-toolbar">
        <label className="switch map-global-toggle" title={t("mapping.globalWeightedTitle")}>
          <span className="map-global-label">{t("mapping.globalWeighted")}</span>
          <input
            type="checkbox"
            checked={globalWeighted}
            disabled={loading || settingsSaving}
            onChange={(event) => void handleGlobalWeightedChange(event.target.checked)}
            aria-label={t("mapping.globalWeighted")}
            aria-busy={settingsSaving}
          />
          <span className="track" aria-hidden="true">
            <span className="thumb" />
          </span>
        </label>
        <button className="btn primary" onClick={() => nav("/mapping/alias/new")}>
          + {t("mapping.newAlias")}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {loading ? (
        <div className="muted" style={{ padding: 20 }}>{t("keys.loading") || "Loading..."}</div>
      ) : aliases.length === 0 ? (
        <div className="muted" style={{ padding: 20 }}>No aliases</div>
      ) : (
        <div className="alias-grid">
          {aliases.map((a) => (
            <AliasCard key={a.alias} alias={a} onDelete={handleDelete} onEdit={(name) => nav(`/mapping/alias/${encodeURIComponent(name)}`)} />
          ))}
        </div>
      )}
    </>
  );
}

function AliasCard({ alias, onDelete, onEdit }: { alias: AliasMapping; onDelete: (n: string) => void; onEdit: (n: string) => void }) {
  const t = useT();
  const [refCount] = useState<number | null>(null);
  // refCount would come from a separate API call or be included in the list response.
  // For now, show "unreferenced" as placeholder.
  return (
    <div className="alias-card">
      <div className="alias-card-head">
        <span className="alias-card-name">{alias.alias}</span>
        <span className="alias-dispatch-badge">
          {alias.dispatch === "priority" ? t("mapping.alias.priority") : t("mapping.alias.roundRobin")}
        </span>
      </div>
      <div className="alias-targets">
        {alias.targets.slice(0, 3).map((tgt, i) => (
          <div key={i} className="alias-target-row">
            <span>{tgt.provider} · {tgt.target_model}</span>
            {tgt.group && <span className="alias-target-group">{tgt.group}</span>}
          </div>
        ))}
        {alias.targets.length > 3 && (
          <div className="alias-target-row" style={{ opacity: 0.6 }}>
            {t("mapping.moreTargets", { n: alias.targets.length - 3 })}
          </div>
        )}
      </div>
      <div className="alias-pricing">
        {alias.targets.map((t,i)=><div key={i}>{t.target_model}: <AutomaticPrice model={t.target_model} provider={t.provider} /></div>)}
      </div>
      <div className={"alias-refs" + (refCount === 0 ? " zero" : "")}>
        {refCount && refCount > 0 ? t("mapping.refs", { n: refCount }) : t("mapping.unreferenced")}
      </div>
      <div className="alias-actions">
        <button className="btn sm" onClick={() => onEdit(alias.alias)}>{t("mapping.edit")}</button>
        <button
          className="btn sm danger-outline"
          disabled={refCount !== null && refCount > 0}
          title={refCount && refCount > 0 ? t("mapping.deleteBlocked", { n: refCount }) : ""}
          onClick={() => onDelete(alias.alias)}
        >
          {t("mapping.delete")}
        </button>
      </div>
    </div>
  );
}

// --- Classify Tab ---

function ClassifyTab() {
  const t = useT();
  const nav = useNavigate();
  const [rules, setRules] = useState<ClassifyRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [previewData, setPreviewData] = useState<ClassifyPreviewResponse | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, descriptors] = await Promise.all([
        fetchClassifyRules(),
        fetchCredentialDescriptors().catch(() => [] as CredentialDescriptor[]),
      ]);
      setRules(list);
      // Evaluate the current rules against real credential descriptors so
      // each rule card shows the true match count + file list.
      const preview = await classifyPreview(descriptors).catch(() => null as ClassifyPreviewResponse | null);
      setPreviewData(preview);
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleReorder = async (names: string[]) => {
    try {
      await reorderClassifyRules(names);
      await load();
    } catch (e: unknown) {
      setError(String(e));
    }
  };

  const handleDelete = async (name: string) => {
    try {
      await deleteClassifyRule(name);
      await load();
    } catch (e: unknown) {
      setError(String(e));
    }
  };

  const moveRule = (idx: number, dir: -1 | 1) => {
    const newOrder = [...rules];
    const target = idx + dir;
    if (target < 0 || target >= newOrder.length) return;
    [newOrder[idx], newOrder[target]] = [newOrder[target], newOrder[idx]];
    void handleReorder(newOrder.map((r) => r.name));
  };

  return (
    <>
      <div className="map-toolbar">
        <button className="btn primary" onClick={() => nav("/mapping/rule/new")}>
          + {t("mapping.newRule")}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {loading ? (
        <div className="muted" style={{ padding: 20 }}>Loading...</div>
      ) : (
        <div className="rule-list">
          {/* Built-in rules (read-only) */}
          <div className="rule-builtin-card">
            <h3>{t("mapping.rule.builtin")} ({t("mapping.rule.builtinReadOnly")})</h3>
            <div className="rule-builtin-row">
              <span className="info-icon">ⓘ</span>
              plan_type → {`<detected>`}
            </div>
            <div className="rule-builtin-row">
              <span className="info-icon">ⓘ</span>
              tier → {`<detected>`}
            </div>
            <div className="rule-builtin-desc">{t("mapping.rule.builtinDesc")}</div>
          </div>

          {/* Custom rules */}
          <div className="section-label" style={{ marginTop: 16 }}>{t("mapping.rule.custom")}</div>
          {rules.length === 0 ? (
            <div className="muted" style={{ padding: 20 }}>No custom rules</div>
          ) : (
            rules.map((rule, idx) => (
              <RuleCard
                key={rule.name}
                rule={rule}
                idx={idx}
                total={rules.length}
                onMoveUp={() => moveRule(idx, -1)}
                onMoveDown={() => moveRule(idx, 1)}
                onEdit={() => nav(`/mapping/rule/${encodeURIComponent(rule.name)}`)}
                onDelete={() => handleDelete(rule.name)}
                previewData={previewData}
              />
            ))
          )}
        </div>
      )}
    </>
  );
}

function RuleCard({
  rule, idx, total, onMoveUp, onMoveDown, onEdit, onDelete, previewData,
}: {
  rule: ClassifyRule;
  idx: number;
  total: number;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onEdit: () => void;
  onDelete: () => void;
  previewData: ClassifyPreviewResponse | null;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [matchCount, setMatchCount] = useState<number | null>(null);
  const [matchedFiles, setMatchedFiles] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const pageSize = 50;

  // Compute the match count + matched file list up front from previewData
  // (fetched by ClassifyTab once the rules + descriptors load). The badge
  // shows the count even when collapsed, so this must not be gated on
  // `expanded`. Re-run whenever the preview or this rule's target group
  // changes; the matchedFiles list drives the expanded detail pagination.
  useEffect(() => {
    const files = previewData?.groups[rule.group.toLowerCase()] ?? [];
    setMatchCount(files.length);
    setMatchedFiles(files);
  }, [previewData, rule.group]);

  const pageCount = Math.ceil(matchedFiles.length / pageSize);
  const pageFiles = matchedFiles.slice(page * pageSize, (page + 1) * pageSize);

  return (
    <div className="rule-card">
      <div className="rule-card-head">
        <div className="rule-card-order">
          <button onClick={onMoveUp} disabled={idx === 0} title={t("mapping.rule.moveUp")}>↑</button>
          <button onClick={onMoveDown} disabled={idx === total - 1} title={t("mapping.rule.moveDown")}>↓</button>
        </div>
        <div className="rule-card-main" onClick={() => setExpanded(!expanded)} style={{ cursor: "pointer" }}>
          <div className="rule-card-name">{rule.name}</div>
          <div className="rule-card-sub">{rule.field}: {rule.pattern} → {rule.group}</div>
        </div>
        <div className="rule-card-right">
          <span className={"rule-match-badge" + (matchCount === 0 ? " zero" : "")}>
            {matchCount !== null
              ? (matchCount > 0 ? t("mapping.rule.matchCount", { n: matchCount }) : t("mapping.rule.matchCountZero"))
              : "..."}
          </span>
          <label className="switch" title={t("mapping.rule.enabled")}>
            <input type="checkbox" checked={rule.enabled} readOnly />
            <span className="track"><span className="thumb" /></span>
          </label>
          <button className="btn sm" onClick={onEdit}>{t("mapping.edit")}</button>
          <button className="btn sm danger-outline" onClick={onDelete}>{t("mapping.delete")}</button>
        </div>
      </div>
      {expanded && (
        <div className="rule-detail">
          <div className="rule-detail-files">
            {pageFiles.length === 0 ? (
              <div className="muted" style={{ padding: 8 }}>{t("mapping.rule.noFiles")}</div>
            ) : (
              pageFiles.map((f, i) => (
                <div key={i} className="rule-detail-file">
                  <span>{f}</span>
                </div>
              ))
            )}
          </div>
          {pageCount > 1 && (
            <div className="rule-pager">
              <button onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0}>
                {t("mapping.rule.prevPage")}
              </button>
              <span className="page-info">{t("mapping.rule.pageInfo", { cur: page + 1, total: pageCount })}</span>
              <button onClick={() => setPage(Math.min(pageCount - 1, page + 1))} disabled={page >= pageCount - 1}>
                {t("mapping.rule.nextPage")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- Alias Edit Form ---

// Survives ModelPick remounts (and React Strict Mode) better than router
// state alone — without this, filling the alias name then picking targets
// wipes the name when AliasEditForm remounts empty.
const ALIAS_FORM_DRAFT_KEY = "cpa-key-policy:alias-form-draft";

function readAliasFormDraft(): AliasMapping | null {
  try {
    const raw = sessionStorage.getItem(ALIAS_FORM_DRAFT_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as AliasMapping;
  } catch {
    return null;
  }
}

function writeAliasFormDraft(draft: AliasMapping) {
  try {
    sessionStorage.setItem(ALIAS_FORM_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    /* private mode / quota — router state is the fallback */
  }
}

function clearAliasFormDraft() {
  try {
    sessionStorage.removeItem(ALIAS_FORM_DRAFT_KEY);
  } catch {
    /* ignore */
  }
}

export function AliasEditForm() {
  const t = useT();
  const nav = useNavigate();
  const { aliasName } = useParams();
  const loc = useLocation();
  const isNew = aliasName === "new" || !aliasName;

  const locState = loc.state as { draftAlias?: AliasMapping; pickedTargets?: AliasTarget[] } | null;
  const returnDraft = locState?.draftAlias;
  const returnTargets = locState?.pickedTargets;

  const [alias, setAlias] = useState<AliasMapping>(() => {
    const draft = returnDraft ?? readAliasFormDraft();
    if (draft) {
      return {
        ...draft,
        targets: returnTargets ?? draft.targets ?? [],
      };
    }
    return {
      alias: isNew ? "" : decodeURIComponent(aliasName ?? ""),
      targets: [],
      dispatch: "round-robin",
      billing_mode: "tokens",
      input_price_per_million: 0,
      output_price_per_million: 0,
      cache_read_price_per_million: 0,
      per_call_usd: 0,
    };
  });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // Keep session draft in sync while editing so a picker trip never loses fields.
  useEffect(() => {
    writeAliasFormDraft(alias);
  }, [alias]);

  // Load existing alias if editing — skip when this form already has a draft
  // for the same alias (picker return / in-progress edit).
  useEffect(() => {
    if (isNew) return;
    if (returnDraft) return;
    const name = decodeURIComponent(aliasName ?? "");
    const session = readAliasFormDraft();
    if (session && session.alias === name) return;
    void fetchAliases().then((list) => {
      const found = list.find((a) => a.alias === name);
      if (found) setAlias(found);
    }).catch((e: unknown) => setError(String(e)));
  }, [aliasName, isNew, returnDraft]);

  // Apply targets returned from ModelPick (draft fields come from session/router).
  useEffect(() => {
    if (!returnTargets) return;
    setAlias((prev) => {
      const base = returnDraft ?? prev;
      return { ...base, targets: returnTargets };
    });
  }, [returnTargets, returnDraft]);

  const leaveForm = (toMapping = true) => {
    clearAliasFormDraft();
    if (toMapping) nav("/mapping", { state: { mappingTab: "alias" } });
  };

  const handleSave = async () => {
    setSaving(true);
    setError("");
    try {
      await upsertAlias(alias);
      leaveForm(true);
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const addTarget = () => {
    // Persist draft before leaving so name/dispatch/pricing survive the picker.
    writeAliasFormDraft(alias);
    const here = `/mapping/alias/${isNew ? "new" : encodeURIComponent(alias.alias || aliasName || "new")}`;
    nav("/mapping/pick-target", {
      state: {
        returnTo: here,
        currentTargets: alias.targets,
        draftAlias: alias,
      },
    });
  };

  const removeTarget = (idx: number) => {
    setAlias((prev) => ({ ...prev, targets: prev.targets.filter((_, i) => i !== idx) }));
  };

  return (
    <div className="map-form-page">
      <div className="map-form-card">
        <div className="map-form-head">
          <a className="back-link" onClick={() => leaveForm(true)}>
            ← {t("mapping.back")}
          </a>
          <h1>{isNew ? t("mapping.alias.newTitle") : t("mapping.alias.editTitle")}</h1>
        </div>
        <div className="map-form-row">
          <label>{t("mapping.alias.name")}</label>
          <input
            className="mono"
            value={alias.alias}
            onChange={(e) => setAlias({ ...alias, alias: e.target.value })}
            disabled={!isNew}
            placeholder="my-alias"
          />
        </div>
        <div className="map-form-row">
          <label>{t("mapping.alias.dispatch")}</label>
          <div className="map-dispatch-seg" role="group" aria-label={t("mapping.alias.dispatch")}>
            <button
              type="button"
              className={"map-dispatch-btn" + (alias.dispatch === "round-robin" ? " active" : "")}
              onClick={() => setAlias({ ...alias, dispatch: "round-robin" })}
            >
              <span className="map-dispatch-title">{t("mapping.alias.roundRobin")}</span>
              <span className="map-dispatch-desc">{t("mapping.alias.roundRobinDesc")}</span>
            </button>
            <button
              type="button"
              className={"map-dispatch-btn" + (alias.dispatch === "priority" ? " active" : "")}
              onClick={() => setAlias({ ...alias, dispatch: "priority" })}
            >
              <span className="map-dispatch-title">{t("mapping.alias.priority")}</span>
              <span className="map-dispatch-desc">{t("mapping.alias.priorityDesc")}</span>
            </button>
          </div>
        </div>
        <div className="map-form-row">
          <label>{t("mapping.alias.targets")}</label>
          <div className="map-form-targets">
            {alias.targets.map((tgt, i) => (
              <div key={i} className="map-form-target-row">
                <span className="mono">{tgt.provider} · {tgt.target_model} {tgt.group ? `· ${tgt.group}` : ""}</span>
                <button className="remove-btn" onClick={() => removeTarget(i)}>×</button>
              </div>
            ))}
          </div>
          <button className="btn" onClick={addTarget}>+ {t("mapping.alias.addTarget")}</button>
        </div>
        <div className="map-form-row">
          <label>Automatic LiteLLM prices</label>
          {alias.targets.map((t,i)=><div key={i}>{t.target_model}: <AutomaticPrice model={t.target_model} provider={t.provider} /></div>)}
        </div>
        {error && <div className="error">{error}</div>}
        <div className="map-form-foot">
          <button className="btn primary" onClick={handleSave} disabled={saving}>
            {saving ? "..." : t("mapping.save")}
          </button>
          <button className="btn" onClick={() => leaveForm(true)}>
            {t("mapping.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Rule Edit Form ---

export function RuleEditForm() {
  const t = useT();
  const nav = useNavigate();
  const { ruleName } = useParams();
  const isNew = ruleName === "new" || !ruleName;

  const [rule, setRule] = useState<ClassifyRule>({
    name: isNew ? "" : decodeURIComponent(ruleName),
    field: "plan_type",
    pattern: "",
    group: "",
    enabled: true,
  });
  const [customField, setCustomField] = useState("");
  const [regexError, setRegexError] = useState("");
  const [regexValid, setRegexValid] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // Load existing rule if editing.
  useEffect(() => {
    if (isNew) return;
    void fetchClassifyRules().then((list) => {
      const found = list.find((r) => r.name === decodeURIComponent(ruleName));
      if (found) {
        setRule(found);
        if (["filename", "provider", "plan_type", "tier"].includes(found.field)) {
          setCustomField("");
        } else {
          setCustomField(found.field);
          setRule((prev) => ({ ...prev, field: "custom" }));
        }
      }
    }).catch((e: unknown) => setError(String(e)));
  }, [ruleName, isNew]);

  // Live regex validation.
  useEffect(() => {
    if (!rule.pattern) {
      setRegexError("");
      setRegexValid(false);
      return;
    }
    try {
      new RegExp(rule.pattern);
      setRegexError("");
      setRegexValid(true);
    } catch (e: unknown) {
      setRegexError(String(e).replace(/^Error: /, ""));
      setRegexValid(false);
    }
  }, [rule.pattern]);

  const effectiveField = rule.field === "custom" ? customField : rule.field;

  const handleSave = async () => {
    if (!regexValid) {
      setError(t("mapping.rule.regexInvalid", { err: regexError }));
      return;
    }
    setSaving(true);
    setError("");
    try {
      await upsertClassifyRule({ ...rule, field: effectiveField });
      nav("/mapping", { state: { mappingTab: "classify" } });
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="map-form-page">
      <div className="map-form-card">
        <div className="map-form-head">
          <a className="back-link" onClick={() => nav("/mapping", { state: { mappingTab: "classify" } })}>
            ← {t("mapping.back")}
          </a>
          <h1>{isNew ? t("mapping.rule.newTitle") : t("mapping.rule.editTitle")}</h1>
        </div>
        <div className="map-form-row">
          <label>{t("mapping.rule.name")}</label>
          <input
            value={rule.name}
            onChange={(e) => setRule({ ...rule, name: e.target.value })}
            disabled={!isNew}
            placeholder="my-rule"
          />
        </div>
        <div className="map-form-row">
          <label>{t("mapping.rule.field")}</label>
          <select
            value={rule.field}
            onChange={(e) => setRule({ ...rule, field: e.target.value })}
          >
            <option value="filename">{t("mapping.rule.fieldFilename")}</option>
            <option value="provider">{t("mapping.rule.fieldProvider")}</option>
            <option value="plan_type">{t("mapping.rule.fieldPlanType")}</option>
            <option value="tier">{t("mapping.rule.fieldTier")}</option>
            <option value="custom">{t("mapping.rule.fieldCustom")}</option>
          </select>
        </div>
        {rule.field === "custom" && (
          <div className="map-form-row">
            <label>{t("mapping.rule.customField")}</label>
            <input
              className="mono"
              value={customField}
              onChange={(e) => setCustomField(e.target.value)}
              placeholder="custom_attribute_name"
            />
          </div>
        )}
        <div className="map-form-row">
          <label>{t("mapping.rule.regex")}</label>
          <input
            className="mono"
            value={rule.pattern}
            onChange={(e) => setRule({ ...rule, pattern: e.target.value })}
            placeholder="^team$"
          />
          {regexValid && <div className="regex-valid">✓ {t("mapping.rule.regexValid")}</div>}
          {regexError && <div className="regex-invalid">{t("mapping.rule.regexInvalid", { err: regexError })}</div>}
        </div>
        <div className="map-form-row">
          <label>{t("mapping.rule.group")}</label>
          <input
            className="mono"
            value={rule.group}
            onChange={(e) => setRule({ ...rule, group: e.target.value })}
            placeholder="team"
          />
        </div>
        <div className="map-form-row">
          <label className="switch" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={rule.enabled}
              onChange={(e) => setRule({ ...rule, enabled: e.target.checked })}
            />
            <span className="track"><span className="thumb" /></span>
            <span>{t("mapping.rule.enabled")}</span>
          </label>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="map-form-foot">
          <button className="btn primary" onClick={handleSave} disabled={saving || !regexValid}>
            {saving ? "..." : t("mapping.save")}
          </button>
          <button className="btn" onClick={() => nav("/mapping", { state: { mappingTab: "classify" } })}>
            {t("mapping.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
