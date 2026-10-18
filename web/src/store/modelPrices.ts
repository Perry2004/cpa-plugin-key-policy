import { getSession } from "./session";
import { apiClient, pluginPath } from "../api/client";

export interface PriceRow {
  input_price_per_million: number | null;
  output_price_per_million: number | null;
  cache_read_price_per_million: number | null;
}
export type PriceTable = Map<string, PriceRow>;
const perMillion = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v * 1_000_000 : null;
export function parseLiteLLM(raw: Record<string, unknown>): PriceTable {
  const table: PriceTable = new Map();
  for (const [key, value] of Object.entries(raw)) {
    if (key === "sample_spec" || !value || typeof value !== "object") continue;
    const e = value as Record<string, unknown>;
    table.set(key.toLowerCase(), {
      input_price_per_million: perMillion(e.input_cost_per_token),
      output_price_per_million: perMillion(e.output_cost_per_token),
      cache_read_price_per_million: perMillion(e.cache_read_input_token_cost),
    });
  }
  return table;
}
let cached: { session: ReturnType<typeof getSession>; expires: number; request: Promise<PriceTable | null> } | null = null;
export function getPriceTable(): Promise<PriceTable | null> {
 const session=getSession();
 if(cached && cached.session===session && Date.now()<cached.expires) return cached.request;
 const request=(async()=>{
  try { const {data}=await apiClient().get(pluginPath("/prices"));return parseLiteLLM(data.models ?? {}); }
  catch { cached=null;return null; }
 })();
 cached={session,expires:Date.now()+60_000,request};
 return request;
}
export function lookupPrice(table: PriceTable | null, model: string, provider = ""): PriceRow | null {
  model = model.trim().toLowerCase(); provider = provider.trim().toLowerCase();
  if (provider === "codex") provider = "openai";
  if (provider === "claude") provider = "anthropic";
  return table?.get(provider + "/" + model) ?? table?.get(model) ?? null;
}
export const formatPrice = (price: number | null | undefined): string =>
  price == null ? "Unknown" : "$" + price.toLocaleString("en-US", { maximumFractionDigits: 6 });
