import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { symbolSchema } from "~/lib/domain";
import { isAStock } from "./tdx";
export function parseTencentIdentity(text: string, symbol: string) {
  const rows = text
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith("|"))
    .map((line) =>
      line
        .trim()
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
  const header = rows.findIndex((row) => row.join(",") === "code,name,type");
  if (header < 0) throw new Error("腾讯未返回可验证的股票资料表");
  const matches = rows
    .slice(header + 2)
    .filter(
      (row) => row.length === 3 && row[0] === symbol && row[2] === "GP-A",
    );
  if (
    matches.length !== 1 ||
    !matches[0]![1] ||
    matches[0]![1]!.length > 80 ||
    !isAStock(symbol)
  )
    throw new Error("腾讯代码、市场或 A 股类型无法唯一确认");
  return {
    symbol,
    name: matches[0]![1]!,
    type: "A股" as const,
    market: symbol.slice(0, 2),
  };
}
export async function searchTencentIdentity(
  symbol: string,
  signal?: AbortSignal,
) {
  symbolSchema.parse(symbol);
  if (!isAStock(symbol)) throw new Error("身份核验仅支持 A 股");
  signal?.throwIfAborted();
  const script = join(
    process.env.QUANT_SKILLS_DIR ?? join(homedir(), ".agent-skills", "skills"),
    "westock-data",
    "scripts",
    "index.js",
  );
  const bytes = await readFile(script);
  const sourceHash = createHash("sha256").update(bytes).digest("hex");
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/(API_KEY|TOKEN|SECRET|PASSWORD)/i.test(key)) delete env[key];
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      /* turbopackIgnore: true */ process.execPath,
      [script, "search", symbol.slice(2), "--type", "stock"],
      {
        env,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let text = "",
      failure: Error | undefined;
    const stop = (reason: string) => {
      failure = new Error(reason);
      child.kill();
    };
    const abort = () => stop("身份核验已取消");
    const timer = setTimeout(() => stop("腾讯身份核验超时"), 15000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      text += chunk;
      if (text.length > 1024 * 1024) stop("腾讯搜索输出超出限制");
    });
    child.stderr.resume();
    child.on("error", () => {
      failure = new Error("腾讯 Node 查询工具无法启动");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error("腾讯股票搜索失败"));
      else resolve(text);
    });
  });
  return {
    ...parseTencentIdentity(output, symbol),
    source: "tencent" as const,
    sourceHash,
    checkedAt: Date.now(),
  };
}
