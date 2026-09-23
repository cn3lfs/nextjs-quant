import type { DisciplineInput } from "~/lib/research/risk/discipline-counterfactual";
import { runDisciplineGrid } from "~/lib/research/risk/discipline-counterfactual";
import { readGbbq } from "../data-sources/tdx/tdx-gbbq";
import { readTradeReviewSnapshot } from "./trade-review-market";
import { fullLocalCalendarReference } from "../market/data-health";

export type DisciplineSource = Pick<
  DisciplineInput,
  "fills" | "cashFlows" | "openingCash" | "stopCosts"
> & { tdxRoot: string; calendar: string[] };
export async function buildDisciplineSource(
  source: DisciplineSource,
  progress: (phase: string) => void = () => {},
  dependencies = {
    readGbbq,
    readTradeReviewSnapshot,
    fullLocalCalendarReference,
  },
) {
  progress("核对 GBBQ 覆盖");
  const g = await dependencies.readGbbq(source.tdxRoot);
  const coverageEnd =
    [...g.events.values()]
      .flat()
      .map((e) => e.date)
      .sort()
      .at(-1) ?? null;
  const lastFill = source.fills
    .map((f) => f.tradeDate)
    .sort()
    .at(-1);
  if (!lastFill || !coverageEnd || coverageEnd < lastFill)
    throw new Error(
      `GBBQ 覆盖截止日 ${coverageEnd ?? "未知"} 未覆盖末笔成交日 ${lastFill ?? "未知"}，整批不可用`,
    );
  const reference = await dependencies.fullLocalCalendarReference(
    source.tdxRoot,
    source.calendar,
  );
  const dates = [
    ...source.fills.map((f) => f.tradeDate),
    ...source.cashFlows.map((f) => f.flowDate),
  ].sort();
  if (
    !reference.days.length ||
    reference.days[0]! > dates[0]! ||
    reference.days.at(-1)! < dates.at(-1)!
  )
    throw new Error("完整交易日历未覆盖账户区间");
  // Non-trading-day transfers remain on their actual dates; they are never moved.
  const tradingDays = [
    ...new Set([
      ...reference.days.filter((d) => d >= dates[0]! && d <= dates.at(-1)!),
      ...dates,
    ]),
  ].sort();
  const bars: Record<
    string,
    Awaited<ReturnType<typeof readTradeReviewSnapshot>>["bars"]
  > = {};
  const warnings: string[] = [];
  const sources: { security: string; hash: string }[] = [];
  const securities = [
    ...new Set(
      source.fills
        .filter((f) => f.instrument !== "reverseRepo")
        .map((f) => f.symbol ?? f.code),
    ),
  ];
  for (const [i, security] of securities.entries()) {
    progress(`读取日线 ${i + 1}/${securities.length}`);
    try {
      const snapshot = await dependencies.readTradeReviewSnapshot(
        source.tdxRoot,
        security,
      );
      if (snapshot.priceScale?.trusted === false)
        throw new Error(snapshot.priceScale.reason ?? "价格口径不可信");
      bars[security] = snapshot.bars.filter(
        (b) => b.date >= dates[0]! && b.date <= dates.at(-1)!,
      );
      sources.push({ security, hash: snapshot.hash });
    } catch (e) {
      warnings.push(
        `${security}：${e instanceof Error ? e.message : String(e)}；缺日线不判定止损`,
      );
    }
  }
  const input: DisciplineInput = {
    fills: source.fills,
    cashFlows: source.cashFlows,
    openingCash: source.openingCash,
    stopCosts: source.stopCosts,
    tradingDays,
    bars,
    coverageEnd,
    exRightsEvents: [...g.events].flatMap(([security, events]) =>
      events
        .filter((e) => [1, 11, 12].includes(e.category))
        .map((e) => ({ security, date: e.date })),
    ),
  };
  return {
    input,
    sources,
    warnings,
    calendar: { source: reference.source, hash: reference.hash },
    gbbq: { path: g.path, modified: g.modified, coverageEnd },
  };
}
export async function calculateDiscipline(
  source: DisciplineSource,
  progress: (phase: string) => void = () => {},
) {
  const evidence = await buildDisciplineSource(source, progress);
  progress("计算 20 点网格");
  const result = runDisciplineGrid(evidence.input);
  return { result, evidence };
}
