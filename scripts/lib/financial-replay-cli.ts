import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { financialReplayInput } from "../../src/lib/financial/financial-replay";
import { ResearchRunAbortedError } from "../../src/server/research/research-run";

export const cliExit = {
  ok: 0,
  failure: 1,
  blocked: 2,
  usage: 64,
  cancelled: 130,
} as const;

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export type FinancialCliArgs = {
  help: boolean;
  inputPath: string | null;
};

export function parseFinancialCliArgs(
  argv: readonly string[],
): FinancialCliArgs {
  let help = false,
    inputPath: string | null = null;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--input") {
      const value = argv[++index];
      if (!value) throw new CliUsageError("--input 需要 JSON 文件路径");
      if (inputPath) throw new CliUsageError("--input 只能提供一次");
      inputPath = value;
      continue;
    }
    throw new CliUsageError(`未知参数：${argument}`);
  }
  if (!help && !inputPath)
    throw new CliUsageError("必须提供 --input <JSON 文件>");
  return { help, inputPath };
}

const cliInputSchema = z
  .object({
    root: z.string().trim().min(1, "root 不能为空"),
    input: financialReplayInput,
  })
  .strict();

export type FinancialCliInput = z.infer<typeof cliInputSchema>;

/** Explicit absolute data directory; never fall back to the production default. */
export function requireAbsoluteDataDirectory() {
  const value = process.env.QUANT_DATA_DIR;
  if (!value || !value.trim())
    throw new CliUsageError(
      "必须显式设置绝对 QUANT_DATA_DIR；CLI 不默认打开生产数据库",
    );
  if (!isAbsolute(value.trim()))
    throw new CliUsageError("QUANT_DATA_DIR 必须是绝对路径");
  return value.trim();
}

export async function readFinancialCliInput(inputPath: string) {
  const file = resolve(inputPath);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new CliUsageError(
      `无法读取/解析输入 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = cliInputSchema.safeParse(raw);
  if (!parsed.success)
    throw new CliUsageError(
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
        .join("；"),
    );
  if (!isAbsolute(parsed.data.root))
    throw new CliUsageError("输入 root 必须是绝对只读通达信目录");
  return { ...parsed.data, file };
}

export function installSigint() {
  const controller = new AbortController();
  const handler = () => controller.abort(new Error("SIGINT"));
  process.once("SIGINT", handler);
  return {
    controller,
    dispose: () => process.off("SIGINT", handler),
  };
}

export function financialCliExitCode(error: unknown) {
  if (error instanceof ResearchRunAbortedError && error.reason === "cancelled")
    return cliExit.cancelled;
  return cliExit.failure;
}

export function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function printUsage(script: string, lines: readonly string[]) {
  process.stdout.write(
    [
      `用法：pnpm exec tsx scripts/${script} --input <JSON 文件>`,
      "",
      ...lines,
      "",
      "退出码：0 完成；2 证据不足阻断；64 用法/输入错误；130 SIGINT 取消；1 其他失败。",
      'JSON 输入：{"root":"<绝对只读通达信目录>","input":<FinancialReplayInput>}',
      "",
    ].join("\n"),
  );
}

export function isMainModule(moduleUrl: string) {
  const entry = process.argv[1];
  return !!entry && moduleUrl === pathToFileURL(resolve(entry)).href;
}
