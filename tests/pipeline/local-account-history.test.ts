import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { big } from "trading-strategy-core/money";
import { migrate } from "~/server/db/migrations";
import { getAccountRiskState } from "~/server/db/account-risk-state-repository";
import { SimAccountRepository } from "~/server/db/sim-account-repository";
import { readLocalSimAccountState } from "~/server/pipeline/local-account-state";
import { executePipelineSimOrder } from "~/server/portfolio/sim-accounts/service";

const dates = ["2024-04-15", "2024-04-16", "2024-04-17"] as const;
const at = (day: string, time = "10:00") =>
  Date.parse(day + "T" + time + ":00Z");
const id = "history",
  key = { accountScope: "local_sim", accountId: id } as const;
let db: Database.Database;
let repo: SimAccountRepository;
beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  repo = new SimAccountRepository(db);
  repo.open(id, id, "crypto", 10000000000n, at(dates[0], "08:00"));
});
afterEach(() => db.close());

function trade(
  day: string,
  side: "buy" | "sell",
  quantity: number,
  price: number,
  createdAt = at(day),
) {
  return executePipelineSimOrder(
    {
      accountId: id,
      symbol: "BTCUSDT",
      tradeDate: day,
      side,
      quantity,
      price,
      clientRequestId: side + createdAt,
    },
    db,
    createdAt,
  );
}

it("只读取首尾两日，仍重放中间收盘高点，缺报价时保留可恢复的上一日", async () => {
  const fill = trade(dates[0], "buy", 1, 10);
  const cash = big(100).plus(fill.netCashDelta);
  const prices = new Map<string, number>();
  for (const [i, day] of dates.entries())
    prices.set(day, big([100, 120, 108][i]!).minus(cash).toNumber());
  let missingPeak = true;
  const close = vi.fn((_symbol: string, day: string) =>
    day === dates[1] && missingPeak ? null : (prices.get(day) ?? null),
  );
  const read = (day: string) => readLocalSimAccountState(id, day, db, close);
  expect(await read(dates[0])).toMatchObject({ equity: 100, drawdownPct: 0 });
  expect(await read(dates[2])).toMatchObject({
    equity: 108,
    drawdownPct: null,
  });
  expect(getAccountRiskState(key, db)?.asOfDate).toBe(dates[0]);
  missingPeak = false;
  close.mockClear();
  expect(await read(dates[2])).toMatchObject({
    drawdownPct: 0.1,
    riskRegime: "halted",
  });
  expect(close.mock.calls.map(([, day]) => day)).toEqual([dates[1], dates[2]]);
  expect(getAccountRiskState(key, db)).toMatchObject({
    unitNav: 1.08,
    peakUnitNav: 1.2,
  });
});

it("日内买入后申购、部分卖出后赎回，各按流水发生前已知成交价计算份额", async () => {
  const buy = trade(dates[1], "buy", 2, 10);
  repo.insertFlow(
    id,
    2n,
    "in",
    "deposit",
    5000000000n,
    null,
    at(dates[1], "11:00"),
    "",
  );
  repo.advance(id, at(dates[1], "11:00"));
  const sell = trade(dates[2], "sell", 1, 24);
  repo.insertFlow(
    id,
    4n,
    "out",
    "withdrawal",
    -3000000000n,
    null,
    at(dates[2], "11:00"),
    "",
  );
  const mark = (_symbol: string, day: string) =>
    day === dates[2] ? 24 : day === dates[1] ? 11 : 80;
  await readLocalSimAccountState(id, dates[2], db, mark);
  const buyCash = big(100).plus(buy.netCashDelta);
  const subscriptionNav = buyCash.plus(20).div(100);
  const subscribedUnits = big(100).plus(big(50).div(subscriptionNav));
  const beforeWithdrawal = buyCash.plus(50).plus(sell.netCashDelta).plus(24);
  expect(getAccountRiskState(key, db)?.unitNav).toBeCloseTo(
    beforeWithdrawal.div(subscribedUnits).toNumber(),
    12,
  );
  expect(repo.riskCheckpoint(id, dates[1])?.risk.unitNav).toBeCloseTo(
    buyCash.plus(50).plus(22).div(subscribedUnits).toNumber(),
    12,
  );
});

it("同一天按冻结时刻裁切开户、成交及结算和外部流水，次日补记的旧成交不改旧决策", async () => {
  const before = at(dates[0], "09:00");
  const fill = trade(dates[0], "buy", 1, 10);
  repo.insertFlow(
    id,
    2n,
    "in",
    "deposit",
    2000000000n,
    null,
    at(dates[0], "11:00"),
    "",
  );
  repo.advance(id, at(dates[0], "11:00"));
  trade(dates[0], "buy", 1, 30, at(dates[1]));
  const read = (day: string, time?: number) =>
    readLocalSimAccountState(id, day, db, () => 10, day, time);
  expect(await read(dates[0], at(dates[0], "07:59"))).toMatchObject({
    cash: 0,
    positions: [],
  });
  expect(await read(dates[0], before)).toMatchObject({
    cash: 100,
    positions: [],
  });
  expect(await read(dates[0], at(dates[0]))).toMatchObject({
    cash: big(100).plus(fill.netCashDelta).toNumber(),
    positions: [{ quantity: 1 }],
  });
  const firstDecision = await read(dates[0]);
  expect(firstDecision).toMatchObject({
    cash: big(120).plus(fill.netCashDelta).toNumber(),
    positions: [{ quantity: 1 }],
  });
  expect(await read(dates[1])).toMatchObject({ positions: [{ quantity: 2 }] });
  expect(await read(dates[0])).toEqual(firstDecision);
  expect(getAccountRiskState(key, db)?.asOfDate).toBe(dates[1]);
});

it("同一收盘日更早的冻结时刻独立回放，不继承稍后记入的亏损熔断状态", async () => {
  const cn = "cn-close";
  const time = (clock: string) =>
    Date.parse(dates[0] + "T" + clock + ":00+08:00");
  repo.open(cn, cn, "cn-equity", 100550n, time("09:00"));
  executePipelineSimOrder(
    {
      accountId: cn,
      symbol: "sh600000",
      tradeDate: dates[0],
      side: "buy",
      quantity: 100,
      price: 10,
      clientRequestId: "after-close",
    },
    db,
    time("16:00"),
  );
  const read = (clock: string) =>
    readLocalSimAccountState(cn, dates[0], db, () => 8, dates[0], time(clock));
  expect(await read("16:01")).toMatchObject({
    equity: 800,
    riskRegime: "halted",
  });
  expect(await read("15:30")).toMatchObject({
    equity: 1005.5,
    riskRegime: "normal",
    drawdownPct: 0,
  });
  expect(getAccountRiskState({ ...key, accountId: cn }, db)?.regime).toBe(
    "halted",
  );
  const changes = () => db.prepare("SELECT total_changes() n").get();
  const prior = changes();
  await read("16:01");
  expect(changes()).toEqual(prior);
});
