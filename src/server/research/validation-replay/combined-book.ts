import { runPortfolio, type PortfolioRequest } from "quant-backtest";
import { evaluatePerformance } from "quant-performance";
import {
  type FrozenValidationInput,
  type ValidationDataset,
} from "../validation-capture";
import { type ScoreboardRow } from "../validation-model";
import { scoreValidationResult } from "./scoring";
import { validationBiasTags, biasLabels } from "./bias";

export function combinedBook(
  frozen: FrozenValidationInput,
  dataset: ValidationDataset,
  primary: PortfolioRequest,
  secondary?: PortfolioRequest,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const benchmarkBasis = dataset.benchmarkBasis ?? null;
  const shares = frozen.input.market === "cn-equity" ? [1, 0.65] : [0.75, 0.8];
  const variants = shares.map((share, index) => {
    signal?.throwIfAborted();
    const strategies = [
      ...primary.strategies,
      ...(secondary?.strategies ?? []),
    ];
    const instruments = primary.instruments.map((p) => {
      signal?.throwIfAborted();
      const other = secondary?.instruments.find((s) => s.symbol === p.symbol);
      return {
        ...p,
        external: {
          ...p.external,
          signals: [
            ...(p.external?.signals ?? []),
            ...(other?.external?.signals ?? []),
          ],
          levels: [
            ...(p.external?.levels ?? []),
            ...(other?.external?.levels ?? []),
          ],
        },
      };
    });
    const low = combinedLowZoneTargets(frozen, primary, signal);
    const sleeves = [
      { ...primary.sleeves[0]!, share: secondary ? share : 1 },
      ...(secondary ? [{ ...secondary.sleeves[0]!, share: 1 - share }] : []),
    ];
    const request: PortfolioRequest = {
      ...primary,
      strategies,
      memberships: [
        ...(primary.memberships ?? []),
        ...(secondary?.memberships ?? []),
      ],
      instruments,
      sleeves,
      rebalance: { everyBars: 20, drift: 0.05 },
      ...(secondary && index === 0 && frozen.input.market === "cn-equity"
        ? { sleeveTargets: low }
        : {}),
    };
    const result = runPortfolio(request, undefined, undefined, signal);
    const score = scoreValidationResult(result, request, dataset);
    const valuation = score.valuation;
    // A stale mark can change cash transfers and every sleeve's funded path.
    const transfers = valuation
      ? result.transfers.filter(({ date }) =>
          valuation.positions.every((gap) => date < gap.unavailableFrom),
        )
      : result.transfers;
    const transfersBySleeve = new Map<string, Map<string, number>>();
    for (const transfer of transfers) {
      signal?.throwIfAborted();
      const dates =
        transfersBySleeve.get(transfer.sleeve) ?? new Map<string, number>();
      dates.set(
        transfer.date,
        (dates.get(transfer.date) ?? 0) + transfer.amount,
      );
      transfersBySleeve.set(transfer.sleeve, dates);
    }
    const sleeveScores = sleeves.map((s) => {
      if (valuation)
        return {
          sleeve: s.id,
          daily: score.daily,
          observed: 0,
          return: null,
          drawdown: null,
          valuation,
        };
      // Remove cash transfers before computing sleeve time-weighted returns.
      let previous = frozen.input.initial * s.share;
      const byDay = new Map<string, number[]>();
      for (const point of result.curve) {
        signal?.throwIfAborted();
        const current = point.sleeves.find((r) => r.id === s.id)!.equity;
        const transfer = transfersBySleeve.get(s.id)?.get(point.date) ?? 0;
        const value = previous > 0 ? (current - transfer) / previous - 1 : null;
        previous = current;
        const day = point.date.slice(0, 10),
          values = byDay.get(day) ?? [];
        if (value !== null) values.push(value);
        byDay.set(day, values);
      }
      const daily = result.equity.map((p) => {
        const values = byDay.get(p.date)!;
        return values.length
          ? values.reduce((v, r) => v * (1 + r), 1) - 1
          : null;
      });
      let nav = 1;
      const active = daily.flatMap((value, i) =>
        value === null
          ? []
          : [{ date: result.equity[i]!.date, value: (nav *= 1 + value) }],
      );
      const evaluation = evaluatePerformance(
        1,
        active,
        active[0]?.date,
        frozen.input.market === "crypto" ? 365 : 252,
      );
      return {
        sleeve: s.id,
        daily,
        observed: active.length,
        return: evaluation.totalReturn.value,
        drawdown: evaluation.maxDrawdown.value,
      };
    });
    const a = sleeveScores[0]?.daily ?? [],
      b = sleeveScores[1]?.daily ?? [];
    const pairs = a.flatMap((v, i) =>
      v !== null && b[i] != null ? [[v, b[i]!] as const] : [],
    );
    const meanA = pairs.reduce((n, p) => n + p[0], 0) / pairs.length,
      meanB = pairs.reduce((n, p) => n + p[1], 0) / pairs.length;
    const covariance = pairs.reduce(
      (n, p) => n + (p[0] - meanA) * (p[1] - meanB),
      0,
    );
    const denominator = Math.sqrt(
      pairs.reduce((n, p) => n + (p[0] - meanA) ** 2, 0) *
        pairs.reduce((n, p) => n + (p[1] - meanB) ** 2, 0),
    );
    return {
      name: index === 0 ? "default" : "comparison",
      shares: Object.fromEntries(sleeves.map((s) => [s.id, s.share])),
      score,
      sleeveScores,
      correlation:
        pairs.length >= 20 && denominator > 0 ? covariance / denominator : null,
      overlapDays: pairs.length,
      transfers,
      sleeveCurves: valuation
        ? null
        : result.equity.map((p) => ({
            date: p.date,
            sleeves: p.sleeves,
          })),
    };
  });
  const rows: ScoreboardRow[] = variants.map((v) => ({
    benchmarkBasis,
    riskAdjusted: v.score.riskAdjusted,
    biasTags: validationBiasTags(frozen),
    id: `book-${frozen.input.market}-${dataset.period}-${v.name}`,
    market: frozen.input.market,
    level: "market",
    sleeve: "combined",
    rule: `${dataset.period} fixed predeclared presets / ${v.name}`,
    status: "research",
    return: v.score.return,
    excess: v.score.excess,
    drawdown: v.score.drawdown,
    trades: v.score.trades,
    oosWindows: 0,
    positiveWindows: 0,
    bias: biasLabels(frozen, "combined"),
    reasons: [
      "descriptive-full-period-book-not-independent-oos",
      ...(v.score.valuation?.positions.map(
        ({ symbol, sleeve, unavailableFrom, reason }) =>
          `terminal-valuation-blocked: ${symbol}/${sleeve} from ${unavailableFrom}: ${reason}`,
      ) ?? []),
    ],
  }));
  for (const sleeve of variants[0]!.sleeveScores) {
    rows.push({
      ...rows[0]!,
      id: `sleeve-${frozen.input.market}-${dataset.period}-${sleeve.sleeve}`,
      level: "sleeve",
      sleeve: sleeve.sleeve,
      bias: biasLabels(frozen, sleeve.sleeve),
      return: sleeve.return,
      excess: null,
      drawdown: sleeve.drawdown,
      reasons: sleeve.valuation
        ? rows[0]!.reasons
        : [
            "transfer-adjusted-conditional-sleeve-returns",
            "inactive-days-excluded-not-zero-filled",
          ],
    });
  }
  return {
    market: frozen.input.market,
    period: dataset.period,
    benchmarkBasis,
    variants,
    rows,
    boundary:
      frozen.input.market === "crypto"
        ? "4h swing + 1h breakout on the shared 15m execution clock; 75/25 vs 80/20; completed native-timeframe decisions only, stops monitored every 15m. Time stops scaled by interval duration."
        : "Index or eligible stock low-zone 0/30/35/40 vs static 65/35. Only idle cash rebalances; holdings are never forced closed.",
  };
}

export function combinedLowZoneTargets(
  frozen: FrozenValidationInput,
  primary: PortfolioRequest,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const symbols = new Set([
    "sh000300",
    ...primary.instruments.map((i) => i.symbol),
  ]);
  const events = frozen.lowZones
    .filter((l) => symbols.has(l.symbol))
    .flatMap((l) => l.observations.map((o) => ({ ...o, symbol: l.symbol })))
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol),
    );
  const state = new Map<string, number>();
  const targets: NonNullable<PortfolioRequest["sleeveTargets"]>[number][] = [];
  let cursor = 0;
  for (const date of primary.calendar) {
    signal?.throwIfAborted();
    while (events[cursor] && events[cursor]!.date <= date) {
      const e = events[cursor++]!;
      state.set(e.symbol, e.targetShare);
    }
    for (const member of frozen.universe?.members ?? [])
      if (member.delistingDate && member.delistingDate <= date)
        state.delete(member.symbol);
    const share = Math.max(0, ...state.values());
    targets.push({
      date,
      availableAt: date,
      shares: { swing: 1 - share, "low-zone": share },
    });
  }
  return targets;
}
