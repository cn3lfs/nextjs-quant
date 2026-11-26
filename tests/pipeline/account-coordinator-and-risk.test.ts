import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { big } from "trading-strategy-core/money";
import { migrate } from "~/server/db/migrations";
import { getAccountRiskState } from "~/server/db/account-risk-state-repository";
import { SimAccountRepository } from "~/server/db/sim-account-repository";
import { readLocalSimAccountState } from "~/server/pipeline/local-account-state";
import { executePipelineSimOrder } from "~/server/portfolio/sim-accounts/service";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
});
afterEach(() => db.close());

it("100 → 120 → 108 按已确认的峰值回撤 10%；60 元申购与赎回均按 1.2 成交", async () => {
  const repo = new SimAccountRepository(db);
  const id = "peak";
  const dates = [
    "2024-04-15",
    "2024-04-16",
    "2024-04-17",
    "2024-04-18",
    "2024-04-19",
  ] as const;
  const at = (d: string) => Date.parse(d + "T10:00:00Z");
  repo.open(id, "peak", "crypto", 10000000000n, at(dates[0]));
  const fill = await executePipelineSimOrder(
    {
      accountId: id,
      clientRequestId: "seed",
      symbol: "BTCUSDT",
      side: "buy",
      quantity: 1,
      price: 10,
      tradeDate: dates[0],
    },
    db,
    at(dates[0]),
  );
  const cash = big(100).plus(fill.netCashDelta);
  // One unit of the asset: marked equity minus observed fee-inclusive cash gives its price.
  const prices = new Map(
    dates.map((d, i) => [
      d as string,
      big([100, 120, 120, 120, 108][i]!).minus(cash).toNumber(),
    ]),
  );
  const read = (d: string) =>
    readLocalSimAccountState(id, d, db, (_s, date) => prices.get(date) ?? null);
  repo.insertFlow(
    id,
    2n,
    "cash:in",
    "deposit",
    6000000000n,
    null,
    at(dates[2]),
    "",
  );
  repo.insertFlow(
    id,
    3n,
    "cash:out",
    "withdrawal",
    -6000000000n,
    null,
    at(dates[3]),
    "",
  );
  const key = { accountScope: "local_sim", accountId: id } as const;
  for (const [i, expected] of [100, 120, 180, 120, 108].entries()) {
    expect((await read(dates[i]!)).equity).toBe(expected);
    expect(getAccountRiskState(key, db)).toMatchObject({
      unitNav: [1, 1.2, 1.2, 1.2, 1.08][i],
      peakUnitNav: i === 0 ? 1 : 1.2,
      drawdownPct: i === 4 ? 0.1 : 0,
      regime: i === 4 ? "halted" : "normal",
    });
  }
  expect(await read(dates[2])).toMatchObject({ equity: 180, drawdownPct: 0 });
  expect(getAccountRiskState(key, db)?.asOfDate).toBe(dates[4]);
});

it("沪市资金按北京时间切日，决策日之后的开户、入金和出金均不可见", async () => {
  const repo = new SimAccountRepository(db);
  const id = "cutoff";
  repo.open(
    id,
    "cutoff",
    "cn-equity",
    10000n,
    Date.parse("2024-04-15T00:00:00+08:00"),
  );
  repo.insertFlow(
    id,
    1n,
    "cash:in",
    "deposit",
    6000n,
    null,
    Date.parse("2024-04-15T23:59:59+08:00"),
    "",
  );
  repo.insertFlow(
    id,
    2n,
    "cash:out",
    "withdrawal",
    -500n,
    null,
    Date.parse("2024-04-16T00:00:00+08:00"),
    "",
  );
  const read = (date: string) => readLocalSimAccountState(id, date, db);
  expect(await read("2024-04-14")).toMatchObject({
    cash: 0,
    drawdownPct: null,
  });
  expect(await read("2024-04-15")).toMatchObject({
    cash: 160,
    equity: 160,
    drawdownPct: 0,
  });
  expect(await read("2024-04-16")).toMatchObject({
    cash: 155,
    equity: 155,
    drawdownPct: 0,
  });
});
