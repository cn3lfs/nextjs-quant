import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { VenueBinding } from "trading-strategies";
import * as spot from "~/server/crypto-trading/adapter";
import { configSchema } from "~/server/crypto-trading/model";
import * as cryptoAccounts from "~/server/crypto-trading/service";
import { getAccountRiskState } from "~/server/db/account-risk-state-repository";
import {
  createDeployment,
  setGlobalAutoLiveEnabled,
} from "~/server/db/deployment-repository";
import { migrate } from "~/server/db/migrations";
import { resolveVenueAdapter } from "~/server/execution/venue-router";
import * as market from "~/server/jobs/workflow-quotes";
import { planningAccount } from "~/server/pipeline/account-coordinator";
import {
  evaluateRegimeGate,
  planOrderIntents,
} from "~/server/pipeline/signal-risk-runner";
import { MockTradingAdapter } from "~/server/portfolio/mock/mock-trading";
import * as mock from "~/server/portfolio/mock/mock-trading-service";

const day = "2026-11-24",
  next = "2026-11-25";
const bindings = [
  { kind: "ths_mock", accountTag: "default" },
  { kind: "crypto_sim", venue: "binance", accountId: "shared" },
  { kind: "crypto_live", venue: "binance", accountId: "shared" },
  {
    kind: "cn_broker_live",
    broker: "http_bridge",
    accountId: "shared",
    endpointUrl: "https://broker.example.invalid",
  },
] as const satisfies readonly VenueBinding[];
let dir: string, db: Database.Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "quant-external-risk-"));
  vi.stubEnv("QUANT_DATA_DIR", dir);
  db = new Database(join(dir, "risk.sqlite"));
  migrate(db);
  setGlobalAutoLiveEnabled(true, db);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("unexpected network request");
    }),
  );
});
afterEach(() => {
  db.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

// Each venue has 100 in its cash balance, 20 available and two marked units.
function venueFixture(binding: VenueBinding) {
  let date = day;
  let mark: number | null = 50;
  const credential = { apiKey: "key", apiSecret: "secret" };
  const symbol = "sh600001";
  vi.spyOn(mock, "mockEnabled").mockReturnValue(true);
  vi.spyOn(mock, "queryMockFunds").mockResolvedValue([
    { zjye: 100, kyje: 20, dje: 80 },
  ]);
  vi.spyOn(MockTradingAdapter.prototype, "positions").mockResolvedValue([
    { symbol, quantity: 2, sellable: 2, cost: 30 },
  ]);
  vi.spyOn(market, "workflowQuotes").mockImplementation(async () =>
    mark === null
      ? new Map()
      : new Map([
          [
            symbol,
            {
              symbol,
              price: mark,
              source: "fixture",
              volume: 1,
              fetchedAt: Date.parse(date),
            },
          ],
        ]),
  );
  vi.spyOn(cryptoAccounts, "getCryptoAccountReadContext").mockResolvedValue({
    config: configSchema.parse({ venue: "binance" }),
    credential,
    revision: "test",
  });
  vi.spyOn(spot, "createSpotAdapter").mockReturnValue({
    tradeHistory: vi.fn(),
    serverNow: vi.fn(),
    rules: vi.fn(),
    candles: vi.fn(),
    place: vi.fn(),
    reconcile: vi.fn(),
    cancel: vi.fn(),
    snapshot: async () => ({
      balances: [
        { asset: "USDT", total: "100", free: "20" },
        { asset: "BTC", total: "2", free: "2" },
      ],
      openOrders: [],
    }),
    price: async () => String(mark ?? 0),
  });

  const fetchImpl: typeof fetch = async (input, init) => {
    expect(init?.method).toBe("GET");
    switch (new URL(String(input)).pathname) {
      case "/account":
        return Response.json({
          cash: 20,
          equity: 100 + 2 * (mark ?? 0),
          positions: [{ symbol, quantity: 2, sellable: 2, lastPrice: mark }],
        });
      case "/api/v3/account":
        return Response.json({
          canTrade: true,
          balances: [
            { asset: "USDT", free: "20", locked: "80" },
            { asset: "BTC", free: "2", locked: "0" },
          ],
        });
      case "/api/v3/ticker/price":
        return Response.json({ price: String(mark ?? 0) });
      default:
        throw new Error("unexpected fixture path");
    }
  };
  return (observedDay: string, price: number | null) => {
    mark = price;
    date = observedDay;
    const router = resolveVenueAdapter(binding, {
      fetchImpl,
      now: () => Date.parse(date + "T05:00:00Z"),
      readCredential: async () => ({ ...credential, token: "fixture" }),
    });
    return router.readAccountState(binding, date, db);
  };
}

it.each(bindings)(
  "$kind uses total balances and priced holdings for a persistent peak, rejecting unpriced snapshots",
  async (binding) => {
    const read = venueFixture(binding);
    const key = planningAccount(binding);
    expect(await read(day, 50)).toMatchObject({
      cash: 20,
      equity: 200,
      drawdownPct: 0,
    });
    expect(await read(day, 75)).toMatchObject({ equity: 250, drawdownPct: 0 });
    expect(getAccountRiskState(key, db)).toMatchObject({
      unitNav: 1.25,
      peakUnitNav: 1.25,
    });
    db.close();
    db = new Database(join(dir, "risk.sqlite"));
    expect(await read(day, 60)).toMatchObject({
      equity: 220,
      drawdownPct: 0.12,
    });
    const peak = getAccountRiskState(key, db);
    expect(await read(next, null)).toMatchObject({ drawdownPct: null });
    expect(getAccountRiskState(key, db)).toEqual(peak);
    expect(await read(next, 62.5)).toMatchObject({
      equity: 225,
      drawdownPct: 0.1,
    });
    expect(getAccountRiskState(key, db)).toMatchObject({
      asOfDate: next,
      unitNav: 1.125,
      peakUnitNav: 1.25,
      drawdownPct: 0.1,
    });
  },
);

it("plans broker buys from priced equity, distinguishing an observed drawdown from a corrupt balance", async () => {
  const binding = bindings[3];
  const symbol = "sh600001";
  const deployment = createDeployment(
    {
      id: "drawdown",
      name: "drawdown",
      market: "cn-equity",
      status: "active",
      executionMode: "shadow",
      venueBinding: binding,
      strategySpec: { kind: "macro-clock" },
      universeSpec: { kind: "fixed-symbols", symbols: [symbol] },
      regimeGate: { kind: "none", unlockAvoidanceDays: 0 },
      riskPolicy: { drawdownPausePct: 0.15 },
      schedule: { kind: "manual_only" },
      provenance: { sourceKind: "manual" },
    },
    db,
  );
  const regimeVerdict = await evaluateRegimeGate(deployment.regimeGate, day);
  async function plan(equity: number | null) {
    const adapter = resolveVenueAdapter(binding, {
      readCredential: async () => "fixture",
      fetchImpl: async () =>
        Response.json({ equity, cash: equity, positions: [] }),
    });
    return planOrderIntents({
      deployment,
      regimeVerdict,
      ownerPositions: [],
      accountState: await adapter.readAccountState(binding, day, db),
      run: { id: "run", decisionDate: day, executeDate: next },
      proposal: {
        mode: "target-weights",
        asOf: day,
        targets: { [symbol]: 0.1 },
        signals: [],
        regimeScale: null,
        disclosure: "",
      },
      deps: { readReferencePrice: () => 10 },
    });
  }
  expect((await plan(100_000)).intents).toMatchObject([
    { symbol, side: "BUY" },
  ]);
  expect((await plan(80_000)).riskVerdict).toMatchObject({
    allowNewEntries: false,
    drawdownPct: 0.2,
    reasons: ["drawdown_pause"],
  });
  const before = getAccountRiskState(planningAccount(binding), db);
  expect((await plan(null)).riskVerdict).toMatchObject({
    allowNewEntries: false,
    drawdownPct: null,
    reasons: ["risk-evidence-missing"],
  });
  expect(getAccountRiskState(planningAccount(binding), db)).toEqual(before);
});
