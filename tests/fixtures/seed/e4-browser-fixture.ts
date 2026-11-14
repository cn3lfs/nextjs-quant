// Repeatable manual review input. Writes only the explicitly isolated directory.
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
const directory = resolve(".test-data/e4-browser");
if (resolve(process.env.QUANT_DATA_DIR ?? "") !== directory)
  throw new Error("Use isolated .test-data/e4-browser");
await mkdir(directory, { recursive: true });
await writeFile(
  join(directory, "CLS-test.md"),
  "# 财联社合成验收报告\n**分析日期**：2026-09-11\n### 电子（方向：偏多 ｜ 信心：高）\n**推荐标的**：sh600000\n测试事实：订单同比增长。这是合成验收数据，不代表真实市场。\n",
  "utf8",
);
