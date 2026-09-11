import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { clsBatchReceiptSchema, type ClsBatchReceipt } from "~/lib/cls-batch";
import { get, put, sqlite } from "./db";
import { claimWorkflow } from "./workflow-lease";
import { parseClsReport } from "./cls-report-parser";
import { previewClsReport } from "./cls-report-files";
import { ClsReviewStore } from "./cls-review-store";
import { runClsReviewTick } from "./cls-review-scheduler";

export const clsWorkflowDirectory = () =>
  join(homedir(), "Documents", "QuantWorkbench", "CLS");
function runPython(script: string, args: string[], timeout: number) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("C:\\Python312\\python.exe", [script, ...args], {
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("新闻分析超时，未发布完成标记"));
    }, timeout);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("新闻技能脚本启动失败"));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve()
        : reject(new Error(`新闻技能脚本退出异常（${code}）`));
    });
  });
}
const newsSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    ctime: z.number(),
    title: z.string(),
    content: z.string(),
  })
  .passthrough();
export function incrementalClsNews(
  rows: unknown[],
  seen: string[],
  cutoff: number,
) {
  const known = new Set(seen),
    found = new Set<string>();
  return rows
    .map((row) => newsSchema.parse(row))
    .filter((row) => {
      const id = String(row.id);
      if (row.ctime * 1000 > cutoff || known.has(id) || found.has(id))
        return false;
      found.add(id);
      return true;
    });
}
export function validateClsClassification(raw: unknown, newsIds: string[]) {
  const value = z
    .object({
      industries: z.record(
        z.array(
          z.object({ id: z.union([z.string(), z.number()]) }).passthrough(),
        ),
      ),
    })
    .parse(raw);
  const ids = Object.values(value.industries)
    .flat()
    .map((row) => String(row.id));
  if (
    ids.length !== newsIds.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !newsIds.includes(id))
  )
    throw new Error("新闻分类证据ID缺失、重复或不属于本批次");
}
export async function runClsNewsBatch(
  phase: ClsBatchReceipt["phase"],
  now = Date.now(),
  reportDirectory = clsWorkflowDirectory(),
) {
  const date = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
  const key = `cls-analysis-${date}-${phase}`;
  const existing = get<{ status: string; reportId?: string }>(key);
  if (existing) return existing;
  if (phase === "morning" && now >= Date.parse(`${date}T09:30:00+08:00`))
    throw new Error("盘前分析错过开盘，不补选主样本");
  const lease = claimWorkflow("cls-analysis", 30 * 60000);
  if (!lease) throw new Error("另一个新闻批次正在执行");
  try {
    const directory = reportDirectory,
      work = join(directory, "work", `${date}-${phase}`);
    await mkdir(work, { recursive: true });
    const checkpoint = get<{ newsIds: string[]; windowTo: number }>(
      "cls-news-checkpoint",
    );
    const windowFrom = now - 5 * 86400000;
    const db = new Database("E:/pythonPrj/cls_news_collector/cls_news.db", {
      readonly: true,
      fileMustExist: true,
    });
    let rows: unknown[];
    try {
      rows = db
        .prepare(
          "SELECT * FROM news WHERE ctime>=? AND ctime<=? ORDER BY ctime,id",
        )
        .all(Math.floor(windowFrom / 1000), Math.floor(now / 1000));
    } finally {
      db.close();
    }
    const news = incrementalClsNews(rows, checkpoint?.newsIds ?? [], now);
    if (!news.length) {
      const empty = {
        status: "empty",
        phase,
        date,
        completedAt: Date.now(),
        message: "本批次无新增新闻",
      };
      put("cls-analysis-batch", key, empty);
      return empty;
    }
    const newsIds = news.map((row) => String(row.id));
    const input = join(work, "news_raw.json"),
      classified = join(work, "news_raw_classified.json");
    await writeFile(
      input,
      JSON.stringify({
        count: news.length,
        items: news.map((row) => ({
          ...row,
          time_str: new Date(row.ctime * 1000 + 8 * 3600000)
            .toISOString()
            .slice(0, 19)
            .replace("T", " "),
        })),
      }),
      "utf8",
    );
    const skills = join(homedir(), ".agent-skills", "skills");
    await runPython(
      join(skills, "news-industry-classifier", "scripts", "classify.py"),
      [input],
      8 * 60000,
    );
    validateClsClassification(
      JSON.parse(await readFile(classified, "utf8")),
      newsIds,
    );
    lease.assert();
    const rawReport = join(work, "analysis.md");
    await runPython(
      join(skills, "news-sector-analyzer", "scripts", "analyze.py"),
      [input, classified, "--out", rawReport],
      15 * 60000,
    );
    const body = await readFile(rawReport, "utf8");
    if (body.length < 200 || !/验证信号/.test(body) || !/附录/.test(body))
      throw new Error("新闻报告章节不完整，未发布");
    const labels = {
      morning: "盘前主报告",
      noon: "午间增量",
      evening: "晚间增量（次日观察）",
    };
    const markdown = `# 财联社${labels[phase]}\n\n报告日期：${date}\n\n批次：${labels[phase]}；输入截止：${new Date(now).toISOString()}。增量报告不替换已固定盘前样本。\n\n${body}\n\n## 本批次证据ID\n\n${news.map((row) => `- 新闻ID ${row.id}：${row.title.replaceAll("\n", " ")}`).join("\n")}\n`;
    const report = parseClsReport(markdown);
    if (!report.sections.length)
      throw new Error("新闻报告没有可识别的板块章节");
    const completedAt = Date.now();
    const batch = clsBatchReceiptSchema.parse({
      version: "cls-batch-1",
      phase,
      date,
      startedAt: now,
      completedAt,
      windowFrom,
      windowTo: now,
      newsIds,
      reportHash: report.hash,
    });
    const path = join(directory, `CLS-${date}-${phase}.md`);
    await writeFile(`${path}.tmp`, markdown, "utf8");
    await rename(`${path}.tmp`, path);
    await writeFile(`${path}.ready.json.tmp`, JSON.stringify(batch), "utf8");
    await rename(`${path}.ready.json.tmp`, `${path}.ready.json`);
    lease.assert();
    const archive = new ClsReviewStore(sqlite()).import(
      await previewClsReport(path),
      report.hash,
    );
    const result = { status: "complete", reportId: archive.id, ...batch };
    sqlite().transaction(() => {
      put("cls-analysis-batch", key, result);
      put("cls-news-checkpoint", "cls-news-checkpoint", {
        newsIds: [
          ...new Set([...(checkpoint?.newsIds ?? []), ...newsIds]),
        ].slice(-10000),
        windowTo: now,
      });
    })();
    await runClsReviewTick();
    return result;
  } catch (error) {
    put("workflow-check", `${key}:check`, {
      phase,
      date,
      status: "failed",
      checkedAt: Date.now(),
      error: error instanceof Error ? error.message : "新闻分析失败",
    });
    throw error;
  } finally {
    lease.release();
  }
}
