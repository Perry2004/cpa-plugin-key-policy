import { useEffect, useState } from "react";
import { formatPrice, getPriceTable, lookupPrice, type PriceTable } from "../store/modelPrices";
export default function AutomaticPrice({model, provider}: {model: string; provider: string}) {
 const [table,setTable]=useState<PriceTable|null>(null);
 useEffect(()=>{let alive=true;void getPriceTable().then(t=>{if(alive)setTable(t)});return()=>{alive=false}},[]);
 const p=lookupPrice(table,model,provider);
 return <span>LiteLLM · Input {formatPrice(p?.input_price_per_million)} / Output {formatPrice(p?.output_price_per_million)} / Cache {formatPrice(p?.cache_read_price_per_million)} per 1M tokens</span>;
}
