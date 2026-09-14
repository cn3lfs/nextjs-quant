import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

export class WestockError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WestockError";
  }
}

export function westockScriptPath() {
  return join(
    process.env.QUANT_SKILLS_DIR ?? join(homedir(), ".agent-skills", "skills"),
    "westock-data",
    "scripts",
    "index.js",
  );
}

export async function query(
  script: string,
  args: string[],
  signal?: AbortSignal,
  rawOutput = true,
): Promise<unknown> {
  signal?.throwIfAborted();
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/(API_KEY|TOKEN|SECRET|PASSWORD)/i.test(key)) delete env[key];
  const text = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      /* turbopackIgnore: true */ process.execPath,
      [
        ...westockNodeArgs(args),
        script,
        ...args,
        ...(rawOutput ? ["--raw"] : []),
      ],
      {
        env,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "",
      error: Error | undefined;
    const stop = (message: string) => {
      error ??= new Error(message);
      child.kill();
    };
    const abort = () => stop("westock-data 查询已取消");
    const timer = setTimeout(() => stop("westock-data 查询超时"), 20000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 2 * 1024 * 1024) stop("腾讯响应超出限制");
    });
    child.stderr.resume();
    child.on("error", () => {
      error ??= new Error("腾讯查询工具无法启动");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else if (code !== 0) reject(new Error("westock-data 查询失败"));
      else resolve(output);
    });
  });
  signal?.throwIfAborted();
  if (!rawOutput) return text;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("腾讯未返回合法JSON数据");
  }
  const failure = z
    .object({
      success: z.literal(false),
      error: z.object({ code: z.string() }),
    })
    .safeParse(raw);
  if (failure.success)
    throw new WestockError(
      failure.data.error.code,
      `腾讯查询失败（${failure.data.error.code}）${failure.data.error.code === "KLINE_001" ? "：当前市场或品种不支持所选分钟周期" : ""}`,
    );
  return raw;
}
function westockNodeArgs(args: string[]) {
  return args[0] === "kline" && args[args.indexOf("--fq") + 1] === "bfq"
    ? ["--import", pathToFileURL(resolve("runtime/westock-preload.mjs")).href]
    : [];
}
