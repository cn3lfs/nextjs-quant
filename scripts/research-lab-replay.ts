import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { runPortfolio, type PortfolioRequest } from "quant-backtest";

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sizeLimit = 512 * 1024 ** 2;

const barSchema = z.object({ date: z.string().min(1) }).passthrough();
const instrumentSchema = z
  .object({
    symbol: z.string().min(1),
    market: z.enum(["cn-equity", "crypto"]),
    bars: z.array(barSchema).min(1),
    signalBars: z.array(barSchema).min(1).optional(),
    execution: z.record(z.string(), z.unknown()),
    actions: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .passthrough();
/** Only the fields the engine requires are asserted; frozen extras pass through
 * untouched so hashing the parsed export still binds the original request. */
const requestSchema = z
  .object({
    market: z.enum(["cn-equity", "crypto"]),
    initial: z.number().finite().positive(),
    start: z.string().min(1),
    end: z.string().min(1),
    calendar: z.array(z.string().min(1)).min(1),
    instruments: z.array(instrumentSchema).min(1),
    strategies: z.array(z.record(z.string(), z.unknown())).min(1),
    sleeves: z
      .array(
        z
          .object({
            id: z.string().min(1),
            share: z.number().finite().nonnegative(),
            riskPerTrade: z.number().finite().positive(),
            maxPositions: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1),
    costs: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
const frozenSchema = z.object({ request: requestSchema }).passthrough();
/** The application's explicit task export: `exportTaskEvidence` returns the
 * submitted job input plus the full `executeLabBacktest` result. */
const exportSchema = z
  .object({
    input: z.record(z.string(), z.unknown()).optional(),
    result: z
      .object({
        inputHash: z.string().regex(/^[a-f0-9]{64}$/),
        frozen: frozenSchema,
        result: z
          .object({
            fills: z.array(z.unknown()),
            rejections: z.array(z.unknown()),
            curve: z.array(z.unknown()),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

export type LabReplaySummary = {
  kind: "lab-replay";
  source: string;
  inputHash: string;
  costScenario: string | null;
  fills: number;
  rejections: number;
  curve: number;
  positions: number;
  fillsHash: string;
  rejectionsHash: string;
  curveHash: string;
  boundary: string;
};
export type LabReplayReport = {
  summary: LabReplaySummary;
  result: ReturnType<typeof runPortfolio>;
};
export class LabReplayInputError extends Error {}
export class LabReplayIntegrityError extends Error {}
export class LabReplayUsageError extends Error {}

/** Replay exactly the frozen lab request. This never re-reads market data,
 * never rewrites the export and never touches the database. */
export async function replayLabExport(
  exportPath: string,
): Promise<LabReplayReport> {
  const source = resolve(exportPath);
  if ((await stat(source)).size > sizeLimit)
    throw new LabReplayInputError("实验室导出超过512MB资源预算");
  const raw: unknown = JSON.parse(await readFile(source, "utf8"));
  // Hash the parsed export before schema validation so a stricter schema can
  // never silently drop a field that the original input hash covered.
  const candidate = raw as {
    result?: { inputHash?: unknown; frozen?: unknown };
  };
  const inputHash = candidate.result?.inputHash;
  const frozen = candidate.result?.frozen;
  if (typeof inputHash !== "string" || typeof frozen !== "object" || !frozen)
    throw new LabReplayInputError(
      "导出缺少 result.inputHash 或 result.frozen，请使用应用任务证据导出",
    );
  if (digest(frozen) !== inputHash)
    throw new LabReplayIntegrityError(
      "冻结请求摘要不匹配，导出内容已被篡改，拒绝回放",
    );
  const exported = exportSchema.parse(raw);
  const original = exported.result.result;
  const replay = runPortfolio(
    exported.result.frozen.request as unknown as PortfolioRequest,
  );
  for (const field of ["fills", "rejections", "curve"] as const)
    if (digest(replay[field]) !== digest(original[field]))
      throw new LabReplayIntegrityError(
        `回放结果与导出的 ${field} 不一致，拒绝接受`,
      );
  return {
    summary: {
      kind: "lab-replay",
      source,
      inputHash,
      costScenario:
        typeof (frozen as { costScenario?: unknown }).costScenario === "string"
          ? (frozen as { costScenario: string }).costScenario
          : null,
      fills: replay.fills.length,
      rejections: replay.rejections.length,
      curve: replay.curve.length,
      positions: replay.positions.length,
      fillsHash: digest(replay.fills),
      rejectionsHash: digest(replay.rejections),
      curveHash: digest(replay.curve),
      boundary:
        "只读重放已冻结请求；不重新读取行情、不改变输入；规则自检，非可信策略业绩",
    },
    result: replay,
  };
}

function parseArgs(argv: readonly string[]) {
  let exportPath: string | undefined;
  let outputPath: string | undefined;
  let help = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--export") {
      if (exportPath !== undefined)
        throw new LabReplayUsageError("--export 只能出现一次");
      exportPath = argv[++index];
      if (!exportPath) throw new LabReplayUsageError("--export 缺少文件路径");
      continue;
    }
    if (arg === "--output") {
      if (outputPath !== undefined)
        throw new LabReplayUsageError("--output 只能出现一次");
      outputPath = argv[++index];
      if (!outputPath) throw new LabReplayUsageError("--output 缺少文件路径");
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    throw new LabReplayUsageError(`未知参数：${arg}`);
  }
  return {
    help,
    exportPath: exportPath === undefined ? null : resolve(exportPath),
    outputPath: outputPath === undefined ? null : resolve(outputPath),
  };
}

const usage = [
  "用法：pnpm exec tsx scripts/research-lab-replay.ts --export <任务导出.json> [--output <回放结果.json>]",
  "读取应用“导出任务证据”得到的 { input, result }，校验 result.inputHash 后按冻结请求重放。",
  "只读：不重新读取行情、不改变输入、不写数据库；--output 只新建显式指定的回放结果文件，已存在则拒绝覆盖。",
].join("\n");

/** Explicit read-only CLI. Returns 0 only when the replay matches the export. */
export async function runResearchLabReplay(argv: readonly string[]) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      process.stdout.write(`${usage}\n`);
      return 0;
    }
    if (!args.exportPath) throw new LabReplayUsageError("必须提供 --export");
    if (args.outputPath && args.outputPath === args.exportPath)
      throw new LabReplayUsageError("--output 不能覆盖导出输入");
    const report = await replayLabExport(args.exportPath);
    if (args.outputPath) {
      const payload = JSON.stringify(
        { ...report.summary, result: report.result },
        null,
        2,
      );
      // Exclusive create: a pre-existing path is refused even when it reaches
      // the export through a symlink or hardlink alias. The read-only export
      // must never be replaced by the run meant to verify it.
      try {
        await writeFile(args.outputPath, payload, { flag: "wx" });
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === "EEXIST")
          throw new LabReplayUsageError(
            `--output 已存在，拒绝覆盖：${args.outputPath}`,
          );
        throw error;
      }
    }
    process.stdout.write(
      `${JSON.stringify(
        args.outputPath
          ? { ...report.summary, output: args.outputPath }
          : report.summary,
      )}\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof LabReplayUsageError)
      process.stderr.write(`${usage}\n`);
    process.stderr.write(
      `回放失败：${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  process.exitCode = await runResearchLabReplay(process.argv.slice(2));
