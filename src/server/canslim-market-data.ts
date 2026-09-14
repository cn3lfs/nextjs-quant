import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  westockKlines,
  requireWestockRows,
  WESTOCK_ADAPTER_VERSION,
} from "./westock-adapter";
import { completedBar } from "./screening";
import { canslimMarket } from "./canslim-market";
import { evidenceEnvelope } from "./evidence";
import { sharedRead } from "./shared-read";
import type { Snapshot } from "~/lib/domain";

const row = z
  .object({
    symbol: z.enum(["sh000300", "sh000001"]),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine(
        (d) =>
          Number.isFinite(Date.parse(d)) &&
          new Date(d).toISOString().slice(0, 10) === d,
      ),
    open: z.number().finite().positive(),
    last: z.number().finite().positive(),
    high: z.number().finite().positive(),
    low: z.number().finite().positive(),
    volume: z.number().finite().nonnegative(),
    amount: z.number().finite().nonnegative(),
  })
  .refine(
    (b) =>
      b.high >= Math.max(b.open, b.last, b.low) &&
      b.low <= Math.min(b.open, b.last),
  );

export function parseCanslimMarket(
  raw: unknown,
  cutoff: number,
  fetchedAt: number,
) {
  if (
    !Number.isFinite(cutoff) ||
    !Number.isFinite(fetchedAt) ||
    cutoff > fetchedAt
  )
    throw new Error("指数截止时间非法");
  const rows = z.array(row).max(520).parse(raw);
  const seen = new Set<string>();
  for (const item of rows) {
    const key = `${item.symbol}:${item.date}`;
    if (seen.has(key)) throw new Error("指数日期重复");
    seen.add(key);
  }
  const bars = rows
    .filter(
      (b) => b.symbol === "sh000300" && completedBar(b.date, "day", cutoff),
    )
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((b) => ({
      date: b.date,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.last,
      volume: b.volume,
      amount: b.amount,
    }));
  if (!bars.length) throw new Error("未返回沪深300已完成日线");
  const envelope = evidenceEnvelope(bars, {
    source: "tencent/westock-data",
    symbol: "sh000300",
    type: "bars",
    asOf: bars.at(-1)!.date,
    publishedAt: null,
    fetchedAt,
    currency: null,
    unit: {
      price: "点",
      volume: "源单位未独立核验",
      amount: "源单位未独立核验",
    },
    adjustment: "none",
    reportPeriod: null,
    quality: "partial",
    warnings: [
      "当前获取的历史指数序列，不能证明历史时点可用。",
      "指数点位不是股票价格；仅使用同源成交量相对比较，交易日完整性与源时效尚未核验。",
    ],
  });
  const hash = createHash("sha256")
    .update(JSON.stringify({ cutoff, envelope }))
    .digest("hex");
  const snapshot: Snapshot = {
    id: `canslim-index-${hash}`,
    hash,
    symbol: "sh000300",
    period: "day",
    source: envelope.source,
    adjustment: "none",
    createdAt: fetchedAt,
    bars,
  };
  return { envelope, snapshot, diagnostic: canslimMarket(snapshot, cutoff) };
}
const shared = sharedRead<
  ReturnType<typeof parseCanslimMarket> & { scriptHash: string }
>();
export function gatherCanslimMarket(cutoff: number, signal?: AbortSignal) {
  if (!Number.isFinite(cutoff) || cutoff > Date.now())
    throw new Error("指数截止时间非法");
  return shared(
    String(cutoff),
    async (upstream) => {
      const script = join(
        process.env.QUANT_SKILLS_DIR ??
          join(homedir(), ".agent-skills", "skills"),
        "westock-data",
        "scripts",
        "index.js",
      );
      const scriptHash = createHash("sha256")
        .update(await readFile(script))
        .update(WESTOCK_ADAPTER_VERSION)
        .digest("hex");
      // Batch output includes symbol; single-symbol CLI output does not.
      const raw = requireWestockRows(
        await westockKlines(
          {
            symbols: ["sh000300", "sh000001"],
            period: "day",
            end: new Date(cutoff + 8 * 3600000).toISOString().slice(0, 10),
            limit: 260,
          },
          upstream,
        ),
      );
      upstream.throwIfAborted();
      return { ...parseCanslimMarket(raw, cutoff, Date.now()), scriptHash };
    },
    signal,
  );
}
