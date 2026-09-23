import {
  canslimProgressPresetIds,
  researchExitPresetTemplate,
  clearStaleExitPreset,
} from "../src/lib/research-exit-presets";
import { researchManagementSchema } from "../src/lib/research-management";
import {
  researchProgressCheck,
  researchProgressExitDescription,
} from "../src/lib/research-progress-exit";
import { applyResearchManagement } from "../src/components/research/research-strategy-fields";
import { expect, it } from "vitest";
import type { Bar } from "../src/lib/domain";
import { researchSpecSchema } from "../src/lib/strategy-research";
import { runStrategyResearch } from "../src/server/backtest/research-run";
import { researchMethodSnapshot } from "../src/server/research/research-method";
import type { ResearchDataset } from "../src/server/backtest/research-dataset";
import { researchMarketEvidenceSchema } from "../src/lib/research-market-evidence";

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
const native = async (): Promise<never> => {
  throw Error("unexpected native");
};
function setup(
  kind: (typeof canslimProgressPresetIds)[number] = "canslim-time4-calendar",
) {
  const dates = Array.from(
    { length: 190 },
    (_, i) => new Date(Date.UTC(2024, 0, i + 1)),
  )
    .filter((d) => d.getUTCDay() !== 0 && d.getUTCDay() !== 6)
    .map((d) => d.toISOString().slice(0, 10))
    .filter((_, i) => i < 80 || i > 84)
    .slice(0, 120);
  const bars: Bar[] = Array.from({ length: 120 }, (_, i) => ({
    date: dates[i]!,
    open: i >= 70 ? 102 : 97,
    high: i >= 69 ? 103 : 100,
    low: i >= 70 ? 101 : 95,
    close: i >= 69 ? 102 : 97,
    volume: i < 49 ? 100 : i < 59 ? 45 : i < 69 ? 35 : 70,
    amount: 1000000,
  }));
  const spec = researchSpecSchema.parse({
    strategy: "canslim-priority",
    symbols: ["sh600000"],
    start: bars[61]!.date,
    end: bars[119]!.date,
    validationStart: bars[118]!.date,
    holdingDays: 60,
    entryMaxWait: 5,
    costs: {
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
  });
  spec.management = researchExitPresetTemplate(
    researchManagementSchema.parse({}),
    kind,
  );
  spec.risk = { fraction: 0.015, maxWeight: 0.25 };
  const calendar = bars.map((b) => b.date);
  const dataset: ResearchDataset = {
    version: "research-dataset-1",
    source: "tdx-local",
    root: "fixture",
    adjustment: "none",
    membership: {
      mode: "current-snapshot",
      symbols: spec.symbols!,
      source: null,
      warning: "fixture",
    },
    benchmark: { symbol: "sh000001", bars },
    calendar,
    stocks: [
      {
        symbol: "sh600000",
        name: "fixture",
        bars,
        hash: "fixture",
        actions: [],
      },
    ],
    excluded: [],
    actionCoverage: "partial",
    actionSource: { path: "fixture", modified: 0 },
    capturedAt: 0,
    hash: "fixture",
    method: researchMethodSnapshot(spec),
  };
  const evidence = researchMarketEvidenceSchema.parse({
    version: "research-market-evidence-1",
    source: "fixture",
    exportedAt: 0,
    adjustment: "none",
    corporateActionFree: [
      {
        symbol: "sh600000",
        start: bars[0]!.date,
        end: spec.end,
        evidenceId: "fixture",
      },
    ],
    rows: bars.map((b) => ({
      symbol: "sh600000",
      date: b.date,
      ...rules,
      evidenceId: "fixture",
    })),
  });
  return { bars, spec, calendar, dataset, evidence };
}

function dueIndex(
  bars: Bar[],
  kind: (typeof canslimProgressPresetIds)[number],
  entry = 70,
) {
  const deadline = new Date(Date.parse(bars[entry]!.date) + 28 * 86400000)
    .toISOString()
    .slice(0, 10);
  return kind.endsWith("calendar")
    ? bars.findIndex((b) => b.date >= deadline)
    : entry + 19;
}
function price(bars: Bar[], index: number, close: number) {
  Object.assign(bars[index]!, {
    open: close,
    close,
    high: close + 1,
    low: close - 1,
  });
}

it("keeps the two clocks distinct and compares the five-percent boundary directly", () => {
  const { bars, calendar, spec } = setup();
  const entry = { entryDate: bars[70]!.date, entryIndex: 70, entryPrice: 102 };
  const rule = spec.management!.progressExit!;
  const due = dueIndex(bars, "canslim-time4-calendar");
  expect(due).not.toBe(89);
  expect(
    researchProgressCheck(rule, entry, bars[due - 1]!, due - 1, calendar),
  ).toBeNull();
  price(bars, due, 107.1);
  expect(
    researchProgressCheck(rule, entry, bars[due]!, due, calendar),
  ).toMatchObject({
    triggered: false,
    checkedDate: bars[due]!.date,
    thresholdPrice: 102 * 1.05,
  });
  bars[due]!.close -= 0.001;
  expect(
    researchProgressCheck(rule, entry, bars[due]!, due, calendar)!.triggered,
  ).toBe(true);
  bars[due]!.volume = 0;
  expect(
    researchProgressCheck(rule, entry, bars[due]!, due, calendar),
  ).toBeNull();
});

it("stores source/configuration, rejects stale names and raises the UI holding horizon only on selection", () => {
  for (const kind of canslimProgressPresetIds) {
    const { spec } = setup(kind);
    const management = spec.management!;
    expect(researchSpecSchema.safeParse(spec).success).toBe(true);
    expect(researchMethodSnapshot(spec)).toHaveProperty(
      "progressExit.interpretation",
      researchProgressExitDescription,
    );
    expect(
      researchMethodSnapshot(spec).sources.some(
        (s) => s.path === "canslim-analyst/references/entry-exit-rules.md",
      ),
    ).toBe(true);
    const stale = {
      ...management,
      progressExit: { ...management.progressExit!, minimumGain: 0.1 },
    };
    expect(researchManagementSchema.safeParse(stale).success).toBe(false);
    const custom = clearStaleExitPreset(stale);
    expect(custom).not.toHaveProperty("exitPreset");
    expect(
      researchMethodSnapshot({ ...spec, management: custom }),
    ).toHaveProperty("progressExit.configuration.minimumGain", 0.1);
    expect(
      applyResearchManagement(
        { ...spec, management: undefined, holdingDays: 5 },
        management,
      ).holdingDays,
    ).toBe(60);
    expect(
      applyResearchManagement({ ...spec, holdingDays: 5 }, management)
        .holdingDays,
    ).toBe(5);
  }
});

it.each(canslimProgressPresetIds)(
  "%s checks once from the actual entry and exits next sellable open",
  async (kind) => {
    const { bars, spec, dataset, evidence } = setup(kind);
    const due = dueIndex(bars, kind);
    const result = await runStrategyResearch(spec, dataset, evidence, native);
    expect(result.events).toHaveLength(1);
    const trade = result.partitions[0]!.simulation!.trades[0]!;
    expect(trade).toMatchObject({
      entryDate: bars[70]!.date,
      exitDate: bars[due + 1]!.date,
      progressExitCheck: {
        checkedDate: bars[due]!.date,
        entryPrice: 102,
        triggered: true,
      },
    });
    expect(trade.exitReason).toContain("涨幅不足5%");
    evidence.rows.find((r) => r.date === bars[due + 1]!.date)!.tradable = false;
    evidence.rows.find((r) => r.date === bars[due + 2]!.date)!.tradable = false;
    price(bars, due + 1, 108);
    price(bars, due + 2, 108);
    const delayed = await runStrategyResearch(spec, dataset, evidence, native);
    expect(delayed.partitions[0]!.simulation!.trades[0]).toMatchObject({
      exitDate: bars[due + 3]!.date,
      progressExitCheck: trade.progressExitCheck,
    });
  },
);

it("defers an unavailable deadline close and preserves the original calendar deadline", async () => {
  const { bars, spec, dataset, evidence } = setup();
  const due = dueIndex(bars, "canslim-time4-calendar");
  const scheduled = new Date(Date.parse(bars[70]!.date) + 28 * 86400000)
    .toISOString()
    .slice(0, 10);
  bars[due]!.volume = 0;
  const result = await runStrategyResearch(spec, dataset, evidence, native);
  expect(result.partitions[0]!.simulation!.trades[0]).toMatchObject({
    exitDate: bars[due + 2]!.date,
    progressExitCheck: {
      scheduledDate: scheduled,
      checkedDate: bars[due + 1]!.date,
    },
  });
});

it("a passed checkpoint is frozen even when a later close falls below five percent", async () => {
  const { bars, spec, dataset, evidence } = setup();
  const due = dueIndex(bars, "canslim-time4-calendar");
  price(bars, due, 107.1);
  const result = await runStrategyResearch(spec, dataset, evidence, native);
  const trade = result.partitions[0]!.simulation!.trades[0]!;
  expect(trade.progressExitCheck).toMatchObject({
    checkedDate: bars[due]!.date,
    triggered: false,
  });
  expect(trade.exitReason ?? "").not.toContain("涨幅不足");
  expect(trade.exitDate === null || trade.exitDate > bars[due + 2]!.date).toBe(
    true,
  );
});

it("anchors a delayed buy to its fill and leaves early exits without a fabricated check", async () => {
  const { bars, spec, dataset, evidence } = setup();
  for (const i of [70, 71])
    evidence.rows.find((r) => r.date === bars[i]!.date)!.tradable = false;
  const result = await runStrategyResearch(spec, dataset, evidence, native);
  expect(result.partitions[0]!.simulation!.trades[0]).toMatchObject({
    entryDate: bars[72]!.date,
    progressExitCheck: {
      entryDate: bars[72]!.date,
      checkedDate: bars[dueIndex(bars, "canslim-time4-calendar", 72)]!.date,
    },
  });
  const early = await runStrategyResearch(
    { ...spec, holdingDays: 5 },
    dataset,
    evidence,
    native,
  );
  expect(early.partitions[0]!.simulation!.trades[0]).not.toHaveProperty(
    "progressExitCheck",
  );
});
