import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { sectorPriceMetrics } from "./sector-price-metrics";

export function sectorIdentity(raw: unknown, industry: string) {
  const rows = z
    .array(z.object({ code: z.string(), name: z.string(), 分类: z.string() }))
    .parse(raw);
  const matches = rows.filter(
    (row) =>
      row.name === industry &&
      row.分类 === "申万一级行业清单" &&
      /^pt01\d{6}$/.test(row.code),
  );
  if (matches.length !== 1)
    throw new Error("未唯一匹配申万一级行业，不能用概念或其他级别板块代替");
  return {
    industry,
    symbol: matches[0]!.code,
    classification: matches[0]!.分类,
  };
}
export async function query(
  script: string,
  args: string[],
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/(API_KEY|TOKEN|SECRET|PASSWORD)/i.test(key)) delete env[key];
  const text = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      /* turbopackIgnore: true */ process.execPath,
      [script, ...args, "--raw"],
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
    const abort = () => stop("行业价格查询已取消");
    const timer = setTimeout(() => stop("腾讯行业数据查询超时"), 20000);
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
      else if (code !== 0) reject(new Error("腾讯行业数据查询失败"));
      else resolve(output);
    });
  });
  signal?.throwIfAborted();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("腾讯未返回合法JSON数据");
  }
}
export type SectorPriceData = Awaited<ReturnType<typeof fetchSectorPrices>>;
export async function fetchSectorPrices(
  names: string[],
  cutoff: number,
  signal?: AbortSignal,
) {
  const industries = z
    .array(z.string().regex(/^[\p{Script=Han}A-Za-z0-9·（）() -]{1,60}$/u))
    .min(1)
    .max(7)
    .parse(names);
  if (
    new Set(industries).size !== industries.length ||
    !Number.isFinite(cutoff) ||
    cutoff > Date.now()
  )
    throw new Error("行业列表或截止时间非法");
  signal?.throwIfAborted();
  const script = join(
    process.env.QUANT_SKILLS_DIR ?? join(homedir(), ".agent-skills", "skills"),
    "westock-data",
    "scripts",
    "index.js",
  );
  const scriptHash = createHash("sha256")
    .update(await readFile(script))
    .digest("hex");
  const mappings: ReturnType<typeof sectorIdentity>[] = [],
    failures: { industry: string; reason: string }[] = [];
  // Search has no batch endpoint; keep two identity lookups in flight at most.
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(2, industries.length) }, async () => {
      while (cursor < industries.length) {
        const industry = industries[cursor++]!;
        try {
          mappings.push(
            sectorIdentity(
              await query(
                script,
                ["search", industry, "--type", "sector", "--limit", "100"],
                signal,
              ),
              industry,
            ),
          );
        } catch (error) {
          signal?.throwIfAborted();
          failures.push({
            industry,
            reason: error instanceof Error ? error.message : "行业身份查询失败",
          });
        }
      }
    }),
  );
  mappings.sort(
    (a, b) => industries.indexOf(a.industry) - industries.indexOf(b.industry),
  );
  failures.sort(
    (a, b) => industries.indexOf(a.industry) - industries.indexOf(b.industry),
  );
  if (new Set(mappings.map((m) => m.symbol)).size !== mappings.length)
    throw new Error("多个行业映射到相同指数，无法确认身份");
  const end = new Date(cutoff + 8 * 3600000).toISOString().slice(0, 10);
  let raw: unknown = [],
    metrics: ReturnType<typeof sectorPriceMetrics> | null = null;
  if (mappings.length) {
    raw = await query(
      script,
      [
        "kline",
        [...mappings.map((m) => m.symbol), "sh000001"].join(","),
        "--period",
        "day",
        "--end",
        end,
        "--limit",
        "32",
        "--fq",
        "bfq",
      ],
      signal,
    );
    metrics = sectorPriceMetrics(
      raw,
      mappings.map((m) => m.symbol),
      cutoff,
    );
  }
  signal?.throwIfAborted();
  return {
    source: "tencent/westock-data" as const,
    fetchedAt: Date.now(),
    cutoff,
    scriptHash,
    mappings,
    failures,
    raw,
    metrics,
  };
}
