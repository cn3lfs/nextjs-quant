import { expect, it } from "vitest";
import type { Bar } from "../src/lib/domain";
import {
  researchSpecSchema,
  type ResearchEvent,
} from "../src/lib/strategy-research";
import { researchManagementSchema } from "../src/lib/research-management";
import { researchPortfolio } from "../src/server/research-portfolio";
import { researchMethodSnapshot } from "../src/server/research-method";
import { swingPositionTemplate } from "../src/components/research-strategy-fields";
const dates = ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05"];
const symbols = ["sh600000", "sh600001", "sh600002", "sh600003"];
const rules = {
  evidence: "fixture",
  minimumBuy: 100,
  buyStep: 100,
  maximumOrder: 100000,
  minimumSell: 100,
  sellStep: 100,
  maximumSell: 100000,
  sellOddLotAll: true,
  tradable: true,
  limitUp: null,
  limitDown: null,
};
const base = researchSpecSchema.parse({
  strategy: "dual-breakout",
  start: dates[0],
  end: dates[3],
  validationStart: dates[3],
  initialCapital: 100000,
  maxPositions: 5,
  holdingDays: 60,
  risk: { fraction: 0.1, maxWeight: 1 },
  management: { stop: { kind: "percent", fraction: 0.03 } },
  costs: {
    commissionBps: 0,
    minimumCommission: 0,
    sellTaxBps: 0,
    slippageBps: 0,
  },
});
function bars(open = 50): Bar[] {
  return dates.map((date) => ({
    date,
    open,
    close: open,
    high: open + 1,
    low: open - 1,
    volume: 10000,
    amount: 500000,
  }));
}
const events: ResearchEvent[] = symbols.map((symbol) => ({
  symbol,
  observedDate: dates[0]!,
  endpointDate: dates[0]!,
  strategyVersion: "fixture",
  key: symbol,
  evidence: "{}",
  partition: "development",
  initialStop: 47.5,
}));
function run(spec = base, input = bars(), selected = events) {
  return researchPortfolio(
    spec,
    selected,
    dates,
    new Map(symbols.map((s) => [s, input])),
    () => rules,
  );
}
it("enforces two 30% holdings under the 60% cap without pyramiding or future-close sizing", () => {
  const spec = researchSpecSchema.parse(swingPositionTemplate(base)),
    input = bars();
  input[1]!.close = 100;
  input[1]!.high = 101;
  const result = run(spec, input);
  expect(result.trades.map((t) => [t.event.symbol, t.quantity])).toEqual([
    [symbols[0], 600],
    [symbols[1], 600],
  ]);
  expect(
    result.attempts.some((a) => a.side === "buy" && a.reason.includes("预算")),
  ).toBe(true);
  expect(result.trades.every((t) => t.exitDate === null)).toBe(true);
});
it("preserves the legacy budget when limits are omitted and includes fees within the new cap", () => {
  expect(base.management).not.toHaveProperty("maxTotalWeight");
  expect(run(base, bars(), events.slice(0, 1)).trades[0]!.quantity).toBe(2000);
  const spec = researchSpecSchema.parse({
    ...base,
    management: { ...base.management, maxTotalWeight: 0.6 },
    costs: { ...base.costs, minimumCommission: 5 },
  });
  const result = run(spec, bars(), events.slice(0, 1)),
    trade = result.trades[0]!;
  expect(trade.quantity).toBe(1100);
  expect(trade.quantity * trade.entryPrice).toBeLessThanOrEqual(
    0.6 * (100000 - trade.entryCost + trade.quantity * trade.entryPrice),
  );
});
it("accepts exactly 5% structure distance but rejects a wider real entry gap without clamping the stop", () => {
  const spec = researchSpecSchema.parse({
    ...base,
    management: {
      ...base.management,
      stop: { kind: "structure", buffer: 0 },
      maxInitialStopDistance: 0.05,
    },
  });
  const accepted = run(spec, bars(50), events.slice(0, 1));
  expect(accepted.trades[0]!.initialStop).toBe(47.5);
  for (const open of [50.0001, 60]) {
    const rejected = run(spec, bars(open), events.slice(0, 1));
    expect(rejected.trades).toEqual([]);
    expect(rejected.excluded[0]!.reason).toContain("初始止损距离超过");
  }
  const missing = run(spec, bars(), [{ ...events[0]!, initialStop: null }]);
  expect(missing.trades).toEqual([]);
  expect(missing.excluded[0]!.reason).toContain("止损输入缺失");
});
it("applies the cap to initial plans and later pyramids using the smaller of both limits", () => {
  const spec = researchSpecSchema.parse({
    ...base,
    management: {
      ...base.management,
      maxTotalWeight: 0.2,
      pyramid: { kind: "r-50-30-20", maxTotalWeight: 0.6 },
    },
  });
  const input = bars();
  input[1]!.close = 100;
  input[1]!.high = 101;
  for (const i of [2, 3])
    Object.assign(input[i]!, { open: 100, close: 100, high: 101, low: 99 });
  const trade = run(spec, input, events.slice(0, 1)).trades[0]!;
  expect(trade.entries![0]!.quantity).toBe(200);
  expect(trade.entries).toHaveLength(1);
  const tighter = researchSpecSchema.parse({
    ...spec,
    management: {
      ...spec.management,
      maxTotalWeight: 0.6,
      pyramid: { kind: "r-50-30-20", maxTotalWeight: 0.2 },
    },
  });
  expect(run(tighter, input, events.slice(0, 1)).trades[0]!.entries).toEqual(
    trade.entries,
  );
});
it("templates preserve the selected stop and exits, constrain position count and validate boundary values", () => {
  const before = researchSpecSchema.parse({
      ...base,
      management: { ...base.management, timeExit: { days: 5, minR: 0.5 } },
    }),
    copy = structuredClone(before);
  const result = swingPositionTemplate(before);
  expect(before).toEqual(copy);
  expect(result.risk).toEqual({ fraction: 0.02, maxWeight: 0.3 });
  expect(result.maxPositions).toBe(3);
  expect(result.management!.stop).toEqual(before.management!.stop);
  expect(result.management!.timeExit).toEqual(before.management!.timeExit);
  for (const invalid of [0, -0.1, NaN, Infinity, 1.1])
    expect(
      researchManagementSchema.safeParse({
        ...result.management,
        maxTotalWeight: invalid,
      }).success,
    ).toBe(false);
  expect(
    researchManagementSchema.safeParse({
      ...result.management,
      maxInitialStopDistance: 0.6,
    }).success,
  ).toBe(false);
  const spec = researchSpecSchema.parse({
    ...result,
    risk: { fraction: 0.1, maxWeight: 0.1 },
    management: { ...result.management, maxTotalWeight: 1 },
  });
  expect(run(spec).trades).toHaveLength(3);
});
it("pins new limit semantics only when configured", () => {
  expect(researchMethodSnapshot(base)).not.toHaveProperty("entryLimits");
  const method = researchMethodSnapshot(swingPositionTemplate(base));
  expect(method.entryLimits!.version).toBe("research-entry-limits-1");
  expect(method.sources.map((r) => r.path)).toContain(
    "swing-trader/references/position-management.md",
  );
});
