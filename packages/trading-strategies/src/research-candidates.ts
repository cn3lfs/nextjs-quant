import {
  strategyObjectSchema,
  type StrategyObjectInput,
} from "./strategy-object.js";

export type ResearchCandidate = {
  strategy: ReturnType<typeof strategyObjectSchema.parse>;
  family: string;
  variant: "atr" | "trailing" | "time";
  runnable: true;
  boundary: string;
};
/** A small declared menu, never a Cartesian search inferred from OOS results. */
export function researchCandidates(
  symbols: readonly string[],
  market: "cn-equity" | "crypto",
): ResearchCandidate[] {
  if (!symbols.length) throw new Error("Candidate universe is empty");
  const families: {
    id: string;
    period: StrategyObjectInput["period"];
    sleeve: string;
    entry: StrategyObjectInput["entry"];
    exit?: StrategyObjectInput["entry"];
    boundary: string;
  }[] =
    market === "cn-equity"
      ? [
          {
            id: "rps-multi",
            period: "day",
            sleeve: "swing",
            entry: {
              kind: "formula",
              source: "选股:RPS20>=80 AND RPS50>=80 AND RPS120>=80;",
            },
            boundary:
              "Frozen eligible local universe cross-sectional backward-adjusted RPS, not complete historical market",
          },
          {
            id: "double-breakout",
            period: "day",
            sleeve: "swing",
            entry: { kind: "double-breakout", side: "entry" },
            boundary: "Existing native price/volume double-breakout rule",
          },
          {
            id: "chan-third-buy",
            period: "day",
            sleeve: "swing",
            entry: { kind: "chan-third-buy", firstIndex: 140 },
            boundary:
              "Serial native worker, fixed origin and prefix observations; firstIndex is bound at capture",
          },
          {
            id: "formula-ma",
            period: "day",
            sleeve: "swing",
            entry: {
              kind: "formula",
              source: "选股:CROSS(MA(C,N1),MA(C,N2));",
              parameters: { N1: 5, N2: 20 },
            },
            exit: {
              kind: "formula",
              source: "选股:CROSS(MA(C,N2),MA(C,N1));",
              parameters: { N1: 5, N2: 20 },
            },
            boundary: "Representative MA cross template",
          },
          {
            id: "formula-range",
            period: "day",
            sleeve: "swing",
            entry: {
              kind: "formula",
              source: "选股:C>REF(HHV(H,N1),1) AND V>MA(V,20);",
              parameters: { N1: 20 },
            },
            boundary: "Representative completed range and volume template",
          },
          {
            id: "formula-pullback",
            period: "day",
            sleeve: "swing",
            entry: {
              kind: "formula",
              source: "选股:CROSS(C,MA(C,10)) AND MA(C,20)>MA(C,60);",
            },
            boundary: "Representative trend pullback template",
          },
          {
            id: "historical-low",
            period: "day",
            sleeve: "low-zone",
            entry: { kind: "historical-low", side: "entry", config: {} },
            exit: { kind: "historical-low", side: "exit", config: {} },
            boundary:
              "Five to ten calendar year low-zone tiers; valuation and temperature confidence disclosed; cycle evaluation",
          },
        ]
      : ["4h", "day", "15m", "1h"].flatMap((period) => {
          const swing = period === "4h" || period === "day";
          const rows: typeof families = [
            {
              id: `range-${period}`,
              period: period as StrategyObjectInput["period"],
              sleeve: swing ? "swing" : "breakout",
              entry: {
                kind: "formula",
                source: "选股:C>REF(HHV(H,N1),1);",
                parameters: { N1: swing ? 40 : 20 },
              },
              boundary:
                "Public spot OHLC only; liquidity is declared current selection, historical delisting completeness unknown",
            },
          ];
          if (swing)
            rows.push({
              id: `dual-ma-${period}`,
              period: period as StrategyObjectInput["period"],
              sleeve: "swing",
              entry: { kind: "dual-ma", fast: 10, slow: 40, side: "entry" },
              exit: { kind: "dual-ma", fast: 10, slow: 40, side: "exit" },
              boundary: "Completed public spot dual-MA; no account endpoints",
            });
          return rows;
        });
  return families.flatMap((family) =>
    (["atr", "trailing", "time"] as const).map((variant) => {
      const long = family.sleeve === "low-zone",
        short = family.sleeve === "breakout";
      const stop: StrategyObjectInput["exit"]["stop"] =
        variant === "atr"
          ? { kind: "atr", period: 14, multiple: long ? 6 : short ? 1.5 : 3 }
          : { kind: "fixed", fraction: long ? 0.25 : short ? 0.02 : 0.08 };
      return {
        family: family.id,
        variant,
        runnable: true as const,
        boundary: family.boundary,
        strategy: strategyObjectSchema.parse({
          id: `r2a-${market}-${family.id}-${variant}`,
          version: 1,
          market,
          period: family.period,
          universe: { kind: "symbols", symbols: [...symbols] },
          entry: family.entry,
          exit: {
            rule: family.exit,
            stop,
            ...(variant === "trailing"
              ? { trailing: long ? 0.3 : short ? 0.02 : 0.1 }
              : {}),
            ...(long
              ? variant === "time"
                ? { maxBars: 756 }
                : {}
              : { maxBars: short ? 8 : family.period === "4h" ? 120 : 20 }),
          },
          sizing: {
            kind: "equal",
            positions: long ? 5 : short ? 3 : 10,
            tranches: long ? 3 : 1,
          },
          sleeve: family.sleeve,
        }),
      };
    }),
  );
}
