import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { delimiter, join, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";

export type LocalProvider = "codex" | "claude";
export function findCli(provider: LocalProvider): string | undefined {
  const directories = [
    ...(process.env.PATH ?? "").split(delimiter),
    join(homedir(), ".local", "bin"),
    join(process.env.APPDATA ?? "", "npm"),
    "C:\\Program Files\\nodejs",
  ];
  for (const directory of directories.filter(Boolean)) {
    const candidates =
      provider === "claude"
        ? [
            join(directory, "claude.exe"),
            join(
              directory,
              "node_modules",
              "@anthropic-ai",
              "claude-code",
              "bin",
              "claude.exe",
            ),
          ]
        : [
            join(directory, "codex.exe"),
            ...["bin", "codex"].map((folder) =>
              join(
                directory,
                "node_modules",
                "@openai",
                "codex",
                "node_modules",
                "@openai",
                "codex-win32-x64",
                "vendor",
                "x86_64-pc-windows-msvc",
                folder,
                "codex.exe",
              ),
            ),
          ];
    const found = candidates.find(existsSync);
    if (found) return found;
  }
}
export function subscriptionEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      /^(OPENAI_API_KEY|CODEX_API_KEY|OPENAI_BASE_URL|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDECODE|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY)$/i.test(
        key,
      )
    )
      delete env[key];
  }
  return env;
}
export function cliArgs(provider: LocalProvider, model: string): string[] {
  if (provider === "claude")
    return [
      "-p",
      "--output-format",
      "json",
      "--tools",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--setting-sources",
      "",
      "--settings",
      '{"disableAllHooks":true}',
      "--disable-slash-commands",
      "--no-session-persistence",
      ...(model ? ["--model", model] : []),
    ];
  return [
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--json",
    "--color",
    "never",
    "-c",
    'forced_login_method="chatgpt"',
    "-c",
    'approval_policy="never"',
    "-c",
    'web_search="disabled"',
    "-c",
    "features.shell_tool=false",
    "-c",
    "features.multi_agent_v2=false",
    "-c",
    "agents.enabled=false",
    "-c",
    "skills.include_instructions=false",
    "-c",
    "project_doc_max_bytes=0",
    ...(model ? ["--model", model] : []),
    "-",
  ];
}
export async function runCli(
  provider: LocalProvider,
  args: string[],
  input: string,
  cwd: string,
  signal?: AbortSignal,
  timeout = 180000,
): Promise<string> {
  const executable = findCli(provider);
  if (!executable)
    throw new Error(`未找到本机 ${provider} CLI，请先安装并登录，再重启应用`);
  if (signal?.aborted) throw new Error("任务已取消");
  return new Promise((resolveResult, reject) => {
    const child = spawn(/* turbopackIgnore: true */ executable, args, {
      cwd,
      env: subscriptionEnv(),
      windowsHide: true,
      shell: false,
      stdio: "pipe",
    });
    child.stdout.setEncoding("utf8");
    let output = "",
      failure: Error | undefined;
    const stop = (message: string) => {
      failure = new Error(message);
      child.kill();
    };
    const abort = () => stop("任务已取消");
    const timer = setTimeout(
      () => stop(`${provider} 调用超时，请稍后重试`),
      timeout,
    );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (data) => {
      output += String(data);
      if (output.length > 4 * 1024 * 1024) stop("CLI 输出超出限制");
    });
    child.stderr.resume(); // Never expose CLI diagnostics containing local auth/context.
    child.stdin.on("error", () => {});
    child.on("error", () => {
      failure = new Error(`${provider} 启动失败，请检查本机安装`);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new Error(
            `${provider} 请求失败，请检查 CLI 登录、套餐额度、模型权限及网络；未回退到 DeepSeek`,
          ),
        );
      else resolveResult(output);
    });
    child.stdin.end(input);
  });
}
export function parseCliReply(provider: LocalProvider, output: string) {
  if (provider === "claude") {
    const result = JSON.parse(output);
    if (result.is_error || result.type !== "result")
      throw new Error("Claude Code 未成功完成请求，请检查登录及套餐额度");
    return {
      text: result.structured_output
        ? JSON.stringify(result.structured_output)
        : String(result.result ?? ""),
      tokens:
        Number(result.usage?.input_tokens ?? 0) +
        Number(result.usage?.output_tokens ?? 0),
    };
  }
  let text = "",
    tokens = 0,
    complete = false;
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const event = JSON.parse(line);
    if (event.type === "turn.failed" || event.type === "error")
      throw new Error("Codex 未成功完成请求，请检查登录及套餐额度");
    if (event.type === "item.completed" && event.item?.type === "agent_message")
      text = event.item.text;
    if (event.type === "turn.completed") {
      complete = true;
      tokens =
        Number(event.usage?.input_tokens ?? 0) +
        Number(event.usage?.output_tokens ?? 0);
    }
  }
  if (!complete || !text) throw new Error("Codex 未返回完整研究结果");
  return { text, tokens };
}
export async function localCompletion(
  provider: LocalProvider,
  prompt: string,
  model: string,
  signal?: AbortSignal,
) {
  const root = resolve(tmpdir());
  const directory = await mkdtemp(join(root, "quant-llm-"));
  try {
    return parseCliReply(
      provider,
      await runCli(
        provider,
        cliArgs(provider, model),
        prompt,
        directory,
        signal,
      ),
    );
  } finally {
    if (resolve(directory).startsWith(root + sep))
      await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}
