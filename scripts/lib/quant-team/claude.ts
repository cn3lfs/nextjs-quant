import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { QuantTeamError } from "./errors";
import { assertNoLinks } from "./paths";
import { runChildProcess } from "./process";
import { redactSecrets } from "./redact";
import { writeTextAtomic } from "./state";
import {
  structuredResultJsonSchema,
  structuredResultSchema,
  type Role,
  type StructuredResult,
  type StructuredStatus,
  type TaskOutcome,
  type TaskRunRequest,
  type TaskRunner,
} from "./types";

export type ClaudeOutputInput = {
  stdout: string;
  stderr?: string;
  exitCode: number | null;
  started?: boolean;
  spawnError?: string | null;
  timedOut?: boolean;
  cancelled?: boolean;
  outputExceeded?: boolean;
};

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function shimPackageRoots(shimPath: string): string[] {
  const shimDir = dirname(shimPath);
  const roots = new Set<string>([
    resolve(shimDir, "node_modules", "@anthropic-ai", "claude-code"),
    resolve(shimDir, "..", "node_modules", "@anthropic-ai", "claude-code"),
    resolve(shimDir, "..", "@anthropic-ai", "claude-code"),
  ]);
  let contents: string;
  try {
    contents = readFileSync(shimPath, "utf8").slice(0, 64 * 1024);
  } catch {
    return [...roots];
  }
  const normalized = contents.replaceAll("\\", "/");
  const marker = /node_modules\/@anthropic-ai\/claude-code/g;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(normalized)) !== null) {
    const suffix = normalized
      .slice(match.index)
      .split(/["'\r\n]/, 1)[0]
      ?.trim();
    if (suffix) roots.add(resolve(shimDir, suffix));
  }
  return [...roots];
}

function resolveShimExecutable(shimPath: string): string | null {
  for (const root of shimPackageRoots(shimPath)) {
    for (const candidate of [join(root, "bin", "claude.exe")])
      if (isFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve the real Claude binary from PATH. npm .cmd/.ps1 shims are followed to
 * the installed package binary; there is deliberately no hardcoded machine path
 * fallback, so a missing install fails loudly instead of calling another build.
 */
export function resolveClaudeExecutable(
  envPath: string = process.env.PATH ?? "",
  platform: NodeJS.Platform = process.platform,
): string {
  const directories = envPath
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter((entry) => entry.length > 0);
  let sawShim: string | null = null;
  for (const directory of directories) {
    if (platform === "win32") {
      const native = join(directory, "claude.exe");
      if (isFile(native)) return native;
      for (const shimName of ["claude.cmd", "claude.ps1"]) {
        const shim = join(directory, shimName);
        if (!isFile(shim)) continue;
        sawShim = shim;
        const executable = resolveShimExecutable(shim);
        if (executable) return executable;
      }
      continue;
    }
    const candidate = join(directory, "claude");
    if (!isFile(candidate)) continue;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking: a non-executable file is not a PATH command.
    }
  }
  if (sawShim)
    throw new QuantTeamError(
      "CLAUDE_EXECUTABLE_NOT_FOUND",
      `找到 Claude shim 但未解析到已安装的 node_modules/@anthropic-ai/claude-code/bin/claude.exe: ${sawShim}`,
    );
  throw new QuantTeamError(
    "CLAUDE_EXECUTABLE_NOT_FOUND",
    "PATH 中找不到 Claude 可执行文件；不会回退到硬编码路径",
  );
}

export function claudeToolsForRole(role: Role): string {
  // Backtester may use the existing controlled shell under normal permission
  // checks. No role is pre-approved for arbitrary Bash or mutation tools.
  return role === "backtester" ? "Read,Glob,Grep,Bash" : "Read,Glob,Grep";
}

export function buildClaudeArgs(request: {
  role: Role;
  sessionId: string;
  resume: boolean;
}): string[] {
  const args = [
    "--print",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(structuredResultJsonSchema),
    "--tools",
    claudeToolsForRole(request.role),
    // Ignore inherited MCP servers; --tools only restricts built-ins, so an
    // empty scoped MCP config prevents network/write MCP tools from leaking in.
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
  ];
  if (request.resume) args.push("--resume", request.sessionId);
  else args.push("--session-id", request.sessionId);
  return args;
}

function baseOutcome(
  kind: TaskOutcome["kind"],
  input: ClaudeOutputInput,
): TaskOutcome {
  return {
    kind,
    started: input.started ?? true,
    sessionId: null,
    structuredStatus: null,
    result: null,
    blockers: [],
    error: null,
    timedOut: input.timedOut ?? false,
    cancelled: input.cancelled ?? false,
    outputExceeded: input.outputExceeded ?? false,
    exitCode: input.exitCode,
    permissionDenials: [],
    isError: false,
  };
}

function failed(
  code: string,
  message: string,
  input: ClaudeOutputInput,
  blockers: string[] = [],
): TaskOutcome {
  return {
    ...baseOutcome("failed", input),
    blockers,
    error: { code, message: redactSecrets(message) },
  };
}

function denialNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      names.push(item);
      continue;
    }
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const name = record.tool_name ?? record.toolName ?? record.name;
      names.push(typeof name === "string" ? name : "unknown");
    }
  }
  return [...new Set(names.map((name) => name.slice(0, 120)))].slice(0, 20);
}

function structuredFrom(
  value: unknown,
): { result: StructuredResult; status: StructuredStatus } | null {
  const parsed = structuredResultSchema.safeParse(value);
  if (!parsed.success) return null;
  return { result: parsed.data, status: parsed.data.status };
}

/**
 * exit 0 alone is not success: structured output, is_error and permission
 * denials all participate in the result.
 */
export function parseClaudeOutput(input: ClaudeOutputInput): TaskOutcome {
  if (input.cancelled) {
    const outcome = baseOutcome("cancelled", input);
    outcome.blockers = ["cancelled"];
    return outcome;
  }
  if (input.timedOut)
    return failed("TIMEOUT", "Claude 进程超过 timeoutMs，已停止", input, [
      "timeout",
    ]);
  if (input.outputExceeded)
    return failed(
      "OUTPUT_LIMIT",
      "Claude 输出超过有界缓冲上限，已停止并保留部分本地输出",
      input,
      ["output_limit"],
    );
  if (input.spawnError)
    return failed("SPAWN_ERROR", input.spawnError, input, ["spawn_error"]);

  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(input.stdout.trim()) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("output is not a JSON object");
    parsed = value as Record<string, unknown>;
  } catch (error) {
    return failed(
      "MALFORMED_OUTPUT",
      `无法解析 Claude JSON 输出: ${
        error instanceof Error ? error.message : String(error)
      }`,
      input,
      ["malformed_output"],
    );
  }

  const sessionId =
    typeof parsed.session_id === "string" && parsed.session_id.length > 0
      ? parsed.session_id
      : null;
  const denials = denialNames(parsed.permission_denials);
  const isError = parsed.is_error === true;

  if (isError) {
    const detail =
      typeof parsed.result === "string"
        ? parsed.result
        : (input.stderr ?? "Claude 返回 is_error=true");
    return {
      ...failed("CLAUDE_ERROR", detail, input, ["claude_error"]),
      sessionId,
      permissionDenials: denials,
      isError,
    };
  }
  if (input.exitCode !== 0)
    return {
      ...failed(
        "NONZERO_EXIT",
        `Claude 退出码 ${input.exitCode ?? "null"}`,
        input,
        [`exit_${input.exitCode ?? "null"}`],
      ),
      sessionId,
      permissionDenials: denials,
    };

  if (denials.length > 0)
    return {
      ...baseOutcome("blocked", input),
      sessionId,
      permissionDenials: denials,
      blockers: denials.map((name) => `permission_denied:${name}`),
      error: {
        code: "PERMISSION_DENIED",
        message: "Claude 报告 permission_denials，任务未完成",
      },
    };

  if (!sessionId)
    return failed(
      "MISSING_SESSION_ID",
      "Claude 输出缺少 session_id，后续无法精确 resume",
      input,
      ["missing_session_id"],
    );

  if (
    parsed.structured_output === undefined ||
    parsed.structured_output === null
  )
    return {
      ...failed(
        "MISSING_STRUCTURED_OUTPUT",
        "Claude 输出缺少 structured_output",
        input,
        ["missing_structured_output"],
      ),
      sessionId,
    };

  const structured = structuredFrom(parsed.structured_output);
  if (!structured)
    return {
      ...failed(
        "MALFORMED_STRUCTURED_OUTPUT",
        "structured_output 不符合约定 schema",
        input,
        ["malformed_structured_output"],
      ),
      sessionId,
    };

  const kind = structured.status === "complete" ? "completed" : "blocked";
  const blockers = [...structured.result.blockers];
  if (structured.status === "needs_decision") blockers.push("needs_decision");
  return {
    ...baseOutcome(kind, input),
    sessionId,
    structuredStatus: structured.status,
    result: structured.result,
    blockers,
  };
}

export type ClaudeTaskRequest = TaskRunRequest & {
  executable?: string;
  maxBytesPerStream?: number;
};

export async function runClaudeTask(
  request: ClaudeTaskRequest,
): Promise<TaskOutcome> {
  const stdoutPath = join(request.attemptDir, "stdout.log");
  const stderrPath = join(request.attemptDir, "stderr.log");
  const promptPath = join(request.attemptDir, "prompt.txt");
  for (const path of [stdoutPath, stderrPath, promptPath])
    assertNoLinks(request.attemptDir, path);
  writeTextAtomic(promptPath, `${request.prompt}\n`);

  let executable: string;
  try {
    executable = request.executable ?? resolveClaudeExecutable();
  } catch (error) {
    return {
      ...baseOutcome("failed", {
        stdout: "",
        exitCode: null,
        started: false,
      }),
      blockers: ["claude_executable_not_found"],
      error: {
        code: "CLAUDE_EXECUTABLE_NOT_FOUND",
        message: redactSecrets(
          error instanceof Error ? error.message : String(error),
        ),
      },
      promptPath,
    };
  }

  const args = buildClaudeArgs({
    role: request.task.role,
    sessionId: request.sessionId,
    resume: request.resume,
  });
  const child = await runChildProcess({
    command: executable,
    args,
    cwd: request.cwd,
    env: request.env,
    stdin: request.prompt,
    timeoutMs: request.timeoutMs,
    signal: request.signal,
    maxBytesPerStream: request.maxBytesPerStream,
    onSpawn: request.onSpawn,
  });
  writeTextAtomic(stdoutPath, child.stdout);
  writeTextAtomic(stderrPath, child.stderr);

  let outcome = parseClaudeOutput({
    stdout: child.stdout,
    stderr: child.stderr,
    exitCode: child.exitCode,
    started: child.pid !== null,
    spawnError: child.spawnError,
    timedOut: child.timedOut,
    cancelled: child.cancelled,
    outputExceeded: child.outputExceeded,
  });
  if (
    request.resume &&
    outcome.sessionId !== null &&
    outcome.sessionId !== request.sessionId
  )
    outcome = {
      ...failed(
        "SESSION_MISMATCH",
        `resume 返回了不同 session_id: ${outcome.sessionId}`,
        {
          stdout: "",
          stderr: "",
          exitCode: child.exitCode,
          started: child.pid !== null,
        },
        ["session_mismatch"],
      ),
      sessionId: outcome.sessionId,
    };

  return { ...outcome, stdoutPath, stderrPath, promptPath };
}

export function createClaudeRunner(
  options: { executable?: string; maxBytesPerStream?: number } = {},
): TaskRunner {
  return (request) =>
    runClaudeTask({
      ...request,
      executable: options.executable,
      maxBytesPerStream: options.maxBytesPerStream,
    });
}

export function claudeExecutableForPath(
  envPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return resolveClaudeExecutable(envPath, platform);
}
