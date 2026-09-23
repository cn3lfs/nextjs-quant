import { lstat, readFile, realpath, readdir } from "node:fs/promises";
import { resolve, join, extname } from "node:path";
import { parseClsReport } from "./cls-report-parser";
import { clsBatchReceiptSchema, type ClsBatchReceipt } from "~/lib/news/cls-batch";

export async function clsReportFiles(directory: string) {
  const root = resolve(directory);
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        !entry.isSymbolicLink() &&
        /(?:cls|财联社)/i.test(entry.name) &&
        /\.md$/i.test(entry.name),
    )
    .map((entry) => ({ name: entry.name, path: join(root, entry.name) }))
    .sort((a, b) => b.name.localeCompare(a.name, "zh-CN"));
}

export async function previewClsReport(path: string) {
  const absolute = resolve(path);
  if (extname(absolute).toLowerCase() !== ".md")
    throw new Error("仅支持Markdown报告");
  const before = await lstat(absolute);
  if (!before.isFile() || before.isSymbolicLink())
    throw new Error("报告须为普通文件");
  if (before.size > 2 * 1024 * 1024) throw new Error("报告超过2MiB");
  const bytes = await readFile(absolute);
  const after = await lstat(absolute);
  if (
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  )
    throw new Error("报告正在更新，请稍后重新预览");
  const markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const report = parseClsReport(markdown);
  let batch: ClsBatchReceipt | undefined;
  try {
    batch = clsBatchReceiptSchema.parse(
      JSON.parse(
        (await readFile(`${absolute}.ready.json`, "utf8")).replace(
          /^\uFEFF/,
          "",
        ),
      ),
    );
    if (
      batch.reportHash !== report.hash ||
      batch.date !== report.reportDate ||
      batch.completedAt > Date.now()
    )
      throw new Error("报告完成标记与内容不匹配");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    sourcePath: await realpath(absolute),
    modifiedAt: after.mtimeMs,
    size: bytes.length,
    observedAt: Date.now(),
    report,
    ...(batch ? { batch } : {}),
  };
}
export type ClsReportPreview = Awaited<ReturnType<typeof previewClsReport>>;
