import type { Bar } from "~/lib/domain";
import {
  horizons,
  ledgerOutcome,
  type ActionEvidence,
} from "~/lib/signal-ledger";
import { analyzeBreakout } from "./breakout";
import { ledgerSignals } from "./signal-ledger-engine";
import {
  bonusAdjustedSignals,
  type ResearchAdjustmentInput,
} from "./bonus-adjusted-signals";

export const signalBacktestDisclaimer =
  "回溯研究，信号规则与参数为当前版本，存在事后视角；非前向台账结果，不构成可交易结论";

export type SignalBacktestInput = ResearchAdjustmentInput & {
  symbol: string;
  bars: Bar[];
  start: string;
  end: string;
  days: string[];
  calendarSource: string;
  actions: ActionEvidence;
  completedThrough: string;
};

/** W7 only projects existing engines; it never opens a ledger store. */
export function retrospectiveSignals(input: SignalBacktestInput) {
  const bars = input.bars.filter((b) => b.date <= input.completedThrough);
  // W1 rejects the entire input, including warmup, before selecting dates.
  const adjusted =
    input.adjustment === "backward"
      ? bonusAdjustedSignals(bars, input.corporateActions)
      : null;
  const signalBars = adjusted?.bars ?? bars;
  const from = bars.findIndex((b) => b.date >= input.start);
  if (from < 0) return { evaluated: 0, points: [], rows: [] };
  // `from` limits output, preserving full-history recursive indicator seeds.
  const points = analyzeBreakout(signalBars, from).points.filter(
    (p) => p.date <= input.end && input.days.includes(p.date),
  );
  const rows = points
    .filter((p) => p.long.status === "是" || p.short.status === "是")
    .flatMap((point) =>
      ledgerSignals(
        input.symbol,
        point.date,
        bars.slice(0, point.index + 1),
        {
          status: "no-structure",
          hash: "",
          sourceCommit: "b67f3c6",
          families: [],
        },
        point,
        undefined,
      ).signals.map((signal) => ({
        ...signal,
        outcomes: horizons.map((horizon) =>
          ledgerOutcome(
            signal,
            horizon,
            bars,
            input.days,
            input.calendarSource,
            input.actions,
            input.completedThrough,
          ),
        ),
      })),
    );
  return { evaluated: points.length, points, rows };
}
