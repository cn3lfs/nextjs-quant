import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { signalInformation } from "~/lib/signal-information";
import { horizons, aggregateLedger, type LedgerRow } from "~/lib/signal-ledger";
import { SignalInformationView } from "~/components/signals/signal-information-view";
function rows(
  values: number[],
  date = "2026-01-01",
  direction: "long" | "short" = "long",
): LedgerRow[] {
  return values.map((value, i) => ({
    id: `${date}-${direction}-${i}`,
    symbol: `${direction}-${i}`,
    strategy: "czsc",
    direction,
    observedDate: date,
    endpointDate: date,
    quality: "1",
    score: i + 1,
    evidence: "",
    invalidation: "",
    snapshotHash: "fixture",
    strategyVersion: "fixture",
    dllVersion: null,
    source: "tdx-local",
    outcomes: horizons.map((horizon) => ({
      horizon,
      settled: true,
      entryDate: date,
      exitDate: date,
      entry: 100,
      exit: 100 + value,
      returnPct: value,
      action: "区间无除权",
      reasons: [],
      calendarSource: "fixture",
      actionSource: "fixture",
    })),
  }));
}
const group = (rs: LedgerRow[]) => signalInformation(rs).groups[0]!;
describe("signal information", () => {
  it("isolates strategies and horizons and preserves negative short spreads", () => {
    const short = rows(
      Array.from({ length: 50 }, (_, i) => -i),
      undefined,
      "short",
    );
    for (const row of short)
      row.outcomes[1]!.returnPct = -row.outcomes[1]!.returnPct!;
    const other = rows(Array.from({ length: 50 }, (_, i) => i)).map((row) => ({
      ...row,
      strategy: "dual-breakout" as const,
    }));
    const result = signalInformation([...short, ...other]);
    expect(result.groups).toHaveLength(6);
    expect(result.decay.find((d) => d.strategy === "czsc")!.decay).toEqual([
      { horizon: 5, icMean: -1, topMinusBottom: -40 },
      { horizon: 10, icMean: 1, topMinusBottom: 40 },
      { horizon: 20, icMean: -1, topMinusBottom: -40 },
    ]);
    expect(
      result.groups
        .filter((g) => g.strategy === "dual-breakout")
        .map((g) => g.icMean),
    ).toEqual([1, 1, 1]);
  });
  it("uses quantile positions rather than score widths and counts zero in win rate", () => {
    const rs = rows(Array.from({ length: 50 }, (_, i) => i));
    rs[49]!.score = 10000;
    const s = group(rs).stratification;
    expect(s.groups.map((g) => g.count)).toEqual([10, 10, 10, 10, 10]);
    expect(s.groups[0]).toMatchObject({
      meanReturn: 4.5,
      medianReturn: 4.5,
      winRate: 90,
      scoreRange: [1, 10],
    });
    const invalid = rows([1, 2, 3, 4, 5, 6]);
    invalid[5]!.score = NaN;
    expect(group(invalid).exclusions.nonFinite).toBe(1);
    expect(group(invalid).valid).toBe(5);
  });
  it("uses average ranks with a hand-calculated tie", () => {
    const rs = rows([1, 3, 2, 5, 4]);
    rs[2]!.score = 2;
    // x ranks=[1,2.5,2.5,4,5], y=[1,3,2,5,4]; centered dot=8.5, squares=9.5 and 10.
    expect(group(rs).daily[0]!.rankIC).toBeCloseTo(8.5 / Math.sqrt(95), 12);
  });
  it("has monotone IC and quantile spread without changing existing aggregation or input", () => {
    const rs = rows(Array.from({ length: 50 }, (_, i) => i));
    const before = structuredClone(rs),
      old = aggregateLedger(rs);
    const g = group(rs);
    expect(g.daily[0]!.rankIC).toBe(1);
    expect(g.stratification.monotonicity).toBe(1);
    expect(g.stratification.topMinusBottom).toBe(40);
    expect(g.stratification.groups.map((g) => g.count)).toEqual([
      10, 10, 10, 10, 10,
    ]);
    expect(rs).toEqual(before);
    expect(aggregateLedger(rs)).toEqual(old);
    expect(signalInformation(rs).decay[0]!.decay.map((d) => d.horizon)).toEqual(
      [5, 10, 20],
    );
  });
  it("computes exactly uncorrelated symmetric ranks", () => {
    // centered x=[-2,-1,0,1,2], y=[-1,2,0,-2,1], dot=0.
    expect(Math.abs(group(rows([2, 5, 3, 1, 4])).icMean!)).toBeLessThan(1e-12);
  });
  it("keeps four-sample sections blank and five-sample sections separate", () => {
    const g = group([
      ...rows([1, 2, 3, 4]),
      ...rows([1, 2, 3, 4, 5], "2026-01-02"),
    ]);
    expect(g.sections).toEqual({ valid: 1, total: 2 });
    expect(g.daily[0]).toMatchObject({ rankIC: null, reason: "截面样本不足" });
    expect(g.daily[1]!.rankIC).toBe(1);
  });
  it("separates directions and never reverses short price returns", () => {
    const result = signalInformation([
      ...rows([1, 2, 3, 4, 5]),
      ...rows([-1, -2, -3, -4, -5], undefined, "short"),
    ]);
    expect(result.groups).toHaveLength(6);
    expect(
      result.groups.filter((g) => g.direction === "long").map((g) => g.icMean),
    ).toEqual([1, 1, 1]);
    expect(
      result.groups.filter((g) => g.direction === "short").map((g) => g.icMean),
    ).toEqual([-1, -1, -1]);
    expect(Object.keys(result).sort()).toEqual(["decay", "groups"]);
  });
  it("excludes all categories with overlapping reason counts and missing outcomes", () => {
    const rs = rows([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    rs[5]!.outcomes[0]!.action = "含除权，收益不可比";
    rs[6]!.outcomes[0]!.settled = false;
    rs[6]!.outcomes[0]!.returnPct = null;
    rs[6]!.outcomes[0]!.reasons = ["未到期"];
    rs[7]!.outcomes[0]!.returnPct = null;
    rs[7]!.outcomes[0]!.reasons = ["停牌", "缺价格", "停牌"];
    rs[8]!.outcomes = [];
    const g = group(rs);
    expect(g.valid).toBe(5);
    expect(g.icMean).toBe(1);
    expect(g.exclusions).toEqual({
      duplicate: 0,
      unsettled: 1,
      nullReturn: 2,
      corporateAction: 1,
      missingOutcome: 1,
      nonFinite: 0,
      reasons: { 未到期: 1, 停牌: 1, 缺价格: 1, 等待回填: 1 },
    });
  });
  it("deduplicates by smallest ID before eligibility, across directions", () => {
    const rs = rows([1, 2, 3, 4, 5]);
    const copy = {
      ...rs[0]!,
      id: "000",
      direction: "short" as const,
      outcomes: [],
    };
    const result = signalInformation([...rs, copy]);
    expect(
      result.groups.find((g) => g.direction === "long")!.exclusions.duplicate,
    ).toBe(1);
    expect(result.groups.find((g) => g.direction === "long")!.valid).toBe(4);
    expect(result).toEqual(signalInformation([copy, ...rs]));
  });
  it("downgrades Q and blanks insufficient samples", () => {
    expect(
      group(rows(Array.from({ length: 40 }, (_, i) => i))).stratification.q,
    ).toBe(3);
    const s = group(
      rows(Array.from({ length: 20 }, (_, i) => i)),
    ).stratification;
    expect(s.groups).toEqual([]);
    expect(s.reason).toContain("样本不足");
    expect(s.topMinusBottom).toBeNull();
  });
  it("moves an entire tie into the lower quantile and leaves empty bins blank", () => {
    const rs = rows(Array.from({ length: 50 }, (_, i) => i));
    rs.forEach((r, i) => {
      r.score = i < 25 ? 1 : i;
    });
    const s = group(rs).stratification;
    expect(s.tiedBoundary).toBe(true);
    expect(s.groups.map((g) => g.count)).toEqual([25, 0, 5, 10, 10]);
    expect(s.groups[1]!.meanReturn).toBeNull();
    expect(s.monotonicity).toBeNull();
  });
  it("uses sample std and computes a small-k t statistic with warning", () => {
    const g = group([
      ...rows([1, 2, 3, 4, 5]),
      ...rows([2, 5, 3, 1, 4], "2026-01-02"),
    ]);
    // IC=[1,0], mean=.5, sample variance=.5, t=.5/(sqrt(.5)/sqrt(2))=1.
    expect(g.icStd).toBeCloseTo(Math.sqrt(0.5), 12);
    expect(g.icTStat).toBeCloseTo(1, 12);
    expect(g.reasons).toContain("截面数不足，t 值不可靠");
    expect(g.positiveRatio).toBe(0.5);
  });
  it("leaves undefined statistics blank for constant scores, returns and ICs", () => {
    expect(group(rows([1, 1, 1, 1, 1])).daily[0]!.reason).toBe(
      "截面内取值无差异",
    );
    const rs = rows([1, 2, 3, 4, 5]);
    rs.forEach((r) => {
      r.score = 1;
    });
    expect(group(rs).icMean).toBeNull();
    expect(group(rows([1, 2, 3, 4, 5])).icTStat).toBeNull();
    const g = group([
      ...rows([1, 2, 3, 4, 5]),
      ...rows([1, 2, 3, 4, 5], "2026-01-02"),
    ]);
    expect(g.icStd).toBe(0);
    expect(g.icir).toBeNull();
    expect(g.reasons).toContain("IC标准差为零，ICIR与t值留空");
    expect(signalInformation([])).toEqual({ groups: [], decay: [] });
  });
  it("renders one server-selected direction with visible exclusions and all three tables", () => {
    const rs = [
      ...rows([1, 2, 3, 4, 5]),
      ...rows([-1, -2, -3, -4], undefined, "short"),
    ];
    const html = renderToStaticMarkup(
      createElement(SignalInformationView, { rows: rs, page: 2 }),
    );
    for (const label of [
      "IC汇总",
      "评分分层",
      "持有期衰减三点",
      "排除计数与原因",
      "价格变化方向，不是做空收益",
      "截面样本不足",
    ])
      expect(html).toContain(label);
    expect(html).toContain("上一页");
    expect(html).not.toContain("下一页");
    expect(html).not.toContain("缠论 · 向上");
  });
});
