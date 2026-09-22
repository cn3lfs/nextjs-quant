import { createHash } from "node:crypto";
import type { Bar } from "~/lib/domain";
import type { CzscResult } from "~/lib/czsc";
import type { LedgerSignal } from "~/lib/signal-ledger";
import type { BreakoutPoint } from "../strategies/breakout/breakout";

export const ledgerHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Only observation bookkeeping lives here; both engines retain their decisions. */
export function ledgerSignals(
  symbol: string,
  date: string,
  bars: readonly Bar[],
  czsc: CzscResult,
  breakout: BreakoutPoint | null,
  previous: { keys: string[] } | undefined,
) {
  const snapshotHash = ledgerHash({
    source: "tdx-local",
    adjustment: "none",
    symbol,
    bars,
  });
  const common = {
    symbol,
    observedDate: date,
    snapshotHash,
    source: "tdx-local" as const,
  };
  const signals: LedgerSignal[] = [];
  const keys = new Set(previous?.keys ?? []);
  for (const family of czsc.families)
    for (const point of family.signals) {
      if (![1, 2, 3].includes(Math.abs(point.kind))) continue;
      const key = `${family.config}:${point.date}:${point.kind}:${point.quality}`;
      const seen = keys.has(key);
      keys.add(key);
      // First observation seeds existing historical endpoints. Quality changes are
      // distinct observations, never edits to a previously recorded signal.
      if (seen || (!previous && point.date !== date)) continue;
      const center = point.centerId ? family.centers[point.centerId - 1] : null;
      signals.push({
        ...common,
        id: ledgerHash(["czsc-ledger-1", symbol, key]),
        strategy: "czsc",
        endpointDate: point.date,
        direction: point.kind > 0 ? "long" : "short",
        quality: String(point.quality),
        score: point.quality,
        evidence: JSON.stringify({
          config: family.config,
          point,
          center: center ?? null,
        }),
        invalidation:
          Math.abs(point.kind) === 3 && center
            ? `${point.kind > 0 ? `回试低点跌破ZG ${center.ZG}` : `回抽高点升破ZD ${center.ZD}`}，或原买卖点撤销/质量降为观察`
            : "原买卖点撤销、质量降为观察，或其关联中枢/背驰结构不再成立",
        strategyVersion: `czsc-ledger-1/${czsc.sourceCommit}`,
        dllVersion: czsc.hash,
      });
    }
  if (breakout?.date === date)
    for (const side of [breakout.long, breakout.short]) {
      if (side.status !== "是") continue;
      signals.push({
        ...common,
        id: ledgerHash(["dual-breakout-1", symbol, date, side.direction]),
        strategy: "dual-breakout",
        endpointDate: date,
        direction: side.direction,
        quality: side.quality,
        score: side.score ?? 0,
        evidence: JSON.stringify(side),
        invalidation: side.risk.stop
          ? `${side.direction === "long" ? "跌破" : "升破"}结构位 ${side.risk.stop.price}，或突破条件不再成立`
          : "结构失效位未知；突破条件不再成立",
        strategyVersion: "dual-breakout-1",
        dllVersion: null,
      });
    }
  return { signals, keys: [...keys].sort() };
}
