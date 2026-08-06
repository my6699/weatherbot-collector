/**
 * 数据探测: 已结算市场 / 快照 hours_left 分布 / 真实 ENS members 可用性
 * Run: npx tsx scripts/probe-data.ts
 */
import { readdirSync, readFileSync } from "fs";
import path from "path";

const DIR = path.join(process.cwd(), "data", "markets");

interface ForecastSnap {
  ts?: string;
  hours_left?: number;
  ens?: { membersMax?: number[] | null } | null;
}

interface Mkt {
  city_name: string;
  date: string;
  status: string;
  actual_temp: number | null;
  forecast_snapshots?: ForecastSnap[];
}

const markets = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => {
    try {
      return JSON.parse(readFileSync(path.join(DIR, f), "utf8")) as Mkt;
    } catch {
      return null;
    }
  })
  .filter((m): m is Mkt => m != null);

const resolved = markets.filter((m) => m.actual_temp != null);
console.log(`总市场: ${markets.length}, 已结算: ${resolved.length}`);

// hours_left 分布
const allHours: number[] = [];
let withMembers = 0;
let membersSnaps = 0;
for (const m of markets) {
  for (const s of m.forecast_snapshots ?? []) {
    if (s.hours_left != null) allHours.push(s.hours_left);
    if (s.ens?.membersMax && s.ens.membersMax.length > 0) membersSnaps++;
  }
  if ((m.forecast_snapshots ?? []).some((s) => s.ens?.membersMax && s.ens.membersMax.length > 0)) {
    withMembers++;
  }
}
allHours.sort((a, b) => a - b);
if (allHours.length) {
  const p = (q: number) => allHours[Math.floor(allHours.length * q)]!;
  console.log(`快照数: ${allHours.length}, hours_left: min=${allHours[0]!.toFixed(0)} p25=${p(0.25).toFixed(0)} med=${p(0.5).toFixed(0)} p75=${p(0.75).toFixed(0)} max=${allHours[allHours.length - 1]!.toFixed(0)}`);
  console.log(`  >=72h (D-3): ${allHours.filter((h) => h >= 72).length}`);
  console.log(`  >=60h: ${allHours.filter((h) => h >= 60).length}`);
  console.log(`  48-56h (D-2): ${allHours.filter((h) => h >= 48 && h <= 56).length}`);
  console.log(`  24-48h: ${allHours.filter((h) => h >= 24 && h < 48).length}`);
  console.log(`  <24h: ${allHours.filter((h) => h < 24).length}`);
}

// 已结算市场里: 有没有 membersMax + 足够早的快照
const resWithEarly = resolved.filter((m) =>
  (m.forecast_snapshots ?? []).some((s) => (s.hours_left ?? 0) >= 60),
);
const resWithMembers = resolved.filter((m) =>
  (m.forecast_snapshots ?? []).some((s) => s.ens?.membersMax && s.ens.membersMax.length > 0),
);
const resWithBoth = resolved.filter(
  (m) =>
    (m.forecast_snapshots ?? []).some((s) => (s.hours_left ?? 0) >= 60) &&
    (m.forecast_snapshots ?? []).some((s) => s.ens?.membersMax && s.ens.membersMax.length > 0),
);

console.log(`\n已结算 + 有>=60h快照: ${resWithEarly.length}`);
console.log(`已结算 + 有真实members: ${resWithMembers.length}`);
console.log(`已结算 + 两者都有: ${resWithBoth.length}`);
console.log(`\n有members快照的市场(含未结算): ${withMembers}, 快照数: ${membersSnaps}`);

// 列出两者都有的市场
if (resWithBoth.length) {
  console.log("\n明细:");
  for (const m of resWithBoth) {
    const early = (m.forecast_snapshots ?? [])
      .filter((s) => (s.hours_left ?? 0) >= 60)
      .map((s) => s.hours_left)
      .sort((a, b) => a! - b!);
    console.log(`  ${m.city_name} ${m.date} | actual ${m.actual_temp} | early hours: ${early.join(",")}`);
  }
}
