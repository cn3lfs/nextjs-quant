import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  PortfolioAccount,
  actionPrice,
  type PortfolioAction,
} from "../../../packages/quant-backtest/src/portfolio-account";
import { runPortfolio, type PortfolioRequest } from "quant-backtest";
import { defaultExecutionCosts } from "trading-strategy-core/costs";
import { researchCorporateActions } from "~/server/research/corporate-actions";
import { corporateActions } from "~/server/market/bar-store/corporate-actions";
import * as localSource from "~/server/market/bar-store/local-source";
import { migrate } from "~/server/db/migrations";
import { PaperRepository } from "~/server/db/paper-repository";
import { summarizePaper } from "~/server/paper/assessment";
import { paperAccountsRead } from "~/server/paper/read-projection";
import type { FrozenCandidate, PaperAccount } from "~/server/paper/model";
import paperCandidates from "~/server/data/paper-candidates.json";
import gbbqFixture from "../../fixtures/tdx-gbbq.json";

const day = ["2026-10-09", "2026-10-12", "2026-10-13", "2026-10-14"];
const action = (patch: Partial<PortfolioAction>): PortfolioAction => ({
  date: day[2]!,
  availableAt: day[2]!,
  dividend: 0,
  bonus: 0,
  evidence: "Fixed GBBQ entitlement scenario",
  cashAvailableAt: patch.date ?? day[2]!,
  ...patch,
  timingAssumption: "ex-date-research-scenario",
});
describe("corporate action accounting", () => {
  it.each([
    ["cash", { dividend: 1 }, 100, 9, 100],
    ["bonus", { bonus: 0.3, sharesSellableAt: day[2] }, 130, 1000 / 130, 0],
    ["split", { shareFactor: 2 }, 200, 5, 0],
    ["consolidation", { shareFactor: 0.5 }, 50, 20, 0],
    ["rights declined", { rightsRatio: 0.5, rightsPrice: 4 }, 100, 10, 0],
  ] as const)(
    "hand-calculates %s without subscribing or inventing cash",
    (_name, patch, quantity, cost, cash) => {
      const a = new PortfolioAccount(1000);
      a.fill("A", day[1]!, "buy", 100, 10, 0, 1);
      const audit = a.corporateAction("A", action(patch), true)!;
      expect(a.positions.get("A")!.quantity).toBe(quantity);
      expect(a.positions.get("A")!.cost).toBeCloseTo(cost, 12);
      expect(a.cash).toBe(cash);
      expect(audit.rightsParticipation).toBe("none");
      if ("rightsRatio" in patch && patch.rightsRatio)
        expect(a.positions.get("A")!.mark).toBe(8); // (10+.5*4)/1.5
    },
  );
  it("discloses GBBQ timing and credits the dividend on the ex-date in the research ledger", () => {
    const date = day[2]!;
    const [observed] = researchCorporateActions(
      [{ date, name: "除权除息", category: 1, dividend: 1, bonusRatio: 0.1 }],
      "fixture",
      date,
      date,
    );
    expect(observed).toMatchObject({
      date,
      availableAt: date,
      cashAvailableAt: date,
      sharesSellableAt: date,
      timingAssumption: "ex-date-research-scenario",
      evidence: expect.stringContaining("派息日/送转上市日未知"),
    });
    const replay = runPortfolio(request(date, observed!));
    expect(replay.curve.find((point) => point.date === day[1])?.cash).toBe(0);
    expect(replay.curve.find((point) => point.date === date)?.cash).toBe(1000);
    expect(
      JSON.parse(JSON.stringify(replay)).corporateActions[0],
    ).toMatchObject({
      date,
      cash: 1000,
      cashAvailableAt: date,
      timingAssumption: "ex-date-research-scenario",
    });
  });
  it("publishes the price-index basis with the same paper benchmark return", () => {
    const replay = request(day[2]!, { dividend: 1 });
    const account: PaperAccount = {
      id: "benchmark-fixture",
      market: "cn-equity",
      currency: "CNY",
      sleeve: "swing",
      startedAt: Date.parse(day[0]!),
      initial: replay.initial,
      candidates: [
        {
          ...(paperCandidates.candidates[0] as unknown as FrozenCandidate),
          strategy: replay.strategies[0]!,
        },
      ],
      mirror: { venue: "off" },
      mirrorRevision: "fixture",
      revision: 0,
      lastBar: null,
      lastRun: null,
      error: null,
      summary: null,
    };
    const benchmark = replay.instruments[0]!.bars.map((b) => ({ ...b }));
    account.summary = summarizePaper(
      account,
      {
        request: replay,
        result: runPortfolio(replay),
        benchmark,
        decisions: [],
      },
      Date.parse("2026-10-15"),
    );
    const db = new Database(":memory:");
    try {
      migrate(db);
      const repo = new PaperRepository(db);
      repo.create(account);
      expect(paperAccountsRead(repo)[0]?.summary).toMatchObject({
        benchmarkName: "中证800价格指数（不含股息）",
        benchmarkReturn: 9 / 10 - 1,
      });
    } finally {
      db.close();
    }
  });
  it("withholds dividend tax at the declared rate", () => {
    const a = new PortfolioAccount(1000);
    a.fill("A", day[1]!, "buy", 100, 10, 0, 1);
    // 100 shares × 1 CNY dividend × (1 − 10%) = 90 CNY cash.
    a.corporateAction("A", action({ dividend: 1 }), true, 1000);
    expect(a.cash).toBeCloseTo(90, 12);
  });
  it("preserves T+1 locks across splits and explicit bonus availability", () => {
    const a = new PortfolioAccount(10000);
    a.fill("A", day[2]!, "buy", 100, 10, 0, 1);
    a.corporateAction("A", action({ shareFactor: 2 }), true);
    expect(a.sellable("A", day[2]!, 1)).toBe(0);
    expect(a.sellable("A", day[3]!, 1)).toBe(200);
    a.corporateAction(
      "A",
      action({ bonus: 0.1, sharesSellableAt: day[3] }),
      true,
    );
    expect(a.sellable("A", day[2]!, 1)).toBe(0);
    expect(a.sellable("A", day[3]!, 1)).toBe(220);
  });
  it("rounds once to whole shares, retains odd lots, and sells all odd shares together", () => {
    const a = new PortfolioAccount(1010);
    a.fill("A", day[1]!, "buy", 101, 10, 0, 1);
    const applied = a.corporateAction(
      "A",
      action({ bonus: 0.15, sharesSellableAt: day[2] }),
      true,
    )!;
    expect(applied.quantity).toBe(116); // 101*1.15=116.15; no .15-share cash invented
    expect(applied.fractionalShares).toBeCloseTo(0.15, 12);
    expect(a.cash).toBe(0);
    expect(a.sellable("A", day[2]!, 1)).toBe(116);
    a.fill("A", day[2]!, "sell", 116, 10 / 1.15, 0, 1);
    expect(a.positions.size).toBe(0);
    expect(a.cash).toBeCloseTo(1160 / 1.15, 10);
  });
  function request(
    exDate: string,
    patch: Partial<PortfolioAction>,
  ): PortfolioRequest {
    const a = action({ ...patch, date: exDate, availableAt: exDate });
    const bars = day.map((date) => {
      const price = date >= exDate ? actionPrice(10, a) : 10;
      return {
        date,
        open: price,
        close: price,
        high: price * 1.01,
        low: price * 0.99,
        volume: 10000,
        amount: 100000,
      };
    });
    return {
      market: "cn-equity",
      initial: 10000,
      start: day[0]!,
      end: day[3]!,
      calendar: day,
      instruments: [
        {
          symbol: "A",
          market: "cn-equity",
          bars,
          signalBars: bars.map((b) => ({
            ...b,
            open: 10,
            close: 10,
            high: 10.1,
            low: 9.9,
          })),
          actions: [a],
          execution: {
            evidence: "fixture",
            tradable: true,
            limitUp: null,
            limitDown: null,
          },
        },
      ],
      strategies: [
        {
          id: "fixture",
          version: 1,
          market: "cn-equity",
          period: "day",
          sleeve: "swing",
          universe: { kind: "symbols", symbols: ["A"] },
          entry: { kind: "constant", value: true },
          exit: { stop: { kind: "fixed", fraction: 0.1 } },
          sizing: { kind: "weight", weight: 1 },
        },
      ],
      sleeves: [{ id: "swing", share: 1, riskPerTrade: 1, maxPositions: 1 }],
      costs: {
        ...defaultExecutionCosts,
        commissionBps: 0,
        minimumCommission: 0,
        slippageBps: 0,
        sellTaxBps: 0,
      },
    };
  }
  it.each([
    { bonus: 1, sharesSellableAt: day[2] },
    { shareFactor: 2 },
    { shareFactor: 0.5 },
    { dividend: 1 },
    { rightsRatio: 0.5, rightsPrice: 4 },
  ])(
    "applies action before open to holdings and rebases protection: %j",
    (patch) => {
      const r = runPortfolio(request(day[2]!, patch));
      expect(r.fills.filter((f) => f.side === "sell")).toEqual([]); // ex-price never trips the old raw stop
      expect(r.corporateActions).toHaveLength(1);
      expect(r.positions[0]!.quantity).toBe(
        patch.bonus
          ? 2000
          : patch.shareFactor
            ? 1000 * patch.shareFactor
            : 1000,
      );
      expect(r.equity.at(-1)!.equity).toBeCloseTo(
        patch.rightsRatio ? 8000 : 10000,
        10,
      );
    },
  );
  it("a pending entry on ex-date receives no entitlement and uses the ex-date open", () => {
    const r = runPortfolio(request(day[1]!, { shareFactor: 2 }));
    expect(r.corporateActions).toEqual([]);
    expect(r.fills[0]).toMatchObject({
      date: day[1],
      price: 5,
      quantity: 2000,
    });
    expect(r.equity.at(-1)!.equity).toBe(10000);
  });
  it.each([false, true])(
    "a queued exit includes odd bonus shares and honors their separate availability (delayed=%s)",
    (delayed) => {
      const q = request(day[2]!, {
        bonus: 0.15,
        sharesSellableAt: day[delayed ? 3 : 2],
      });
      q.initial = 1000;
      q.strategies[0]!.entry = {
        kind: "external",
        id: "timing",
        side: "entry",
      };
      q.strategies[0]!.exit = {
        rule: { kind: "external", id: "timing", side: "exit" },
      };
      q.instruments[0]!.external = {
        signals: day.map((date, i) => ({
          id: "timing",
          date,
          availableAt: date,
          entry: i === 0,
          exit: i === 1,
        })),
      };
      const r = runPortfolio(q);
      expect(r.fills.map((f) => [f.side, f.date, f.quantity])).toEqual(
        delayed
          ? [
              ["buy", day[1], 100],
              ["sell", day[2], 100],
              ["sell", day[3], 15],
            ]
          : [
              ["buy", day[1], 100],
              ["sell", day[2], 115],
            ],
      );
      expect(r.positions).toEqual([]);
      expect(r.equity.at(-1)!.equity).toBeCloseTo(1000, 10);
    },
  );
  it("rejects malformed action ratios and missing entitlement dates", () => {
    for (const patch of [
      { shareFactor: 0 },
      { rightsRatio: 1 },
      { bonus: 1 },
      { shareFactor: NaN },
      { cashAvailableAt: day[3] },
    ]) {
      const q = request(day[2]!, {});
      q.instruments[0]!.actions = [action(patch)];
      expect(() => runPortfolio(q)).toThrow("corporate action");
    }
  });
  it("applies an action during a calendar gap on the next event before a pending sale", () => {
    const sunday = "2026-10-11",
      thursday = "2026-10-08";
    const q = request(sunday, { shareFactor: 2 });
    q.start = thursday;
    q.calendar = [thursday, ...day];
    const source = q.instruments[0]!;
    const previous = { ...source.bars[0]!, date: thursday };
    source.bars = [previous, ...source.bars];
    source.signalBars = [
      { ...source.signalBars[0]!, date: thursday },
      ...source.signalBars,
    ];
    q.strategies[0]!.entry = { kind: "external", id: "timing", side: "entry" };
    q.strategies[0]!.exit = {
      rule: { kind: "external", id: "timing", side: "exit" },
    };
    source.external = {
      signals: q.calendar.map((date, i) => ({
        id: "timing",
        date,
        availableAt: date,
        entry: i === 0,
        exit: i === 1,
      })),
    };
    const result = runPortfolio(q);
    expect(
      result.fills.map((f) => [f.side, f.date, f.quantity, f.price]),
    ).toEqual([
      ["buy", day[0], 1000, 10],
      ["sell", day[1], 2000, 5],
    ]);
    expect(result.equity.at(-1)!.equity).toBe(10000);
  });
});

it("invalidates cached GBBQ actions and SHA-256 when sampled bytes change under the same stat identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "gbbq-cache-"));
  const directory = join(root, "T0002", "hq_cache");
  const path = join(directory, "gbbq");
  const body = Buffer.from(gbbqFixture.gbbqBase64, "base64");
  const fixedTime = new Date("2026-11-13T00:00:00Z");
  await mkdir(directory, { recursive: true });
  await writeFile(path, body);
  await utimes(path, fixedTime, fixedTime);
  const initialStat = await stat(path);
  // Simulate a filesystem that also preserves the finer stat identity.
  const fingerprint = vi
    .spyOn(localSource, "sourceFingerprint")
    .mockResolvedValue(`${path}:fixed-stat-identity`);
  try {
    const first = await corporateActions(root);
    expect(first.events.size).toBeGreaterThan(0);
    expect((await corporateActions(root)).events).toBe(first.events);

    body.writeUInt32LE(0);
    await writeFile(path, body);
    await utimes(path, fixedTime, fixedTime);
    const rewrittenStat = await stat(path);
    expect(rewrittenStat.size).toBe(initialStat.size);
    expect(rewrittenStat.mtimeMs).toBe(initialStat.mtimeMs);

    const rewritten = await corporateActions(root);
    expect(rewritten.events.size).toBe(0);
    expect(rewritten.fingerprint).not.toBe(first.fingerprint);
    expect((await corporateActions(root)).events).toBe(rewritten.events);
  } finally {
    fingerprint.mockRestore();
  }
});
