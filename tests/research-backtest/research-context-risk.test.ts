import { expect, it } from "vitest";
import {
  contextRiskPoint,
  type ContextRiskInput,
} from "trading-strategies/research/risk/research-context-risk";
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
  sector: "fixture-sector",
  marketStage: {
    stage: "bull",
    predicateVersion: "fixed",
    evidence: "fixture",
  },
  scheduledEvent: {
    coverageComplete: true,
    id: "none",
    eventDate: null,
    announcedAt: `${date}T13:00:00+08:00`,
    evidence: "fixture",
  },
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
