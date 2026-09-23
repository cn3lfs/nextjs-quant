import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { migrate } from "../../src/server/db/migrations";
import {
  clsReportFiles,
  previewClsReport,
} from "../../src/server/news/cls-report-files";
import { ClsReviewStore } from "../../src/server/news/cls-review-store";

it("previews read-only files, rejects stale approval and archives revisions idempotently", async () => {
  await mkdir(".test-data", { recursive: true });
  const root = await mkdtemp(resolve(".test-data/cls-review-"));
  const db = new Database(":memory:");
  migrate(db);
  try {
    const path = join(root, "CLS报告.md");
    const content = "# 报告\n### 电子（方向：偏多 ｜ 信心：高）\n正文\n";
    await writeFile(path, content);
    await writeFile(join(root, "other.md"), "unrelated");
    expect(await clsReportFiles(root)).toEqual([{ name: "CLS报告.md", path }]);
    const first = await previewClsReport(path);
    const store = new ClsReviewStore(db);
    const archived = store.import(first, first.report.hash);
    expect(store.import(first, first.report.hash)).toEqual(archived);
    expect(store.reports()).toHaveLength(1);
    expect(await readFile(path, "utf8")).toBe(content);
    await writeFile(path, content + "更新\n");
    const second = await previewClsReport(path);
    expect(() => store.import(second, first.report.hash)).toThrow("已变化");
    expect(store.import(second, second.report.hash).versionNumber).toBe(2);
    expect(store.report(archived.id)?.report.markdown).toBe(content);
    expect(() =>
      new ClsReviewStore(db, 1).import(
        { ...second, sourcePath: path + "new" },
        second.report.hash,
      ),
    ).toThrow("上限");
    await expect(previewClsReport(root)).rejects.toThrow("Markdown");
    await writeFile(join(root, "invalid.md"), Buffer.from([0xff, 0xfe]));
    await expect(previewClsReport(join(root, "invalid.md"))).rejects.toThrow();
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
