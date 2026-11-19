import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { strategyObjectSchema } from "trading-strategies";
import { settingsSchema } from "~/lib/domain";
import { alertKey, type AlertEvent } from "~/lib/strategy-facts/alerts";
import {
  createAlertPlan,
  previewAlertPlan,
  storedCandidateEligibility,
} from "~/server/alerts/plans";
import { AlertRepository } from "~/server/db/alert-repository";
import { migrate } from "~/server/db/migrations";

const closeDate = "2026-11-19";
const previousClose = "2026-11-18";
const now = Date.parse(`${closeDate}T16:00:00+08:00`);
const closeReference = { closeDate, calendar: [previousClose, closeDate] };
const strategy = strategyObjectSchema.parse({
  id: "plan-eligibility",
  version: 1,
  market: "cn-equity",
  period: "day",
  sleeve: "swing",
  universe: { kind: "symbols", symbols: ["sh600000"] },
  entry: { kind: "constant", value: true },
  exit: {},
  sizing: { kind: "weight", weight: 0.1 },
});
const config = settingsSchema.parse({
  alerts: {
    capital: { "cn-equity": 100000 },
    sleeves: [{ id: "swing", market: "cn-equity", share: 1, risk: 0.02 }],
  },
});
let repo: AlertRepository;
beforeEach(() => {
  const db = new Database(":memory:");
  migrate(db);
  repo = new AlertRepository(db);
  repo.strategies.saveStrategy(strategy);
  repo.saveState("exposure", [
    { market: "cn-equity", sleeve: "__checked__", value: 0, at: now },
  ]);
});
afterEach(() => repo.db.close());

type Candidate = Parameters<typeof storedCandidateEligibility>[0] & {
  signalPrice?: number | null;
  signalPriceBasis?: "forward";
  executionRawPrice?: number | null;
};

function recordCandidate(overrides: Partial<Candidate> = {}) {
  const candidate: AlertEvent & Candidate = {
    key: "",
    strategyId: strategy.id,
    version: strategy.version,
    market: "cn-equity",
    symbol: "sh600000",
    bar: closeDate,
    type: "entry",
    price: 15,
    signalPrice: 9.875,
    signalPriceBasis: "forward",
    executionRawPrice: 12.345,
    sleeve: "swing",
    stop: 11,
    target: null,
    observedAt: now,
    mode: "shadow",
    status: "shadow",
    reason: "fixture",
    source: "fixture",
    wouldSend: false,
    outcomes: [],
    ...overrides,
  };
  candidate.key = alertKey(candidate);
  repo.record(strategy, candidate);
  return candidate.key;
}

function saveScan(bar: string, period: "day" | "5m") {
  repo.saveState(`candidate-scan:cn-equity:${strategy.id}:1`, {
    bar,
    period,
    observedAt: now,
  });
}

function planInput(eventKey: string) {
  return {
    eventKey,
    stages: [12.345],
    stop: 11,
    target: null,
    expiresAt: "2026-11-20T08:00:00Z",
  };
}

function eligibility(key: string) {
  return storedCandidateEligibility(
    repo.event(key)!,
    repo,
    closeReference,
    now,
  );
}

it.each([
  { expected: "fresh-close", scanPeriod: "day" },
  { expected: "intraday", scanPeriod: "5m" },
  { expected: "unverified", scanPeriod: null },
] as const)(
  "preserves $expected and both archived price bases through plan preview",
  ({ expected, scanPeriod }) => {
    const key = recordCandidate();
    if (scanPeriod) saveScan(closeDate, scanPeriod);

    expect(eligibility(key)).toEqual({
      freshness: expected,
      signalPrice: 9.875,
      signalPriceBasis: "forward",
      executionRawPrice: 12.345,
    });
    expect(
      previewAlertPlan(planInput(key), config, now, repo, [], closeReference),
    ).toMatchObject({
      triggerKey: key,
      entry: 12.345,
    });
    expect(repo.plans()).toEqual([]);
  },
);

it("uses the newer same-version scan to reject an old candidate in both preview and create", () => {
  const key = recordCandidate({ bar: previousClose });
  saveScan(closeDate, "day");
  expect(eligibility(key).freshness).toBe("stale");
  const input = planInput(key);
  expect(() =>
    previewAlertPlan(input, config, now, repo, [], closeReference),
  ).toThrow("已过期的历史扫描批次");
  const admission = {
    positions: [],
    industry: () => "银行",
    closeReference,
    assertCurrent: () => {},
  };
  expect(() =>
    createAlertPlan(
      { ...input, allowStale: false },
      config,
      now,
      repo,
      admission,
    ),
  ).toThrow("已过期的历史扫描批次");
  expect(repo.plans()).toEqual([]);

  const plan = createAlertPlan(
    { ...input, allowStale: true },
    config,
    now,
    repo,
    admission,
  );
  expect(repo.plans()).toEqual([plan]);
  expect(plan.triggerKey).toBe(key);
  expect(eligibility(key).freshness).toBe("stale");
});

it.each([
  { label: "explicit null", evidence: { executionRawPrice: null } },
  {
    label: "unconfirmed first watch",
    evidence: { executionRawPrice: undefined, firstWatchPayload: "{}" },
  },
] as const)(
  "leaves execution price unknown for $label despite a recorded signal price",
  ({ evidence }) => {
    const key = recordCandidate(evidence);
    saveScan(closeDate, "day");
    expect(eligibility(key)).toEqual({
      freshness: "fresh-close",
      signalPrice: 9.875,
      signalPriceBasis: "forward",
      executionRawPrice: null,
    });
  },
);
