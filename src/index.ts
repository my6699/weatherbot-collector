import { exportAllToExcel } from "./export-excel.js";
import { loadCal } from "./storage.js";
import { printReport, printStatus } from "./report.js";
import { monitorPositions, runLoop, scanAndUpdate } from "./scan.js";

const cmd = process.argv[2] ?? "run";

if (cmd === "run") {
  await runLoop();
} else if (cmd === "once") {
  // 单次搜集模式：跑一轮全量扫描 + 持仓监控 + Excel 导出后退出。
  // 供 GitHub Actions 定时任务调用（每 60 分钟一次 job，数据 commit 回仓库）。
  loadCal();
  const nowStr = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${nowStr}] one-shot collect...`);
  try {
    await scanAndUpdate();
    await monitorPositions();
    const xlsPath = exportAllToExcel();
    console.log(`  Excel: ${xlsPath}`);
  } catch (e) {
    console.error(`  Collect failed: ${e}`);
    process.exit(1);
  }
  console.log("  Done.");
  process.exit(0);
} else if (cmd === "status") {
  loadCal();
  printStatus();
} else if (cmd === "report") {
  loadCal();
  printReport();
} else {
  console.log("Usage: node dist/index.js [run|once|status|report]");
  console.log("   or: npm start -- [run|once|status|report]");
  console.log("   or: npm run dev -- [run|once|status|report]");
  process.exit(1);
}
