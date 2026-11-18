import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cancelRun,
  errorCode,
  errorMessage,
  getRunStatus,
  resumeRunTask,
  startRun,
  toRunStatusView,
  QuantTeamError,
  type CoordinatorOptions,
} from "./lib/quant-team/index";

export const HELP = `quant-team — Codex 管理者调度外部分角色 Claude CLI

用法（在仓库根目录）:
  pnpm quant:team run --input <batch.json>
  pnpm quant:team status --run <runId>
  pnpm quant:team cancel --run <runId> [--task <taskId>]
  pnpm quant:team resume --run <runId> --task <taskId>
  pnpm quant:team --help

说明:
- 角色固定为 researcher/data/trader/risk/backtester/reviewer。
- 只调用 PATH 中的外部 Claude CLI；不设置 --model/effort，不修改 Claude 配置。
- 忽略继承的 MCP 服务器；工具面仅由 --tools 限定，不使用 --allowedTools。
- 运行状态与每任务输出保存在 <repo>/.test-data/quant-team/<runId>。
- 不自动重试、不切换模型、不扩大权限；失败/阻断/取消后需显式 resume。
- resume 只接受失败/阻断/取消且已有已知 session_id 的任务；已完成任务拒绝。
`;

export type ParsedCommand =
  | { command: "help" }
  | { command: "run"; input: string }
  | { command: "status"; run: string }
  | { command: "cancel"; run: string; task: string | null }
  | { command: "resume"; run: string; task: string };

const allowedFlags: Record<string, readonly string[]> = {
  run: ["input"],
  status: ["run"],
  cancel: ["run", "task"],
  resume: ["run", "task"],
};

export function parseCliArgs(argv: string[]): ParsedCommand {
  if (argv.length === 0 || argv.includes("--help") || argv[0] === "help")
    return { command: "help" };
  const command = argv[0];
  if (
    command !== "run" &&
    command !== "status" &&
    command !== "cancel" &&
    command !== "resume"
  )
    throw new QuantTeamError(
      "INVALID_CLI",
      `未知命令: ${command ?? "<empty>"}；使用 --help`,
    );
  const flags: Record<string, string> = {};
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--"))
      throw new QuantTeamError(
        "INVALID_CLI",
        `多余参数: ${token ?? "<empty>"}`,
      );
    const name = token.slice(2);
    if (!allowedFlags[command]?.includes(name))
      throw new QuantTeamError(
        "INVALID_CLI",
        `命令 ${command} 不支持参数 --${name}`,
      );
    if (flags[name] !== undefined)
      throw new QuantTeamError("INVALID_CLI", `参数 --${name} 重复`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new QuantTeamError("INVALID_CLI", `参数 --${name} 缺少值`);
    flags[name] = value;
    index += 1;
  }

  if (command === "run") {
    if (!flags.input)
      throw new QuantTeamError("INVALID_CLI", "run 需要 --input");
    return { command, input: flags.input };
  }
  if (command === "status") {
    if (!flags.run)
      throw new QuantTeamError("INVALID_CLI", "status 需要 --run");
    return { command, run: flags.run };
  }
  if (command === "cancel") {
    if (!flags.run)
      throw new QuantTeamError("INVALID_CLI", "cancel 需要 --run");
    return { command, run: flags.run, task: flags.task ?? null };
  }
  if (!flags.run || !flags.task)
    throw new QuantTeamError("INVALID_CLI", "resume 需要 --run 和 --task");
  return { command, run: flags.run, task: flags.task };
}

export type CliOptions = CoordinatorOptions;

export type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readBatch(path: string): unknown {
  let contents: string;
  try {
    contents = readFileSync(resolve(path), "utf8");
  } catch (error) {
    throw new QuantTeamError(
      "INVALID_INPUT_JSON",
      `无法读取 batch 文件: ${errorMessage(error)}`,
    );
  }
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new QuantTeamError(
      "INVALID_INPUT_JSON",
      `batch 文件不是合法 JSON: ${errorMessage(error)}`,
    );
  }
}

export async function runCli(
  argv: string[],
  options: CliOptions = {},
): Promise<CliResult> {
  try {
    const command = parseCliArgs(argv);
    if (command.command === "help")
      return { exitCode: 0, stdout: HELP, stderr: "" };
    if (command.command === "run") {
      const record = await startRun(readBatch(command.input), options);
      return {
        exitCode: 0,
        stdout: json({
          ok: true,
          command: "run",
          state: toRunStatusView(record),
        }),
        stderr: "",
      };
    }
    if (command.command === "status")
      return {
        exitCode: 0,
        stdout: json({
          ok: true,
          command: "status",
          state: getRunStatus(command.run, options),
        }),
        stderr: "",
      };
    if (command.command === "cancel") {
      const result = await cancelRun(command.run, command.task, options);
      return {
        exitCode: 0,
        stdout: json({
          ok: true,
          command: "cancel",
          mode: result.mode,
          state: result.state,
        }),
        stderr: "",
      };
    }
    const record = await resumeRunTask(command.run, command.task, options);
    return {
      exitCode: 0,
      stdout: json({
        ok: true,
        command: "resume",
        state: toRunStatusView(record),
      }),
      stderr: "",
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: json({
        ok: false,
        error: {
          code: errorCode(error),
          message: errorMessage(error),
        },
      }),
    };
  }
}

export async function main(
  argv: string[] = process.argv.slice(2),
  options: CliOptions = {},
): Promise<number> {
  const result = await runCli(argv, options);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.exitCode;
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : "";
const modulePath = resolve(fileURLToPath(import.meta.url));
if (entryPath && entryPath.toLowerCase() === modulePath.toLowerCase()) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
