import { beforeEach, afterEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { migrate } from "../src/server/db/migrations";
import { TradeLedgerStore } from "../src/server/portfolio/trade-ledger-store";
import {
  positionFor,
  tradeInputSchema,
  tradeFees,
  tradedSignalComparison,
  type TradeInput,
  type CorporateEvidence,
} from "../src/lib/trade-ledger";
import { tradingLedgerMethods } from "../src/server/research/research-skills";
import type { SkillUse } from "../src/server/research/research-skills";
import type { LedgerRow } from "../src/lib/signal-ledger";
import { TradeLedgerPanel } from "../src/components/portfolio/trade-ledger-panel";
vi.mock("../src/app/trade-ledger/actions", () => ({
  saveTrade: vi.fn(),
  toggleMock: vi.fn(),
  createMockAccount: vi.fn(),
  reconcileAccount: vi.fn(),
  previewOrder: vi.fn(),
  confirmOrder: vi.fn(),
  updateStop: vi.fn(),
  saveBonusListing: vi.fn(),
}));
const days = ["2026-09-10", "2026-09-11", "2026-09-14", "2026-09-15"];
const evidence: CorporateEvidence = {
  events: [],
  coverageEnd: days.at(-1)!,
  source: "controlled-gbbq",
};
const methods: SkillUse[] = ["astock-market-rules", "mock-trading"].map(
  (skillId) => ({
    skillId,
    ruleVersion: "fixture",
    outputSchema: "fixture",
    files: [{ file: "SKILL.md", hash: "fixture" }],
    prerequisites: [],
  }),
);
const input = (patch: Partial<TradeInput> = {}): TradeInput => ({
  id: crypto.randomUUID(),
  symbol: "sh600519",
  date: days[0]!,
  side: "buy",
  quantity: 100,
  price: 10,
  lowerLimit: 1,
  upperLimit: 30,
  limitSource: "fixture当日上下限",
  signalId: null,
  stop: 9,
  note: "",
  ...patch,
});
let db: Database.Database, store: TradeLedgerStore;
beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  store = new TradeLedgerStore(db);
});
afterEach(() => db.close());
const record = (t: TradeInput, e = evidence) =>
  store.record(t, {
    today: days.at(-1)!,
    calendar: days,
    methods,
    evidence: e,
  });
const position = (day = days[1]!, e = evidence) =>
  positionFor("sh600519", store.trades(), day, days, e, {
    price: 12,
    date: day,
  });

it("local entry -> persisted moving cost -> T+1 -> sale -> floating P&L -> audited ex-adjustment", () => {
  record(input()); // 1000 + 5 commission + 0.5 slippage = 1005.5
  expect(position(days[0]).sellable).toBe(0);
  expect(position().sellable).toBe(100);
  record(input({ date: days[1], price: 12 })); // 1200 + 5 + 0.6 = 1205.6
  let p = position();
  expect(p.quantity).toBe(200);
  expect(p.averageCost).toBeCloseTo((1005.5 + 1205.6) / 200, 8);
  expect(p.sellable).toBe(100);
  record(input({ date: days[1], side: "sell", price: 12 }));
  p = position();
  expect(p.quantity).toBe(100);
  expect(p.sellable).toBe(0);
  expect(p.averageCost).toBeCloseTo(11.0555, 8);
  expect(p.realized).toBeCloseTo(1200 - 5 - 0.6 - 0.6 - 1105.55, 8);
  expect(p.floating).toBeCloseTo((12 - 11.0555) * 100, 8);
  expect(p.stopDistancePct).toBeCloseTo(25, 8);
  const ex: CorporateEvidence = {
    ...evidence,
    events: [
      {
        date: days[2]!,
        category: 1,
        name: "除权除息",
        dividend: 1,
        bonusRatio: 1,
        rightsRatio: 0,
      },
    ],
  };
  p = position(days[2], ex);
  expect(p.quantity).toBe(200);
  expect(p.adjustedCost).toBeCloseTo((1105.55 - 100) / 200, 8);
  expect(p.sellable).toBe(100); // Bonus availability date is absent from GBBQ.
  store.archive(p.adjustments);
  store.archive(p.adjustments);
  expect(store.adjustments()).toHaveLength(1);
  expect(store.adjustments()[0]).toMatchObject({
    beforeCost: 11.0555,
    beforeQuantity: 100,
    afterQuantity: 200,
    source: "controlled-gbbq",
  });
  expect(new TradeLedgerStore(db).trades()).toHaveLength(3);
});
it("rejects same-day selling, excess sales and days outside exchange calendar, including weekends", () => {
  record(input());
  expect(() => record(input({ side: "sell" }))).toThrow("T+1");
  expect(() =>
    record(input({ side: "sell", date: days[1], quantity: 200 })),
  ).toThrow("T+1");
  expect(() => record(input({ date: "2026-09-12" }))).toThrow("交易日历");
  expect(
    positionFor("sh600519", store.trades(), "2026-09-12", days, evidence)
      .sellable,
  ).toBe(0);
  expect(store.trades()).toHaveLength(1);
});
it.each([
  { quantity: 101 },
  { quantity: 0 },
  { price: 31 },
  { price: 0.5 },
  { price: NaN },
  { date: "2026-02-30" },
  { lowerLimit: 31 },
  { limitSource: "" },
])("rejects violating lot/price/date/source input %j", (patch) => {
  expect(() => tradeInputSchema.parse(input(patch))).toThrow();
});
it("allows prices exactly on both limits without inferring a fill or changing the limits", () => {
  expect(tradeInputSchema.parse(input({ price: 1 })).price).toBe(1);
  expect(tradeInputSchema.parse(input({ price: 30 })).price).toBe(30);
});
it("request identity is idempotent and cannot silently replace a fill", () => {
  const t = input();
  record(t);
  record(t);
  expect(store.trades()).toHaveLength(1);
  expect(() => record({ ...t, price: 11 })).toThrow("不同内容");
});
it("GBBQ missing/insufficient coverage blanks adjusted cost and floating rather than claiming no events", () => {
  record(input());
  for (const coverageEnd of [null, days[0]!]) {
    const p = position(days[1], { ...evidence, coverageEnd });
    expect(p.averageCost).toBe(10.055);
    expect(p.adjustedCost).toBeNull();
    expect(p.floating).toBeNull();
    expect(p.adjustmentStatus).toBe("成本未按除权调整");
  }
});
it("rights subscription without actual receipt evidence stays explicitly unresolved", () => {
  record(input());
  const p = position(days[1], {
    ...evidence,
    events: [
      {
        date: days[1]!,
        category: 1,
        name: "配股",
        rightsRatio: 0.3,
        rightsPrice: 4,
      },
    ],
  });
  expect(p.adjustedCost).toBeNull();
  expect(p.floating).toBeNull();
  expect(p.adjustments[0]!.event.rightsRatio).toBe(0.3);
  expect(p.adjustments[0]!.beforeCost).toBe(10.055);
});
it("ex-event before entry does not adjust a new holder; future events do not rewrite earlier positions", () => {
  record(input());
  const baseline = position();
  const events = [
    { date: "2026-09-09", category: 1, name: "除息", dividend: 1 },
    { date: days[2]!, category: 1, name: "除息", dividend: 2 },
  ];
  expect(position(days[1], { ...evidence, events })).toEqual(baseline);
});
it("new GBBQ observations preserve previous adjustment audit versions", () => {
  record(input());
  for (const dividend of [1, 2])
    store.archive(
      position(days[1], {
        ...evidence,
        events: [{ date: days[1]!, category: 1, name: "除息", dividend }],
      }).adjustments,
    );
  expect(store.adjustments()).toHaveLength(2);
});
it("confirmed bonus listing releases shares on the explicitly supplied availability date", () => {
  record(input());
  const ex: CorporateEvidence = {
    ...evidence,
    events: [{ date: days[1]!, category: 1, name: "送转", bonusRatio: 1 }],
    bonusListings: {
      [days[1]!]: { date: days[2]!, source: "账户显示可卖日期" },
    },
  };
  expect(position(days[1], ex).sellable).toBe(100);
  expect(position(days[2], ex).sellable).toBe(200);
  record(input({ side: "sell", quantity: 200, date: days[2]! }), ex);
  expect(position(days[2], ex).quantity).toBe(0);
});
it("pre-ex quote cannot produce a floating profit against post-ex cost", () => {
  record(input());
  const p = positionFor(
    "sh600519",
    store.trades(),
    days[1]!,
    days,
    {
      ...evidence,
      events: [{ date: days[1]!, category: 1, name: "除息", dividend: 1 }],
    },
    { price: 10, date: days[0]! },
  );
  expect(p.adjustedCost).toBeCloseTo(9.055);
  expect(p.floating).toBeNull();
});
it("manual fills can omit signals; linked signal must exist for the same symbol and not be from the future", () => {
  record(input());
  expect(() => record(input({ signalId: "absent" }))).toThrow("关联信号");
  db.prepare("INSERT INTO signal_ledger VALUES (?,?,?,?)").run(
    "s1",
    "sh600519",
    days[0],
    "{}",
  );
  record(input({ signalId: "s1" }));
  expect(() => record(input({ symbol: "sz000001", signalId: "s1" }))).toThrow(
    "关联信号",
  );
  expect(store.trades()[1]!.signalId ?? store.trades()[0]!.signalId).toBe("s1");
});
it("done/not-done grouping uses equal N1 returns and does not count multiple fills as extra signals", () => {
  const rows = ["s1", "s2"].map((id, i) => ({
    id,
    strategy: "czsc",
    quality: "2",
    outcomes: [{ horizon: 5, returnPct: i ? -2 : 4, reasons: [] }],
  })) as unknown as LedgerRow[];
  const t = {
    ...input({ signalId: "s1" }),
    createdAt: 1,
    methods,
    costs: {
      version: "cost-experiment-1",
      commissionBps: 3,
      minimumCommission: 5,
      sellTaxBps: 5,
      slippageBps: 5,
    },
    fees: tradeFees(input()),
  } as const;
  const result = tradedSignalComparison(rows, [t, t]).filter(
    (r) => r.horizon === 5,
  );
  expect(result.map((r) => [r.group, r.samples, r.median])).toEqual([
    ["做过的信号", 1, 4],
    ["没做的信号", 1, -2],
  ]);
});
it("records actual installed skill IDs and hashes without executing tools", async () => {
  const result = await tradingLedgerMethods();
  expect(result.map((m) => m.skillId)).toEqual([
    "astock-market-rules",
    "mock-trading",
  ]);
  expect(result.flatMap((m) => m.files)).toHaveLength(3);
  for (const f of result.flatMap((m) => m.files))
    expect(f.hash).toMatch(/^[a-f0-9]{64}$/);
});
it("offline UI exposes empty state, unknown cost, provenance and disabled remote operations", () => {
  const html = renderToStaticMarkup(
    createElement(TradeLedgerPanel, {
      enabled: false,
      data: {
        today: days[0]!,
        calendarSource: "fixture",
        trades: [],
        positions: [],
        adjustments: [],
        signals: [],
        comparison: [],
      },
    }),
  );
  expect(html).toContain("暂无持仓");
  expect(html).toContain("实验参数，非历史实际费用");
  expect(html).toContain("成本未按除权调整");
  expect(html).toContain("开启模拟盘");
  expect(html).not.toContain("确认发送这笔模拟委托");
  expect(html).not.toContain("确认创建或使用模拟账户");
});
