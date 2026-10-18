import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { KeyPublic, ModelRule, AliasMapping } from "../types";
import ModelPicker from "./ModelPicker";
import { getPriceTable, lookupPrice, formatPrice, type PriceTable } from "../store/modelPrices";
import { fetchAliases } from "../api/mappings";
import { formatTierLabel } from "../api/models";
import { useT } from "../i18n";

export interface KeyFormValues {
  id: string;
  name: string;
  enabled: boolean;
  rpm: number;
  models: ModelRule[];
  daily_limit_usd: number;
  weekly_limit_usd: number;
  // Per-key override for GET /v1/models. CPA cannot filter the model list per
  // downstream key, so the only plugin-enforceable choice is binary: 401 (hide
  // the list) or allow (client sees the full global list). Default false.
  allow_models_endpoint?: boolean;
}

interface Props {
  initial?: KeyPublic;
  idReadOnly?: boolean;
  submitLabel: string;
  onSubmit: (v: KeyFormValues) => Promise<void>;
  onCancel: () => void;
  // top-level error to render
  error?: string;
  // route path for the standalone model-picker page (e.g. "/keys/new/models").
  // When set, the desktop form renders a chip box + "add model" button that
  // navigates here with the current models as router state. The picker page
  // navigates back with state.pickedModels, which the parent merges into
  // `initial` before re-rendering this form.
  pickPath?: string;
  // extra-danger button config for the footer (edit mode). When provided,
  // renders a danger-outline button on the far right of the footer.
  dangerLabel?: string;
  onDanger?: () => void;
}

function priceKey(m: { alias: string; group?: string }): string {
  const g = (m.group ?? "").toLowerCase();
  return (g ? g + "|" : "") + m.alias.toLowerCase();
}

function parseNum(value: string): number {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

export default function KeyForm({
  initial,
  idReadOnly,
  submitLabel,
  onSubmit,
  onCancel,
  error,
  pickPath,
  dangerLabel,
  onDanger,
}: Props) {
  const nav = useNavigate();
  const [id, setId] = useState(initial?.id ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [rpm, setRpm] = useState(initial?.rpm ?? 0);
  const [dailyLimit, setDailyLimit] = useState(initial?.daily_limit_usd ?? 0);
  const [weeklyLimit, setWeeklyLimit] = useState(initial?.weekly_limit_usd ?? 0);
  const [allowModels, setAllowModels] = useState<boolean>(initial?.allow_models_endpoint ?? false);
  const t = useT();

  const [models, setModels] = useState<ModelRule[]>(initial?.models ?? []);
  const [busy, setBusy] = useState(false);
  const [localErr, setLocalErr] = useState("");
  const [expandedPrice, setExpandedPrice] = useState<Record<string, boolean>>({});

  // Global alias table (fetched once on mount). Used by the "已有别名" section
  // so the user can quickly include an alias's targets instead of picking
  // each provider+model+group individually from the catalog. Clicking a
  // global alias adds ALL its targets as ModelRules (so round-robin can rotate
  // across them); the backend ups-server dedups by alias+provider+target_model
  // so it reuses the existing global alias instead of creating a duplicate.
  const [globalAliases, setGlobalAliases] = useState<AliasMapping[]>([]);
  useEffect(() => {
    let alive = true;
    void fetchAliases().then((list) => { if (alive) setGlobalAliases(list); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // aliasSelected reports whether every target of `a` is already in `models`
  // (i.e. the alias is fully included).
  const aliasSelected = useCallback((a: AliasMapping) => {
    return a.targets.every((tgt) =>
      models.some((m) =>
        m.alias.toLowerCase() === a.alias.toLowerCase() &&
        m.provider.toLowerCase() === tgt.provider.toLowerCase() &&
        m.target_model.toLowerCase() === tgt.target_model.toLowerCase() &&
        (m.group ?? "").toLowerCase() === (tgt.group ?? "").toLowerCase(),
      ),
    );
  }, [models]);

  // toggleAlias either adds all of an alias's targets (as ModelRules, with the
  // alias's pricing stamped in) or removes all of them.
  const toggleAlias = useCallback((a: AliasMapping) => {
    if (aliasSelected(a)) {
      // Remove all targets of this alias.
      setModels((prev) => prev.filter((m) =>
        !(m.alias.toLowerCase() === a.alias.toLowerCase()),
      ));
    } else {
      // Add all targets.
      const newRules: ModelRule[] = a.targets.map((tgt) => ({
        alias: a.alias,
        provider: tgt.provider,
        target_model: tgt.target_model,
        group: tgt.group ?? "",
        billing_mode: a.billing_mode === "per_call" ? "per_call" : "tokens",
        input_price_per_million: a.input_price_per_million ?? 0,
        output_price_per_million: a.output_price_per_million ?? 0,
        cache_read_price_per_million: a.cache_read_price_per_million ?? 0,
        per_call_usd: a.per_call_usd ?? 0,
      }));
      setModels((prev) => {
        // Drop any partial entries for this alias first, then append all targets.
        const filtered = prev.filter((m) => m.alias.toLowerCase() !== a.alias.toLowerCase());
        return [...filtered, ...newRules];
      });
    }
  }, [aliasSelected]);

  // The server owns automatic pricing.
  const [priceTable, setPriceTable] = useState<PriceTable | null>(null);
  useEffect(() => {
    let alive = true;
    void getPriceTable().then((t) => {
      if (alive) setPriceTable(t);
    });
    return () => {
      alive = false;
    };
  }, []);

  const handleModelsChange = useCallback((next: ModelRule[]) => setModels(next), []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalErr("");
    if (!id.trim()) {
      setLocalErr(t("keyForm.idRequired"));
      return;
    }
    setBusy(true);
    try {
      await onSubmit({
        id: id.trim(),
        name: name.trim(),
        enabled,
        rpm,
        models,
        daily_limit_usd: dailyLimit,
        weekly_limit_usd: weeklyLimit,
        allow_models_endpoint: allowModels,
      });
    } catch (err) {
      const e = err as { response?: { data?: { error?: { message?: string } } }; message?: string };
      setLocalErr(e.response?.data?.error?.message ?? e.message ?? t("keyForm.submitFailed"));
    } finally {
      setBusy(false);
    }
  };

  const toggleExpanded = (key: string) => {
    setExpandedPrice((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const renderPriceEditor = (m: ModelRule, layout: "table" | "mobile") => {
    const row = lookupPrice(priceTable, m.target_model, m.provider);
    const values = [row?.input_price_per_million, row?.output_price_per_million, row?.cache_read_price_per_million];
    if (layout === "mobile") return <div className="kf-mprice-body">
      {["keyForm.colInput", "keyForm.colOutput", "keyForm.colCacheRead"].map((label,i)=><div className="form-row" key={label}><label>{t(label)}</label><span>{formatPrice(values[i])}</span></div>)}
      <span className="muted">LiteLLM · Automatic</span>
    </div>;
    return <tr key={priceKey(m)+m.provider+m.target_model}>
      <td className="mono">{m.alias}<div className="muted">{m.target_model}</div></td>
      <td>{m.provider}</td><td>{m.group ? formatTierLabel(t,m.group) : "—"}</td>
      {values.map((v,i)=><td key={i}>{formatPrice(v)}</td>)}
      <td>LiteLLM</td>
    </tr>;
  };

  const section = (title: string, children: ReactNode) => (
    <section className="kf-section mobile-only">
      <div className="section-label">{title}</div>
      <div className="kf-section-card">{children}</div>
    </section>
  );

  return (
    <form className="card key-form" onSubmit={submit}>
      <div className="mobile-only kf-sections">
        {section(t("keyForm.mobile.sectionBasic"), (
          <>
            <div className="form-row">
              <label>{t("keyForm.idLabel")}</label>
              <input
                className={"input" + (idReadOnly ? " mono" : "")}
                value={id}
                onChange={(e) => setId(e.target.value)}
                readOnly={idReadOnly}
                placeholder={t("keyForm.idPlaceholder")}
                autoFocus={!idReadOnly}
              />
            </div>
            <div className="form-row">
              <label>{t("keyForm.nameLabel")}</label>
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("keyForm.namePlaceholder")}
              />
            </div>
            <div className="form-row kf-switch-row">
              <label className="switch">
                <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
                <span className="track"><span className="thumb" /></span>
                <span>{t("keyForm.enableKey")}</span>
              </label>
            </div>
            <div className="form-row">
              <label>{t("keyForm.rpmLabel")}</label>
              <input
                className="input"
                type="number"
                min={0}
                value={rpm}
                onChange={(e) => setRpm(parseInt(e.target.value || "0", 10) || 0)}
              />
            </div>
          </>
        ))}
        {section(t("keyForm.mobile.sectionLimits"), (
          <>
            <div className="form-row">
              <label>{t("keyForm.dailyLimitLabel")}</label>
              <input
                className="input"
                type="number"
                min={0}
                step="0.01"
                value={dailyLimit}
                onChange={(e) => setDailyLimit(parseNum(e.target.value))}
              />
            </div>
            <div className="form-row">
              <label>{t("keyForm.weeklyLimitLabel")}</label>
              <input
                className="input"
                type="number"
                min={0}
                step="0.01"
                value={weeklyLimit}
                onChange={(e) => setWeeklyLimit(parseNum(e.target.value))}
              />
            </div>
          </>
        ))}
        {section(t("keyForm.mobile.sectionAccess"), (
          <>
            <label className="switch kf-access-switch" title={t("keyForm.allowModelsTitle")}>
              <input type="checkbox" checked={allowModels} onChange={(e) => setAllowModels(e.target.checked)} />
              <span className="track"><span className="thumb" /></span>
              <span>{t("keyForm.allowModelsLabel")}</span>
            </label>
            <p className="muted kf-hint">{t("keyForm.allowModelsHint")}</p>
          </>
        ))}
        <section className="kf-section mobile-only">
          <div className="section-label">{t("keyForm.mobile.sectionModels")}</div>
          {globalAliases.length > 0 && (
            <div className="form-row kf-alias-pick" style={{ marginBottom: 12 }}>
              <div className="kf-alias-chips">
                {globalAliases.map((a) => {
                  const on = aliasSelected(a);
                  return (
                  <button key={a.alias} type="button" className={"kf-alias-chip" + (on ? " selected" : "")} onClick={() => toggleAlias(a)}>
                    {a.alias}{a.targets.length > 1 ? ` (${a.targets.length})` : ""}
                  </button>
                  );
                })}
              </div>
            </div>
          )}
          <div className="form-row" style={{ marginBottom: 12 }}>
            {pickPath ? (
              <div className="model-chips-box">
                {models.length === 0 && <span className="mc-empty">{t("keyForm.modelsEmpty")}</span>}
                {models.map((m) => (
                  <span key={priceKey(m)} className="mc-chip">
                    {m.alias}{m.group ? " · " + formatTierLabel(t, m.group) : ""}
                    <button type="button" className="mc-x" onClick={() => {
                      setModels((prev) => prev.filter((x) => priceKey(x) !== priceKey(m)));
                    }} aria-label={t("keyForm.removeModel")}>×</button>
                  </span>
                ))}
                <button type="button" className="mc-add" onClick={() => nav(pickPath, { state: { models } })}>
                  + {t("keyForm.addModel")}
                </button>
              </div>
            ) : (
              <ModelPicker initial={initial?.models} onChange={handleModelsChange} />
            )}
          </div>
          {models.length > 0 && (
            <div className="kf-model-list">
              {models.map((m) => {
                const key = priceKey(m);

                const open = !!expandedPrice[key];
                return (
                  <div key={key} className="kf-model-card">
                    <button
                      type="button"
                      className="kf-model-head"
                      onClick={() => toggleExpanded(key)}
                      aria-expanded={open}
                    >
                      <div>
                        <div className="kf-model-alias">{m.alias}</div>
                        <div className="muted kf-model-meta">
                          {m.provider}{m.group ? ` · ${formatTierLabel(t, m.group)}` : ""}
                        </div>
                        <div className="mono kf-model-target">{m.target_model}</div>
                      </div>
                      <span className="mm-badge">
                        LiteLLM
                      </span>
                      <span className="kf-chevron">{open ? "▾" : "▸"}</span>
                    </button>
                    {open && renderPriceEditor(m, "mobile")}
                  </div>
                );
              })}
            </div>
          )}
          <p className="muted kf-hint" style={{ marginTop: 8 }}>{t("keyForm.priceLabel")}</p>
        </section>
      </div>

      <div className="mobile-hidden">
      <div className="row2">
        <div className="form-row">
          <label>{t("keyForm.idLabel")}</label>
          <input
            className="input"
            value={id}
            onChange={(e) => setId(e.target.value)}
            readOnly={idReadOnly}
            placeholder={t("keyForm.idPlaceholder")}
            autoFocus={!idReadOnly}
          />
        </div>
        <div className="form-row">
          <label>{t("keyForm.nameLabel")}</label>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("keyForm.namePlaceholder")}
          />
        </div>
      </div>
      <div className="row2">
        <div className="form-row">
          <label>{t("keyForm.rpmLabel")}</label>
          <input
            className="input"
            type="number"
            min={0}
            value={rpm}
            onChange={(e) => setRpm(parseInt(e.target.value || "0", 10) || 0)}
          />
        </div>
        <div className="form-row">
          <label>{t("keyForm.statusLabel")}</label>
          <label className="switch">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            <span className="track"><span className="thumb" /></span>
            <span>{t("keyForm.enableKey")}</span>
          </label>
        </div>
      </div>

      <div className="row2">
        <div className="form-row">
          <label>{t("keyForm.dailyLimitLabel")}</label>
          <input
            className="input"
            type="number"
            min={0}
            step="0.01"
            value={dailyLimit}
            onChange={(e) => setDailyLimit(parseNum(e.target.value))}
          />
        </div>
        <div className="form-row">
          <label>{t("keyForm.weeklyLimitLabel")}</label>
          <input
            className="input"
            type="number"
            min={0}
            step="0.01"
            value={weeklyLimit}
            onChange={(e) => setWeeklyLimit(parseNum(e.target.value))}
          />
        </div>
      </div>

      <div className="form-row">
        <label className="switch" title={t("keyForm.allowModelsTitle")}>
          <input
            type="checkbox"
            checked={allowModels}
            onChange={(e) => setAllowModels(e.target.checked)}
          />
          <span className="track"><span className="thumb" /></span>
          <span>{t("keyForm.allowModelsLabel")}</span>
        </label>
        <span className="muted" style={{ fontSize: "0.85em", marginLeft: 8 }}>
          {t("keyForm.allowModelsHint")}
        </span>
      </div>

      {globalAliases.length > 0 && (
        <div className="form-row kf-alias-pick">
          <label>{t("keyForm.existingAliases")}</label>
          <div className="kf-alias-chips">
            {globalAliases.map((a) => {
              const on = aliasSelected(a);
              return (
              <button
                key={a.alias}
                type="button"
                className={"kf-alias-chip" + (on ? " selected" : "")}
                onClick={() => toggleAlias(a)}
                title={a.targets.map((t) => `${t.provider}·${t.target_model}${t.group ? `·${t.group}` : ""}`).join("\n")}
              >
                {a.alias}{a.targets.length > 1 ? ` (${a.targets.length})` : ""}
              </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="form-row">
        <label>{t("keyForm.modelsLabel")}</label>
        {pickPath ? (
          <div className="model-chips-box">
            {models.length === 0 && <span className="mc-empty">{t("keyForm.modelsEmpty")}</span>}
            {models.map((m) => (
              <span key={priceKey(m)} className="mc-chip">
                {m.alias}{m.group ? " · " + m.group : ""}
                <button type="button" className="mc-x" onClick={() => {
                  setModels((prev) => prev.filter((x) => priceKey(x) !== priceKey(m)));
                }} aria-label={t("keyForm.removeModel")}>×</button>
              </span>
            ))}
            <button type="button" className="mc-add" onClick={() => nav(pickPath, { state: { models } })}>
              + {t("keyForm.addModel")}
            </button>
          </div>
        ) : (
          <ModelPicker initial={initial?.models} onChange={handleModelsChange} />
        )}
      </div>

      {/* Automatic prices for each upstream target. */}
      {models.length > 0 && (
        <div className="form-row" style={{ marginTop: 8 }}>
          <label>{t("keyForm.priceLabel")}</label>
          <div className="card table-wrap" style={{ padding: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>{t("keyForm.colAlias")}</th>
                  <th>{t("keyForm.colProvider")}</th>
                  <th>{t("keyForm.colGroup")}</th>
                  <th>{t("keyForm.colInput")}</th>
                  <th>{t("keyForm.colOutput")}</th>
                  <th title={t("keyForm.colCacheReadHint")}>{t("keyForm.colCacheRead")}</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {models.map((m) => renderPriceEditor(m, "table"))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      </div>

      {(localErr || error) && <div className="error">{localErr || error}</div>}

      <div className="actions fp-foot">
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? t("keyForm.submitting") : submitLabel}
        </button>
        <button className="btn" type="button" onClick={onCancel}>{t("keyForm.cancel")}</button>
        {dangerLabel && onDanger && (
          <span className="fp-foot-right">
            <button type="button" className="btn danger-outline" onClick={onDanger}>{dangerLabel}</button>
          </span>
        )}
      </div>
    </form>
  );
}
