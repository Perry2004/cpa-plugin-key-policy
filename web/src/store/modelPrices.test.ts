import { describe, it, expect, vi } from "vitest";
import { parseLiteLLM, lookupPrice, formatPrice, getPriceTable } from "./modelPrices";
const get = vi.hoisted(() => vi.fn());
vi.mock("../api/client",()=>({apiClient:()=>({get}),pluginPath:(p:string)=>p}));
describe("automatic server prices",()=>{
 it("keeps missing prices distinct from free models",()=>{
  const table=parseLiteLLM({free:{input_cost_per_token:0,output_cost_per_token:0},m:{input_cost_per_token:.000002,output_cost_per_token:.00001}});
  expect(formatPrice(lookupPrice(table,"free")?.input_price_per_million)).toBe("$0");
  expect(formatPrice(lookupPrice(table,"m")?.input_price_per_million)).toBe("$2");
  expect(formatPrice(lookupPrice(table,"m")?.cache_read_price_per_million)).toBe("Unknown");
  expect(formatPrice(lookupPrice(table,"absent")?.output_price_per_million)).toBe("Unknown");
 });
 it("matches providers deterministically without guessing model aliases",()=>{
  const table=parseLiteLLM({m:{input_cost_per_token:1},"openai/m":{input_cost_per_token:2}});
  expect(lookupPrice(table,"M","codex")?.input_price_per_million).toBe(2000000);
  expect(lookupPrice(table,"m-new","codex")).toBeNull();
 });
 it("uses the server catalog and handles unavailability",async()=>{
  get.mockResolvedValueOnce({data:{models:{m:{input_cost_per_token:.000001}}}});
  expect(lookupPrice(await getPriceTable(),"m")?.input_price_per_million).toBe(1);
  expect(get).toHaveBeenCalledWith("/prices");
  vi.spyOn(Date,"now").mockReturnValue(Date.now()+61_000);
  get.mockRejectedValueOnce(new Error("offline"));expect(await getPriceTable()).toBeNull();vi.restoreAllMocks();
 });
});
