import { expect, it } from "vitest";
import {
  swingDisciplineIds,
  swingDisciplineTemplate,
  swingRewardAdmission,
  type SwingDisciplineId,
} from "../src/lib/research-swing-discipline";
import {
  researchInitialStop,
  researchManagementSchema,
} from "../src/lib/research-management";
import { researchPortfolio } from "../src/server/research-portfolio";
import {
  researchSpecSchema,
  type ResearchEvent,
} from "../src/lib/strategy-research";
import {
  applyResearchManagement,
  selectResearchStrategy,
} from "../src/components/research-strategy-fields";
import { researchMethodSnapshot } from "../src/server/research-method";
const rules = {
  evidence: "fixture",
  tradable: true,
  limitUp: null,
  limitDown: null,
  minimumBuy: 100,
  buyStep: 100,
  maximumOrder: 100000,
  minimumSell: 100,
  sellStep: 100,
  maximumSell: 100000,
  sellOddLotAll: true,
};
const costs = {
  version: "cost-experiment-1" as const,
  commissionBps: 0,
  minimumCommission: 0,
  sellTaxBps: 0,
  slippageBps: 0,
};
function setup(id: SwingDisciplineId) {
  const bars = Array.from({ length: 8 }, (_, i) => ({
    date: `2022-01-${String(i + 1).padStart(2, "0")}`,
    open: 100,
    close: 100,
    high: 103,
    low: 95,
    volume: 10000,
    amount: 1e6,
  }));
  const spec = researchSpecSchema.parse({
    strategy: "dual-breakout",
    start: bars[0]!.date,
    end: bars[7]!.date,
    validationStart: bars[7]!.date,
    initialCapital: 1e6,
    maxPositions: 3,
    risk: { fraction: 0.03, maxWeight: 0.2 },
    management: swingDisciplineTemplate(id),
    costs,
  });
  const event: ResearchEvent = {
    symbol: "sh600000",
    observedDate: bars[0]!.date,
    endpointDate: bars[0]!.date,
    key: "synthetic",
    strategyVersion: "fixture",
    partition: "development",
    evidence: "synthetic confirmed event",
    initialStop: 90,
    entryTarget: 120,
    pullbackLevel: 98,
    stopAtr: 2,
  };
  const run = () =>
    researchPortfolio(
      spec,
      [event],
      bars.map((b) => b.date),
      new Map([[event.symbol, bars]]),
      () => rules,
    );
  return { bars, spec, event, run };
}
it.each(swingDisciplineIds)(
  "%s persists exact named configuration and binds UI baseline",
  (id) => {
    const { spec } = setup(id);
    expect(researchManagementSchema.parse(swingDisciplineTemplate(id))).toEqual(
      spec.management,
    );
    expect(researchMethodSnapshot(spec).swingDiscipline?.id).toBe(id);
    const selected = applyResearchManagement(
      researchSpecSchema.parse({
        strategy: "sw-macd-combined",
        start: spec.start,
        end: spec.end,
        validationStart: spec.validationStart,
      }),
      swingDisciplineTemplate(id),
    );
    expect(researchSpecSchema.parse(selected).strategy).toBe("dual-breakout");
    expect(selected.maxPositions).toBe(3);
    expect(
      selectResearchStrategy(selected, "sw-macd-combined").management
        ?.swingDiscipline,
    ).toBeUndefined();
    expect(
      researchManagementSchema.safeParse({
        ...swingDisciplineTemplate(id),
        confirmations: 2,
      }).success,
    ).toBe(false);
  },
);
it("fixed 2/3 and volatility-adaptive stop use real entry price, ATR equality and missing path", () => {
  expect(
    researchInitialStop(swingDisciplineTemplate("sw-stop2"), 100, {}),
  ).toBe(98);
  expect(
    researchInitialStop(swingDisciplineTemplate("sw-stop3"), 100, {}),
  ).toBe(97);
  const m = swingDisciplineTemplate("sw-stop-volatility");
  expect(researchInitialStop(m, 100, { stopAtr: 2 })).toBe(97);
  expect(researchInitialStop(m, 100, { stopAtr: 1.999 })).toBe(98);
  expect(researchInitialStop(m, 100, {})).toBeNull();
});
it("structure admission rejects missing, equal and lost stops in actual portfolio", () => {
  const f = setup("sw-stop-required");
  expect(f.run().trades).toHaveLength(1);
  for (const stop of [undefined, 100, 101]) {
    f.event.initialStop = stop;
    const r = f.run();
    expect(r.trades).toHaveLength(0);
    expect(r.excluded[0]!.reason).toContain("止损");
  }
});
it("2R admission includes fees, sell chunks, missing target and actual opening gap", () => {
  const f = setup("sw-min-rr2");
  expect(f.run().trades).toHaveLength(1);
  f.bars[1]!.open = 101;
  expect(f.run().trades).toHaveLength(0);
  f.bars[1]!.open = 100;
  f.event.entryTarget = null;
  expect(f.run().excluded[0]!.reason).toContain("目标");
  const input = {
    entry: 100,
    stop: 90,
    target: 120,
    quantity: 100,
    rules,
    costs,
  };
  expect(swingRewardAdmission(input)).toMatchObject({ allow: true, ratio: 2 });
  expect(
    swingRewardAdmission({
      ...input,
      costs: { ...costs, minimumCommission: 5 },
    }).allow,
  ).toBe(false);
  expect(
    swingRewardAdmission({
      ...input,
      target: 121,
      costs: { ...costs, minimumCommission: 5 },
      rules: { ...rules, maximumSell: 100 },
      quantity: 300,
    }).allow,
  ).toBe(true);
});
it("strict no-average template keeps profitable-only second tranche instead of weakening planned pullback", () => {
  const m = swingDisciplineTemplate("sw-no-average");
  expect(m.pyramid).toMatchObject({
    kind: "pullback-50-50",
    requireProfit: true,
  });
  const f = setup("sw-no-average");
  f.bars[1]!.close = 99;
  f.bars[2] = { ...f.bars[2]!, open: 99, close: 99, low: 98, high: 100 };
  f.bars[3]!.open = 99;
  const r = f.run();
  expect(r.trades).toHaveLength(1);
  expect(r.trades[0]!.entries).toHaveLength(1);
});
