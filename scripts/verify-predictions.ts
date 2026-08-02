import { readdirSync, readFileSync } from "fs";
import path from "path";
import { inBucket } from "../src/math.js";

interface Snap {
  ts?: string;
  horizon?: string;
  best?: number | null;
}
interface Pos {
  bucket_low: number;
  bucket_high: number;
  status?: string;
  pnl?: number | null;
  entry_price?: number;
  forecast_temp?: number | null;
  strategy?: string;
}
interface Mkt {
  city: string;
  city_name: string;
  date: string;
  unit: "F" | "C";
  station: string;
  status?: string;
  actual_temp?: number | null;
  position?: Pos | null;
  positions?: Pos[];
  pnl?: number | null;
  forecast_snapshots?: Snap[];
}

const dir = path.join(process.cwd(), "data", "markets");
const met = JSON.parse(
  readFileSync(path.join(process.cwd(), "data", "metar_max.json"), "utf-8"),
) as Record<string, Record<string, number>>;

const mkts: Mkt[] = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf-8")) as Mkt)
  .filter((m) => m.status === "resolved");

function trueMax(m: Mkt): number | null {
  const c = met[m.station]?.[m.date];
  if (c == null) return null;
  return m.unit === "F" ? (c * 9) / 5 + 32 : c;
}

// ---- 1. Forecast error vs TRUE station max, by horizon ----
const byH = new Map<string, { n: number; mae: number; mbe: number }>();
for (const m of mkts) {
  const t = trueMax(m);
  if (t == null) continue;
  for (const s of m.forecast_snapshots ?? []) {
    if (s.best == null) continue;
    const h = s.horizon ?? "D+0";
    const e = s.best - t; // signed error (forecast - actual)
    const st = byH.get(h) ?? { n: 0, mae: 0, mbe: 0 };
    st.n += 1;
    st.mbe += e;
    st.mae += Math.abs(e);
    byH.set(h, st);
  }
}
console.log("=== 1. 预报 vs 真实结算值（当地日 METAR 日最高）===");
console.log("时距 | 样本 | 平均绝对误差(MAE) | 平均偏差(MBE, +为预报偏高)");
for (const [h, st] of [...byH.entries()].sort()) {
  console.log(
    `  ${h}  | ${st.n} | ${(st.mae / st.n).toFixed(2)}° | ${(st.mbe / st.n >= 0 ? "+" : "")}${(st.mbe / st.n).toFixed(2)}°`,
  );
}

// ---- 2. Closed positions: true hit rate ----
const closed = mkts.filter((m) => m.position && m.position.status === "closed");
let hit = 0, miss = 0, pnlSum = 0, hitPnl = 0, missPnl = 0;
const detail: string[] = [];
for (const m of closed) {
  const t = trueMax(m);
  const p = m.position!;
  const isHit = t != null && inBucket(t, p.bucket_low, p.bucket_high);
  const pnl = p.pnl ?? 0;
  pnlSum += pnl;
  if (isHit) { hit++; hitPnl += pnl; } else { miss++; missPnl += pnl; }
  const tooHigh = t != null ? (p.forecast_temp != null ? p.forecast_temp > t + 1 : null) : null;
  const tooLow = t != null ? (p.forecast_temp != null ? p.forecast_temp < t - 1 : null) : null;
  detail.push(
    `${m.city_name} ${m.date} ${p.bucket_low}-${p.bucket_high}${m.unit} | 预报${p.forecast_temp ?? "?"}° 实际${t != null ? Math.round(t * 10) / 10 : "?"}° | ${isHit ? "命中" : "未中"}${tooHigh ? "(预报偏高)" : tooLow ? "(预报偏低)" : ""} | PnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`,
  );
}
console.log(`\n=== 2. 已结算下注真实命中率（共 ${closed.length} 笔）===\n命中 ${hit} 笔 (PnL ${hitPnl >= 0 ? "+" : ""}${hitPnl.toFixed(2)}) | 未中 ${miss} 笔 (PnL ${missPnl.toFixed(2)}) | 总 PnL ${pnlSum >= 0 ? "+" : ""}${pnlSum.toFixed(2)}`);
console.log("\n明细：");
for (const d of detail) console.log(`  ${d}`);
