import Database from "better-sqlite3";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { migrate } from "~/server/db/migrations";
import {
  confirmSimOrder,
  createSimAccount,
  deleteSimAccount,
  ensureDefaultSimAccount,
  getSimAccountDetail,
  listSimAccounts,
  postSimCashFlow,
  previewSimOrder,
  renameSimAccount,
  simPlanBindingGet,
  simPlanBindingSave,
} from "~/server/portfolio/sim-accounts/service";
import { orderTerms, quote } from "~/server/portfolio/sim-accounts/engine";

let db: Database.Database;
const firstDay = "2026-11-19",
  nextDay = "2026-11-20";
beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
});
afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

const equity = (name = "模拟账户", capital = "10000") =>
  createSimAccount({ name, market: "cn-equity", initialCapital: capital }, db)
    .id;
const buy = (accountId: string) => ({
  accountId,
  symbol: "sh600519",
  side: "buy" as const,
  quantity: "100",
  price: "10.00",
  tradeDate: firstDay,
});
const detail = (accountId: string, currentTradeDate = nextDay) =>
  getSimAccountDetail({ accountId, currentTradeDate }, db);

function seedPlan(
  id: string,
  symbol = "SH600519",
  market: "cn-equity" | "crypto" = "cn-equity",
  includeMarket = true,
) {
  db.prepare(
    `INSERT INTO strategies(id,version,market,payload,created_at)
    VALUES(?,1,?,'{}',1) ON CONFLICT(id,version) DO NOTHING`,
  ).run(market, market);
  const payload = JSON.stringify({
    symbol,
    market: includeMarket ? market : undefined,
  });
  db.prepare(
    `INSERT INTO trade_plans
    (id,strategy_id,strategy_version,symbol,sleeve,trigger_key,status,payload,created_at)
    VALUES(?,?,1,?,'test',?,'open',?,1)`,
  ).run(id, market, symbol, id, payload);
}

it("手算买入耗尽 1005.50 元，T+1 解锁，卖出净收 1093.90 元", () => {
  const id = equity("手算账户", "1005.50"),
    order = buy(id);
  const before = detail(id);
  db.pragma("query_only=ON");
  const preview = previewSimOrder(order, db);
  db.pragma("query_only=OFF");
  expect(preview).toMatchObject({
    gross: "1000.00",
    commission: "5.00",
    slippage: "0.50",
    tax: "0.00",
    netCashDelta: "-1005.50",
    cashAfter: "0.00",
  });
  expect(detail(id)).toEqual(before);
  confirmSimOrder({ ...order, clientRequestId: "buy" }, db);
  expect(detail(id, firstDay)).toMatchObject({
    cash: "0.00",
    positions: [
      {
        quantity: "100",
        sellableQuantity: "0",
        costBasis: "1005.50",
        averageCost: "10.05500000",
      },
    ],
  });
  const sell = {
    ...order,
    side: "sell" as const,
    price: "11.00",
    clientRequestId: "sell",
  };
  expect(() => confirmSimOrder(sell, db)).toThrow("可卖数量不足");
  expect(detail(id).positions[0]?.sellableQuantity).toBe("100");
  expect(confirmSimOrder({ ...sell, tradeDate: nextDay }, db)).toMatchObject({
    commission: "5.00",
    tax: "0.55",
    slippage: "0.55",
    netCashDelta: "1093.90",
  });
  expect(detail(id)).toMatchObject({
    cash: "1093.90",
    positions: [],
    cashFlows: [
      { delta: "1093.90" },
      { delta: "-1005.50" },
      { delta: "1005.50" },
    ],
  });
});

it("周五买入的 A 股周末不解锁，周末买卖均拒绝，周一可以卖出", () => {
  const id = equity();
  const order = { ...buy(id), tradeDate: "2026-11-20" };
  confirmSimOrder({ ...order, clientRequestId: "friday" }, db);
  for (const tradeDate of ["2026-11-21", "2026-11-22"]) {
    expect(detail(id, tradeDate).positions[0]?.sellableQuantity).toBe("0");
    for (const side of ["buy", "sell"] as const) {
      const closed = { ...order, tradeDate, side };
      expect(() => previewSimOrder(closed, db)).toThrow("周末休市");
      expect(() =>
        confirmSimOrder({ ...closed, clientRequestId: "weekend" }, db),
      ).toThrow("周末休市");
    }
  }
  const monday = { ...order, tradeDate: "2026-11-23", side: "sell" as const };
  expect(previewSimOrder(monday, db).sellableQuantityBefore).toBe("100");
  confirmSimOrder({ ...monday, clientRequestId: "monday" }, db);
  expect(detail(id, monday.tradeDate).positions).toEqual([]);
});

it("超过最低佣金后，佣金 6.015 元与滑点 10.025 元各自按分四舍五入", () => {
  const id = equity("半分舍入", "20066.05");
  const order = { ...buy(id), price: "200.50", clientRequestId: "half-fen" };
  expect(confirmSimOrder(order, db)).toMatchObject({
    gross: "20050.00",
    commission: "6.02",
    slippage: "10.03",
    netCashDelta: "-20066.05",
  });
  expect(detail(id).cash).toBe("0.00");
});

it("两个同标的账户可复用请求键，本户买卖、出入金、改名和删除均不改变另一户", () => {
  const a = equity("独立甲户"),
    b = equity("独立乙户");
  confirmSimOrder({ ...buy(b), clientRequestId: "same" }, db);
  const untouched = detail(b);
  confirmSimOrder({ ...buy(a), clientRequestId: "same" }, db);
  const flow = {
    accountId: a,
    requestId: "same",
    kind: "deposit" as const,
    amount: "250.00",
  };
  const receipt = postSimCashFlow(flow, db);
  expect(receipt).toMatchObject({ delta: "250.00", requestId: "same" });
  expect(postSimCashFlow({ ...flow, amount: "250" }, db)).toEqual(receipt);
  expect(() => postSimCashFlow({ ...flow, amount: "350" }, db)).toThrow(
    "幂等键冲突",
  );
  postSimCashFlow(
    { ...flow, requestId: "out", kind: "withdrawal", amount: "100.01" },
    db,
  );
  expect(() =>
    postSimCashFlow(
      { ...flow, requestId: "excess", kind: "withdrawal", amount: "100000" },
      db,
    ),
  ).toThrow("资金不足");
  confirmSimOrder(
    { ...buy(a), side: "sell", tradeDate: nextDay, clientRequestId: "sell" },
    db,
  );
  expect(
    renameSimAccount({ accountId: a, name: "  甲户改名  " }, db).name,
  ).toBe("甲户改名");
  expect(detail(a)).toMatchObject({ cash: "10138.49", positions: [] });
  expect(detail(b)).toEqual(untouched);
  deleteSimAccount({ accountId: a }, db);
  expect(() => detail(a)).toThrow("账户不存在");
  expect(detail(b)).toEqual(untouched);
  expect(db.pragma("foreign_key_check")).toEqual([]);
});

it("首次初始化只建一个 100 万中文默认户，删空后重新进入仍为空", () => {
  const [account] = listSimAccounts(db);
  ensureDefaultSimAccount(db);
  expect(listSimAccounts(db)).toEqual([account]);
  expect(account).toMatchObject({
    name: "A股默认模拟账户",
    initialCapital: "1000000.00",
    cash: "1000000.00",
    currency: "CNY",
    revision: 0,
  });
  expect(detail(account!.id).cashFlows).toMatchObject([
    { kind: "opening", delta: "1000000.00" },
  ]);
  deleteSimAccount({ accountId: account!.id }, db);
  ensureDefaultSimAccount(db);
  expect(listSimAccounts(db)).toEqual([]);
  expect(
    db
      .prepare("SELECT kind FROM records WHERE id='sim-accounts:initialized'")
      .get(),
  ).toEqual({ kind: "sim_accounts_initialized" });
});

it("已有用户账户时初始化只写标记；名字按市场唯一，开户拒绝空白和重复", () => {
  const name = "同名账户",
    id = equity(name);
  db.prepare("DELETE FROM records WHERE id='sim-accounts:initialized'").run();
  ensureDefaultSimAccount(db);
  expect(listSimAccounts(db).map((a) => a.id)).toEqual([id]);
  expect(() => equity("    ")).toThrow();
  expect(() => equity("  " + name + "  ")).toThrow();
  expect(
    createSimAccount({ name, market: "crypto", initialCapital: "100" }, db)
      .currency,
  ).toBe("USDT");
});

it("同键确认返回原成交；数量格式等价，价格或来源变更为冲突", () => {
  const id = equity(),
    order = { ...buy(id), clientRequestId: "retry" };
  const receipt = confirmSimOrder(order, db);
  confirmSimOrder(
    { ...order, clientRequestId: "later", tradeDate: nextDay },
    db,
  );
  const before = detail(id);
  expect(
    confirmSimOrder({ ...order, quantity: "100.0", price: "10" }, db),
  ).toEqual(receipt);
  expect(() => confirmSimOrder({ ...order, price: "12" }, db)).toThrow(
    "幂等键冲突",
  );
  expect(() =>
    confirmSimOrder(
      { ...order, executionMode: "plan-auto", planId: "plan1" },
      db,
    ),
  ).toThrow("幂等键冲突");
  expect(detail(id)).toEqual(before);
});

it("拒绝市场、币种、整手、价格精度、日期和已归档账户错误", () => {
  const id = equity(),
    order = buy(id);
  for (const patch of [
    { symbol: "cxBTCUSDT" },
    { currency: "USDT" as const },
    { market: "crypto" as const },
    { quantity: "50" },
    { price: "0.001" },
    { price: "Infinity" },
    { quantity: "-1" },
    { tradeDate: "2026-02-30" },
  ]) {
    expect(() => previewSimOrder({ ...order, ...patch }, db)).toThrow();
  }
  expect(() =>
    confirmSimOrder({ ...order, clientRequestId: "short", side: "sell" }, db),
  ).toThrow("可卖数量不足");
  db.prepare("UPDATE sim_accounts SET status='archived' WHERE id=?").run(id);
  expect(() => previewSimOrder(order, db)).toThrow("已归档");
  expect(() =>
    confirmSimOrder({ ...order, clientRequestId: "archived" }, db),
  ).toThrow("已归档");
  expect(detail(id).trades).toEqual([]);
});

it("整手以外仅允许全额卖清可卖零股", () => {
  const order = { ...buy("fixture"), side: "sell" as const, quantity: "50" };
  const terms = orderTerms(order, "cn-equity");
  expect(() => quote(terms, "cn-equity", 0n, 150n)).toThrow("100股整手");
  expect(quote(terms, "cn-equity", 0n, 50n).delta).toBe(49450n);
});

it("手动与两种计划成交按交易逐笔返回来源并冻结费率", () => {
  const id = equity(),
    order = buy(id);
  confirmSimOrder({ ...order, clientRequestId: "1" }, db);
  for (const mode of ["plan-manual", "plan-auto"] as const) {
    seedPlan("plan-" + mode);
    expect(() =>
      confirmSimOrder(
        { ...order, executionMode: mode, clientRequestId: "bad" },
        db,
      ),
    ).toThrow("planId");
    confirmSimOrder(
      {
        ...order,
        executionMode: mode,
        planId: "plan-" + mode,
        clientRequestId: mode,
      },
      db,
    );
  }
  expect(detail(id).trades.map((t) => [t.executionMode, t.planId])).toEqual([
    ["plan-auto", "plan-plan-auto"],
    ["plan-manual", "plan-plan-manual"],
    ["manual", null],
  ]);
  const rows = db
    .prepare("SELECT rules_json FROM sim_orders WHERE account_id=?")
    .all(id) as { rules_json: string }[];
  for (const row of rows)
    expect(JSON.parse(row.rules_json).costs).toMatchObject({
      commissionBps: 3,
      minimumCommission: 5,
      sellTaxBps: 5,
      slippageBps: 5,
    });
});

it.each(["plan-manual", "plan-auto"] as const)(
  "%s 预览与确认校验计划存在、市场和标的",
  (executionMode) => {
    const id = equity();
    const order = { ...buy(id), executionMode };
    seedPlan("other-symbol", "sz000001");
    seedPlan("other-market", "BTCUSDT", "crypto");
    for (const [planId, error] of [
      ["missing", "计划不存在"],
      ["other-symbol", "标的与委托不匹配"],
      ["other-market", "市场与模拟账户不匹配"],
    ] as const) {
      expect(() => previewSimOrder({ ...order, planId }, db)).toThrow(error);
      expect(() =>
        confirmSimOrder(
          { ...order, planId, clientRequestId: "plan-order" },
          db,
        ),
      ).toThrow(error);
    }
    expect(detail(id).trades).toEqual([]);
    seedPlan("legacy", "SH600519", "cn-equity", false);
    const valid = { ...order, planId: "legacy" };
    expect(previewSimOrder(valid, db).symbol).toBe("sh600519");
    expect(
      confirmSimOrder({ ...valid, clientRequestId: "plan-order" }, db),
    ).toMatchObject({ planId: "legacy", symbol: "sh600519" });
  },
);

it("计划绑定校验市场与账户状态，覆盖保存后只随当前绑定账户删除", () => {
  const first = equity("第一账户"),
    second = equity("第二账户");
  const crypto = createSimAccount(
    { name: "数字账户", market: "crypto", initialCapital: "100" },
    db,
  );
  seedPlan("plan");
  seedPlan("other");
  const binding = { planId: "plan", accountId: first, autoExecute: false };
  expect(simPlanBindingGet("plan", db)).toBeNull();
  expect(simPlanBindingSave(binding, db)).toEqual({
    ...binding,
    updatedAt: expect.any(Number),
  });
  const changed = { ...binding, accountId: second, autoExecute: true };
  const saved = simPlanBindingSave(changed, db);
  expect(saved).toEqual({ ...changed, updatedAt: expect.any(Number) });
  expect(simPlanBindingGet("plan", db)).toEqual(saved);
  expect(
    db
      .prepare("SELECT kind,payload FROM records WHERE id=?")
      .get("sim-plan-binding:plan"),
  ).toEqual({ kind: "sim-plan-binding", payload: JSON.stringify(saved) });
  const other = simPlanBindingSave({ ...binding, planId: "other" }, db);
  expect(() =>
    simPlanBindingSave({ ...binding, planId: "absent" }, db),
  ).toThrow("计划不存在");
  expect(() =>
    simPlanBindingSave({ ...binding, accountId: "absent" }, db),
  ).toThrow("账户不存在");
  expect(() =>
    simPlanBindingSave({ ...binding, accountId: crypto.id }, db),
  ).toThrow("市场与模拟账户不匹配");
  db.prepare("UPDATE sim_accounts SET status='archived' WHERE id=?").run(first);
  expect(() => simPlanBindingSave(binding, db)).toThrow("已归档");
  expect(simPlanBindingGet("plan", db)).toEqual(saved);
  deleteSimAccount({ accountId: second }, db);
  expect(simPlanBindingGet("plan", db)).toBeNull();
  expect(simPlanBindingGet("other", db)).toEqual(other);
});

it("同毫秒按修订序重放移动成本，查询可独立翻页，拒绝倒签成交", () => {
  vi.spyOn(Date, "now").mockReturnValue(1700000000000);
  const id = equity(),
    order = buy(id);
  confirmSimOrder({ ...order, clientRequestId: "1" }, db);
  confirmSimOrder(
    { ...order, price: "20", clientRequestId: "2", tradeDate: nextDay },
    db,
  );
  expect(detail(id).positions).toMatchObject([
    {
      quantity: "200",
      sellableQuantity: "100",
      costBasis: "3011.50",
      averageCost: "15.05750000",
    },
  ]);
  confirmSimOrder(
    { ...order, tradeDate: nextDay, side: "sell", clientRequestId: "3" },
    db,
  );
  const remaining = detail(id);
  expect(remaining.positions).toMatchObject([
    { quantity: "100", sellableQuantity: "0", costBasis: "1505.75" },
  ]);
  expect(() =>
    confirmSimOrder({ ...order, clientRequestId: "backdated" }, db),
  ).toThrow("交易日期早于");
  const query = { accountId: id, limit: 2, currentTradeDate: nextDay },
    page1 = getSimAccountDetail(query, db);
  const page2 = getSimAccountDetail(
    {
      ...query,
      tradeCursor: page1.nextTradeCursor!,
      cashFlowCursor: page1.nextCashFlowCursor!,
    },
    db,
  );
  expect([...page1.trades, ...page2.trades]).toEqual(remaining.trades);
  expect([...page1.cashFlows, ...page2.cashFlows]).toEqual(remaining.cashFlows);
  expect(page2.nextTradeCursor).toBeNull();
  expect(page2.nextCashFlowCursor).toBeNull();
});

it("币种 T+0 使用八位原子，超出 JS 安全整数余额仍逐原子守恒", () => {
  const id = createSimAccount(
    { name: "币种精度", market: "crypto", initialCapital: "90071992.54740993" },
    db,
  ).id;
  const order = {
    ...buy(id),
    symbol: "BTCUSDT",
    tradeDate: "2026-11-21",
    quantity: "0.001",
    price: "60000",
    clientRequestId: "btc",
  };
  const filled = confirmSimOrder(order, db);
  expect(filled).toMatchObject({
    symbol: "cxBTCUSDT",
    gross: "60.00000000",
    commission: "0.06000000",
    tax: "0.00000000",
    slippage: "0.03000000",
    netCashDelta: "-60.09000000",
  });
  expect(confirmSimOrder({ ...order, symbol: "cxBTCUSDT" }, db)).toEqual(
    filled,
  );
  expect(detail(id, order.tradeDate)).toMatchObject({
    cash: "90071932.45740993",
    positions: [
      { sellableQuantity: "0.00100000", averageCost: "60090.00000000" },
    ],
  });
  confirmSimOrder({ ...order, side: "sell", clientRequestId: "sell" }, db);
  expect(detail(id, order.tradeDate)).toMatchObject({
    cash: "90071992.36740993",
    positions: [],
  });
  expect(
    previewSimOrder(
      {
        ...buy(id),
        tradeDate: order.tradeDate,
        symbol: "cxETHUSDT",
        quantity: "0.1",
        price: "15",
      },
      db,
    ).symbol,
  ).toBe("cxETHUSDT");
  expect(() =>
    confirmSimOrder({ ...order, side: "sell", clientRequestId: "short" }, db),
  ).toThrow("可卖数量不足");
  for (const patch of [
    { symbol: "SOLUSDT" },
    { quantity: "0.000000001" },
    { quantity: "0.00000001", price: "0.01" },
    { price: "99999999999999999999" },
    { quantity: "10000000000", price: "10000000000" },
  ]) {
    expect(() =>
      confirmSimOrder({ ...order, ...patch, clientRequestId: "invalid" }, db),
    ).toThrow();
  }
});

it("余额上界逐原子校验，失败出入金不推进修订", () => {
  const id = equity("整数上界", "92233720368547758.07"),
    before = detail(id);
  expect(() =>
    postSimCashFlow(
      { accountId: id, requestId: "too-much", kind: "deposit", amount: "0.01" },
      db,
    ),
  ).toThrow("整数范围");
  expect(detail(id)).toEqual(before);
});

it("结算写失败时订单、成交、余额和修订一起回滚，重试可用原请求键", () => {
  const id = equity(),
    before = detail(id),
    order = { ...buy(id), clientRequestId: "retry" };
  db.exec(
    "CREATE TRIGGER fail_settlement BEFORE INSERT ON sim_cash_flows WHEN NEW.kind='settlement' BEGIN SELECT RAISE(ABORT,'fixture'); END",
  );
  expect(() => confirmSimOrder(order, db)).toThrow("fixture");
  expect(detail(id)).toEqual(before);
  db.exec("DROP TRIGGER fail_settlement");
  expect(confirmSimOrder(order, db).clientRequestId).toBe("retry");
  expect(detail(id).account.revision).toBe(1);
});

it("删除中途受阻会恢复该户全部流水、成交和委托", () => {
  const accountId = equity();
  confirmSimOrder({ ...buy(accountId), clientRequestId: "initial" }, db);
  const before = detail(accountId);
  db.exec(
    "CREATE TRIGGER deny_delete BEFORE DELETE ON sim_orders BEGIN SELECT RAISE(ABORT,'keep'); END",
  );
  expect(() => deleteSimAccount({ accountId }, db)).toThrow("keep");
  expect(detail(accountId)).toEqual(before);
});

it("两个连接争用同一笔余额与可卖股数时，旧预览不能重复成交", () => {
  const path = join(process.env.QUANT_DATA_DIR!, "sim-race.sqlite");
  const a = new Database(path),
    b = new Database(path, { timeout: 0 });
  try {
    a.pragma("journal_mode=WAL");
    migrate(a);
    const id = createSimAccount(
      { name: "并发账户", market: "cn-equity", initialCapital: "1005.50" },
      a,
    ).id;
    const order = buy(id);
    expect(previewSimOrder(order, a)).toEqual(previewSimOrder(order, b));
    a.transaction(() => {
      confirmSimOrder({ ...order, clientRequestId: "winner" }, a);
      expect(() =>
        confirmSimOrder({ ...order, clientRequestId: "loser" }, b),
      ).toThrow(/locked|busy/i);
    }).immediate();
    expect(() =>
      confirmSimOrder({ ...order, clientRequestId: "loser" }, b),
    ).toThrow("资金不足");
    expect(getSimAccountDetail({ accountId: id }, b)).toMatchObject({
      cash: "0.00",
      account: { revision: 1 },
      trades: [{ clientRequestId: "winner" }],
    });
    const sale = { ...order, side: "sell" as const, tradeDate: nextDay };
    expect(previewSimOrder(sale, a)).toEqual(previewSimOrder(sale, b));
    confirmSimOrder({ ...sale, clientRequestId: "first-sale" }, a);
    expect(() =>
      confirmSimOrder({ ...sale, clientRequestId: "second-sale" }, b),
    ).toThrow("可卖数量不足");
    expect(getSimAccountDetail({ accountId: id }, b).positions).toEqual([]);
  } finally {
    b.close();
    a.close();
  }
});
