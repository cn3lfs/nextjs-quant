import { describe, expect, it } from "vitest";
import { runPortfolio, type PortfolioRequest } from "quant-backtest";
import {
  financialReplayBlockedReason,
  financialReplayCostMultiplier,
  financialReplayInput,
  financialReplayTargets,
  financialReplayYearStatus,
  type FinancialReplayYearSignal,
} from "~/lib/financial/financial-replay";

const hash = (letter: string) => letter.repeat(64);
const year = (
  overrides: Partial<FinancialReplayYearSignal> = {},
): FinancialReplayYearSignal => ({
  asOf: "2020-12-31",
  executeAt: "2021-01-04",
  hash: hash("a"),
  counts: {
    total: 100,
    annualReport: 90,
    fScoreComplete: 40,
    magicEligible: 60,
  },
  complete: { annualReport: 90, fScore: 40, magic: 60 },
  selections: {
    fScore: {
      positions: [{ symbol: "sh600000", weight: 0.5 }],
      cashWeight: 0.5,
    },
    magicFormula: {
      positions: [{ symbol: "sh600000", weight: 0.5 }],
      cashWeight: 0.5,
    },
  },
  ...overrides,
});

describe("financial replay annual targeting", () => {
  it("executes a prior completed-day allocation at the next legal open", () => {
    const targets = financialReplayTargets(
      [year()],
      "financial-replay-magic-annual",
    );
    expect(targets).toEqual([
      {
        strategyId: "financial-replay-magic-annual",
        date: "2020-12-31",
        availableAt: "2020-12-31",
        sourceHash: hash("a"),
        targets: { sh600000: 0.5 },
      },
    ]);
    const dates = ["2020-12-31", "2021-01-04", "2021-01-05"];
    const bars = dates.map((date) => ({
      date,
      open: 10,
      high: 11,
      low: 9,
      close: 10,
      volume: 1000000,
      amount: 10000000,
    }));
    const request: PortfolioRequest = {
      market: "cn-equity",
      initial: 100000,
      start: dates[0]!,
      end: dates.at(-1)!,
      calendar: dates,
      instruments: [
        {
          symbol: "sh600000",
          market: "cn-equity",
          bars,
          signalBars: bars,
          execution: {
            minimum: 100,
            step: 100,
            tradable: true,
            evidence: "fixture",
            limitUp: null,
            limitDown: null,
          },
        },
      ],
      strategies: [
        {
          id: "financial-replay-magic-annual",
          version: 1,
          market: "cn-equity",
          period: "day",
          universe: { kind: "symbols", symbols: ["sh600000"] },
          entry: { kind: "constant", value: false },
          exit: { rule: { kind: "constant", value: false } },
          sizing: { kind: "weight", weight: 0.5 },
          sleeve: "annual",
        },
      ],
      sleeves: [{ id: "annual", share: 1, riskPerTrade: 1, maxPositions: 1 }],
      costs: {
        version: "cost-experiment-1",
        commissionBps: 0,
        minimumCommission: 0,
        sellTaxBps: 0,
        slippageBps: 0,
      },
      scheduledTargets: targets,
    };
    const result = runPortfolio(request);
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]).toMatchObject({
      date: "2021-01-04",
      signalAt: "2020-12-31",
      symbol: "sh600000",
      side: "buy",
    });
  });

  it("keeps the signal date strictly before the execution date", () => {
    expect(() =>
      financialReplayYearStatus(
        year({ asOf: "2021-01-04", executeAt: "2021-01-04" }),
        "magic-formula",
      ),
    ).toThrow("完成前执行");
    expect(() =>
      financialReplayTargets(
        [year({ hash: "not-a-hash" })],
        "financial-replay-magic-annual",
      ),
    ).toThrow("内容哈希");
  });
});

describe("financial replay evidence blocking", () => {
  it("blocks missing F-score facts but keeps a complete zero-candidate year as cash", () => {
    const incomplete = financialReplayYearStatus(
      year({
        counts: { ...year().counts, fScoreComplete: 0 },
        complete: { annualReport: 90, fScore: 0, magic: 0 },
      }),
      "f-score",
    );
    expect(incomplete).toMatchObject({
      year: 2021,
      status: "blocked",
      // Raw selected rows remain visible evidence; they are not executable.
      positions: 1,
      cashWeight: null,
    });
    expect(incomplete.reason).toContain("完整九项F-score");
    const cash = financialReplayYearStatus(
      year({
        selections: {
          ...year().selections,
          fScore: { positions: [], cashWeight: 1 },
        },
        complete: { annualReport: 90, fScore: 40, magic: 60 },
      }),
      "f-score",
    );
    expect(cash).toMatchObject({
      status: "ready",
      positions: 0,
      cashWeight: 1,
    });
    expect(financialReplayBlockedReason([incomplete, cash])).toContain(
      "未执行组合回放",
    );
    expect(
      financialReplayTargets(
        [
          year({
            selections: {
              ...year().selections,
              fScore: { positions: [], cashWeight: 1 },
            },
            complete: { annualReport: 90, fScore: 40, magic: 60 },
          }),
        ],
        "financial-replay-fscore-annual",
        "f-score",
      ),
    ).toEqual([
      {
        strategyId: "financial-replay-fscore-annual",
        date: "2020-12-31",
        availableAt: "2020-12-31",
        sourceHash: hash("a"),
        targets: {},
      },
    ]);
  });

  it("blocks missing annual reports and missing magic facts, not valid rejections", () => {
    expect(
      financialReplayYearStatus(
        year({
          counts: { ...year().counts, annualReport: 0 },
          complete: { annualReport: 0, fScore: 40, magic: 60 },
        }),
        "magic-formula",
      ).reason,
    ).toContain("年度财报");
    expect(
      financialReplayYearStatus(
        year({
          counts: { ...year().counts, magicEligible: 0 },
          complete: { annualReport: 90, fScore: 40, magic: 0 },
        }),
        "magic-formula",
      ).reason,
    ).toContain("魔法公式");
    const validRejections = financialReplayYearStatus(
      year({
        counts: { ...year().counts, magicEligible: 0 },
        complete: { annualReport: 90, fScore: 40, magic: 60 },
        selections: {
          ...year().selections,
          magicFormula: { positions: [], cashWeight: 1 },
        },
      }),
      "magic-formula",
    );
    expect(validRejections).toMatchObject({
      status: "ready",
      positions: 0,
      cashWeight: 1,
    });
    const ready = financialReplayYearStatus(year(), "magic-formula");
    expect(ready).toMatchObject({
      status: "ready",
      positions: 1,
      cashWeight: 0.5,
    });
    expect(financialReplayBlockedReason([ready])).toBeNull();
  });

  it("treats an empty year list as missing evidence, not a ready cash account", () => {
    expect(financialReplayBlockedReason([])).not.toBeNull();
    expect(financialReplayBlockedReason([])).toContain("年度信号为空");
    expect(() =>
      financialReplayTargets([], "financial-replay-magic-annual"),
    ).toThrow("年度信号为空");
  });

  it("requires the new completeness declaration; legacy counts need an explicit flag", () => {
    const legacy = year({ complete: undefined });
    expect(financialReplayYearStatus(legacy, "magic-formula").reason).toContain(
      "完整事实声明",
    );
    expect(
      financialReplayYearStatus(legacy, "magic-formula", { legacy: true })
        .status,
    ).toBe("ready");
    expect(
      financialReplayTargets(
        [legacy],
        "financial-replay-magic-annual",
        "magic-formula",
        { legacy: true },
      ),
    ).toHaveLength(1);
  });

  it("rejects duplicated or over-allocated annual targets", () => {
    expect(() =>
      financialReplayTargets(
        [
          year({
            selections: {
              ...year().selections,
              magicFormula: {
                positions: [
                  { symbol: "sh600000", weight: 0.5 },
                  { symbol: "sh600000", weight: 0.5 },
                ],
                cashWeight: 0,
              },
            },
          }),
        ],
        "financial-replay-magic-annual",
      ),
    ).toThrow("重复证券");
    expect(() =>
      financialReplayTargets(
        [
          year({
            selections: {
              ...year().selections,
              magicFormula: {
                positions: [
                  { symbol: "sh600000", weight: 0.8 },
                  { symbol: "sh600001", weight: 0.8 },
                ],
                cashWeight: 0,
              },
            },
          }),
        ],
        "financial-replay-magic-annual",
      ),
    ).toThrow("超过100%");
  });
});

describe("financial replay input limits", () => {
  const base = {
    symbols: ["sh600000"],
    firstYear: 2020,
    lastYear: 2024,
    endDate: "2024-12-31",
    initial: 1000000,
  };
  it("accepts a bounded annual window with one cost scenario", () => {
    expect(
      financialReplayInput.parse({
        ...base,
        costScenario: "zero-cost",
        preset: "f-score",
      }),
    ).toMatchObject({
      costScenario: "zero-cost",
      preset: "f-score",
      symbols: ["sh600000"],
    });
  });
  it("rejects duplicate symbols, reversed years, a short end date and an invalid initial", () => {
    expect(() =>
      financialReplayInput.parse({
        ...base,
        symbols: ["sh600000", "sh600000"],
      }),
    ).toThrow("重复证券");
    expect(() =>
      financialReplayInput.parse({ ...base, firstYear: 2025 }),
    ).toThrow("结束年度");
    expect(() =>
      financialReplayInput.parse({ ...base, endDate: "2023-12-31" }),
    ).toThrow("结束日期");
    expect(() => financialReplayInput.parse({ ...base, initial: 0 })).toThrow();
    expect(() =>
      financialReplayInput.parse({
        ...base,
        firstYear: 2000,
        lastYear: 2021,
        endDate: "2022-12-31",
      }),
    ).toThrow("最多20年");
  });
  it("maps cost scenarios to the frozen commission multipliers", () => {
    expect(financialReplayCostMultiplier("zero-cost")).toBe(0);
    expect(financialReplayCostMultiplier("base")).toBe(1);
    expect(financialReplayCostMultiplier("double-cost")).toBe(2);
  });
});
