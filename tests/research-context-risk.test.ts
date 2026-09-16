import { runStrategyResearch } from "../src/server/research-run";
import type { ResearchDataset } from "../src/server/research-dataset";
import { expect, it } from "vitest";
import {
  contextRiskIds,
  contextRiskPoint,
  contextRiskTemplate,
  type ContextRiskInput,
  type ContextRiskId,
} from "../src/lib/research-context-risk";
import {
  researchSpecSchema,
  type ResearchEvent,
} from "../src/lib/strategy-research";
import { applyResearchManagement } from "../src/components/research-strategy-fields";
import { researchPortfolio } from "../src/server/research-portfolio";
import { researchMethodSnapshot } from "../src/server/research-method";
const dates = Array.from(
  { length: 12 },
  (_, i) => `2021-01-${String(i + 1).padStart(2, "0")}`,
);
const record = (date: string): ContextRiskInput => ({
  symbol: "sh600000",
  date,
  source: "fixture only",
  version: "1",
  effectiveAt: `${date}T14:00:00+08:00`,
  availableAt: `${date}T14:00:00+08:00`,
  capturedAt: `${date}T14:00:00+08:00`,
  emotion: "normal",
  discipline: "compliant",
  environment: true,
  eventWindow: false,
  news: {
    coverageComplete: true,
    classification: "none",
    publishedAt: `${date}T13:00:00+08:00`,
    criteriaVersion: "fixed taxonomy",
    evidence: "fixed complete coverage",
  },
  freshEntry: {
    eligible: true,
    predicateVersion: "persistent-v1",
    evidence: "not a crossing event",
  },
  thesis: {
    id: "original",
    frozenAt: "2020-12-31T14:00:00+08:00",
    invalidation: "product trial failure",
    invalidated: false,
    evidence: "dated public evidence",
  },
});
const inputs = () => dates.map(record);
const base = researchSpecSchema.parse({
  strategy: "dual-breakout",
  start: dates[0],
  end: dates.at(-1),
  validationStart: dates[10],
  costs: {
    commissionBps: 0,
    minimumCommission: 0,
    sellTaxBps: 0,
    slippageBps: 0,
  },
});
const event: ResearchEvent = {
  symbol: "sh600000",
  observedDate: dates[5]!,
  endpointDate: dates[5]!,
  key: "context",
  strategyVersion: "fixed",
  partition: "development",
  evidence: "fixed confirmed dual breakout",
  entryTarget: 110,
};
const bars = dates.map((date) => ({
  date,
  open: 100,
  close: 100,
  low: 99,
  high: 101,
  volume: 100000,
  amount: 10000000,
}));
const rules = {
  evidence: "fixed",
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
const specFor = (id: ContextRiskId, rows: ContextRiskInput[]) =>
  researchSpecSchema.parse(
    applyResearchManagement(base, {
      ...contextRiskTemplate(id),
      contextRiskInputs: rows,
    }),
  );
it.each(contextRiskIds)(
  "%s preserves input and rejects missing/retrospective state",
  (id) => {
    const rows = inputs(),
      date = dates[6]!;
    expect(contextRiskPoint(id, rows, "sh600000", date, dates)).toMatchObject({
      status: "available",
      allow: true,
      exit: false,
    });
    expect(contextRiskPoint(id, [], "sh600000", date, dates).status).toBe(
      "missing",
    );
    rows[6]!.capturedAt = "2021-02-01T14:00:00+08:00";
    expect(contextRiskPoint(id, rows, "sh600000", date, dates).status).toBe(
      "missing",
    );
    const spec = specFor(id, inputs());
    expect(JSON.stringify(researchMethodSnapshot(spec))).toContain(
      "context-risk-1",
    );
    expect(
      researchSpecSchema.safeParse({
        ...spec,
        risk: { fraction: 0.03, maxWeight: 0.2 },
      }).success,
    ).toBe(false);
  },
);
it.each(["sw-emotion-week", "sw-discipline-week"] as const)(
  "%s pauses five complete following trading days and needs explicit recovery",
  (id) => {
    const rows = inputs();
    if (id === "sw-emotion-week") rows[1]!.emotion = "impaired";
    else rows[1]!.discipline = "violated";
    for (let i = 1; i <= 6; i++)
      expect(
        contextRiskPoint(id, rows, "sh600000", dates[i]!, dates).allow,
      ).toBe(false);
    expect(contextRiskPoint(id, rows, "sh600000", dates[7]!, dates).allow).toBe(
      true,
    );
    rows.splice(3, 1);
    expect(
      contextRiskPoint(id, rows, "sh600000", dates[7]!, dates).status,
    ).toBe("missing");
  },
);
it("preflight distinguishes missing from rejection, and missing emotion cannot pass", () => {
  const rows = inputs();
  rows[6]!.environment = false;
  expect(
    contextRiskPoint("sw-preflight", rows, "sh600000", dates[6]!, dates),
  ).toMatchObject({ status: "available", allow: false });
  delete rows[6]!.emotion;
  expect(
    contextRiskPoint("sw-preflight", rows, "sh600000", dates[6]!, dates).status,
  ).toBe("missing");
});
it("thesis cannot change original written invalidation after entry", () => {
  const rows = inputs(),
    frozen = rows[5]!.thesis;
  rows[7]!.thesis!.invalidated = true;
  expect(
    contextRiskPoint("rk-thesis", rows, "sh600000", dates[7]!, dates, frozen),
  ).toMatchObject({ exit: true });
  rows[7]!.thesis!.invalidation = "another excuse";
  expect(
    contextRiskPoint("rk-thesis", rows, "sh600000", dates[7]!, dates, frozen)
      .status,
  ).toBe("missing");
});
it.each(["sw-news-exit", "rk-fresh-entry", "rk-thesis"] as const)(
  "%s exits on explicit evidence and retains queued exit through recovery",
  (id) => {
    const rows = inputs();
    if (id === "sw-news-exit") rows[7]!.news!.classification = "major-negative";
    if (id === "rk-fresh-entry") rows[7]!.freshEntry!.eligible = false;
    if (id === "rk-thesis") rows[7]!.thesis!.invalidated = true;
    const result = researchPortfolio(
      specFor(id, rows),
      [event],
      dates,
      new Map([[event.symbol, bars]]),
      (_s, date) => ({ ...rules, tradable: date !== dates[8] }),
    );
    expect(result.trades[0]?.exitDate).toBe(dates[9]);
    expect(result.trades[0]?.exitReason).toContain(id);
    expect(result.contextChecks?.some((c) => c.check.exit)).toBe(true);
  },
);
it("preflight rechecks net 2R at actual open, not just a checkbox", () => {
  const run = (target: number) =>
    researchPortfolio(
      specFor("sw-preflight", inputs()),
      [{ ...event, entryTarget: target }],
      dates,
      new Map([[event.symbol, bars]]),
      () => rules,
    );
  expect(run(110).trades).toHaveLength(1);
  expect(run(109.99).trades).toHaveLength(0);
  expect(run(109.99).excluded[0]?.reason).toContain("2R");
});
it("entry uses latest prior close so delayed orders cannot bypass a newly impaired state", () => {
  const rows = inputs();
  rows[6]!.emotion = "impaired";
  const result = researchPortfolio(
    specFor("sw-emotion", rows),
    [event],
    dates,
    new Map([[event.symbol, bars]]),
    (_s, date) => ({ ...rules, tradable: date !== dates[6] }),
  );
  expect(result.trades).toHaveLength(0);
  expect(result.excluded[0]?.reason).toContain("门槛");
});
it("thesis disaster floor is independent of close and does not promise intraday fill", () => {
  const input = structuredClone(bars);
  input[7]!.low = 90;
  const result = researchPortfolio(
    specFor("rk-thesis", inputs()),
    [event],
    dates,
    new Map([[event.symbol, input]]),
    () => rules,
  );
  expect(result.trades[0]?.exitDate).toBe(dates[8]);
  expect(result.trades[0]?.exitReason).toContain("灾难");
});

it("an impaired account record against another symbol also blocks this symbol", () => {
  const rows = inputs();
  rows.push({ ...record(dates[6]!), symbol: "sz000001", emotion: "impaired" });
  expect(
    contextRiskPoint("sw-emotion", rows, "sh600000", dates[6]!, dates).allow,
  ).toBe(false);
  expect(
    contextRiskPoint("sw-emotion-week", rows, "sh600000", dates[7]!, dates)
      .allow,
  ).toBe(false);
});

it("real run refuses absent historical context before simulating any trade", async () => {
  const spec = specFor("sw-news-exit", []);
  const dataset: ResearchDataset = {
    version: "research-dataset-1",
    source: "tdx-local",
    root: "fixed",
    adjustment: "none",
    membership: {
      mode: "current-snapshot",
      symbols: [event.symbol],
      source: null,
      warning: "fixture",
    },
    benchmark: { symbol: "sh000001", bars },
    calendar: dates,
    stocks: [
      {
        symbol: event.symbol,
        name: "fixture",
        bars,
        hash: "fixture",
        actions: [],
      },
    ],
    excluded: [],
    actionCoverage: "missing",
    actionSource: null,
    capturedAt: 0,
    hash: "fixture",
  };
  await expect(
    runStrategyResearch(spec, dataset, null, async () => {
      throw new Error("must not call DLL");
    }),
  ).rejects.toThrow("missing: 真实回测不可用");
});
