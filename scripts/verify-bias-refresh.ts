/* 验证 refreshBias 在 BIAS_ENABLED=ON 时能否刷新 data/bias.json (2026-08-03)
 *
 * collect.yml 跑 scan:once -> scan.ts:544 refreshBias(loadAllMarkets()).
 * 本脚本复刻这一步, 不拉网络数据, 只用本地 data/markets 重算 bias 表并写回.
 * 验证点: 跑后 bias.json 的 updated_at 是否更新到当前时间 (证明写入链路通).
 *
 * 跑法 (PowerShell):
 *   $env:WEATHERBOT_BIAS_ENABLED="true"; npx tsx scripts/verify-bias-refresh.ts
 */
import { readFileSync } from "fs";
import { refreshBias, biasFilePath } from "../src/bias.js";
import { loadAllMarkets } from "../src/storage.js";

function latestTs(table: Record<string, { updated_at: string }>): string {
  const vals = Object.values(table);
  if (vals.length === 0) return "(empty)";
  const ts = Math.max(...vals.map((e) => new Date(e.updated_at).getTime()));
  return new Date(ts).toISOString();
}

const before = JSON.parse(readFileSync(biasFilePath(), "utf-8")) as Record<
  string,
  { bias: number; n: number; updated_at: string }
>;
console.log("===== refreshBias 刷新验证 =====");
console.log(`BIAS_ENABLED = ${process.env.WEATHERBOT_BIAS_ENABLED ?? "(unset)"}`);
console.log(`before: entries=${Object.keys(before).length} | latest updated_at=${latestTs(before)}`);

const table = refreshBias(loadAllMarkets());

const after = JSON.parse(readFileSync(biasFilePath(), "utf-8")) as Record<
  string,
  { bias: number; n: number; updated_at: string }
>;
console.log(`after:  entries=${Object.keys(after).length} | latest updated_at=${latestTs(after)}`);
console.log(`in-memory table entries=${Object.keys(table).length}`);
console.log(`刷新成功: ${latestTs(after) !== latestTs(before) ? "YES ✓" : "NO ✗"}`);

// 几个关键城市 before/after 对比 (直观看过时值 vs 当前值)
console.log(`\n===== 关键城市 bias before -> after =====`);
const sampleKeys = [
  "atlanta|D+0|best",
  "miami|D+0|ecmwf",
  "nyc|D+0|best",
  "tokyo|D+0|best",
  "dallas|D+0|ecmwf",
  "london|D+0|best",
];
for (const k of sampleKeys) {
  const b = before[k];
  const a = after[k];
  const bf = b ? `bias=${String(b.bias).padStart(7)} n=${String(b.n).padStart(2)}` : "(none)   ";
  const af = a ? `bias=${String(a.bias).padStart(7)} n=${String(a.n).padStart(2)}` : "(none)";
  console.log(`  ${k.padEnd(20)} ${bf}  ->  ${af}`);
}
