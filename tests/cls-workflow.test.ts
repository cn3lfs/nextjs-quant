import { expect, it } from "vitest";
import {
  incrementalClsNews,
  validateClsClassification,
} from "../src/server/cls-news-workflow";
import { clsBatchReceiptSchema } from "../src/lib/cls-batch";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { previewClsReport } from "../src/server/cls-report-files";
import { parseClsReport } from "../src/server/cls-report-parser";
it("deduplicates by evidence ID and excludes records beyond the input cutoff", () => {
  const row = { id: 1, ctime: 100, title: "新闻", content: "内容" };
  expect(
    incrementalClsNews(
      [row, row, { ...row, id: 2 }, { ...row, id: 3, ctime: 300 }],
      ["1"],
      200000,
    ).map((r) => r.id),
  ).toEqual([2]);
  expect(() =>
    validateClsClassification(
      { industries: { 电子: [{ id: 2 }, { id: 999 }] } },
      ["2"],
    ),
  ).toThrow();
  expect(() =>
    validateClsClassification(
      { industries: { 电子: [{ id: 2 }, { id: 2 }] } },
      ["2", "3"],
    ),
  ).toThrow();
  expect(() =>
    validateClsClassification({ industries: { 电子: [{ id: 2 }] } }, ["2"]),
  ).not.toThrow();
});
it("requires a matching ready receipt and rejects tampering after completion", async () => {
  const now = Date.now(),
    root = join(process.env.QUANT_DATA_DIR!, "reports");
  await mkdir(root, { recursive: true });
  const path = join(root, "CLS-test.md"),
    markdown =
      "# 财联社\n报告日期：2026-09-11\n### 电子\n方向：偏多\n验证信号：订单增长\n";
  await writeFile(path, markdown);
  expect((await previewClsReport(path)).batch).toBeUndefined();
  const batch = clsBatchReceiptSchema.parse({
    version: "cls-batch-1",
    phase: "morning",
    date: "2026-09-11",
    startedAt: now - 100,
    completedAt: now - 1,
    windowFrom: now - 500,
    windowTo: now - 100,
    newsIds: ["1"],
    reportHash: parseClsReport(markdown).hash,
  });
  await writeFile(path + ".ready.json", JSON.stringify(batch));
  expect((await previewClsReport(path)).batch?.phase).toBe("morning");
  await writeFile(path, markdown + "篡改");
  await expect(previewClsReport(path)).rejects.toThrow("不匹配");
  expect(() =>
    clsBatchReceiptSchema.parse({ ...batch, newsIds: ["1", "1"] }),
  ).toThrow();
});
