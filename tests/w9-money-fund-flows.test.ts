import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { importDeliveryTable } from "../src/lib/delivery-import";
import { parseDeliveryTable } from "../src/lib/delivery-table";
import { reviewTrades } from "../src/lib/trade-review";
import { reviewTradeNav } from "../src/lib/trade-review-nav";
import { migrate } from "../src/server/db/migrations";
import { commitDeliveryImport } from "../src/server/delivery-import-service";
import { DeliveryStore } from "../src/server/delivery-store";

const header =
  "日期\t时间\t操作\t摘要\t证券代码\t成交价格\t成交数量\t发生金额\t资金余额\t成交金额";
const row = (summary: string, amount: string, operation = "卖出") =>
  `20250102\t100000\t${operation}\t${summary}\t007864\t0\t0\t${amount}\t100\t999`;
const table = (rows: string[]) =>
  parseDeliveryTable(
    [
      header,
      "20250101\t090000\t其他\t银行转存\t\t0\t0\t1000\t1000\t1000",
      ...rows,
    ].join("\n"),
  );
const parse = (rows: string[]) =>
  importDeliveryTable(table(rows), { scope: "cashFlowsOnly" });

it("separates structural cash management from IPO payments and external transfers", () => {
  const result = parse([
    row("[007864]申购", "-100"),
    row(
      "202501020010020300000324037202[007864]赎回返款[101.00]元，8216赎回返款",
      "101",
    ),
    row("新股中签资金扣款", "-500"),
    row("XX配号", "0"),
  ]);
  expect(result.cashFlows.map((f) => [f.kind, f.amount])).toEqual([
    ["transferIn", 1000],
    ["cashManagement", -100],
    ["cashManagement", 101],
    ["subscription", -500],
    ["subscription", 0],
  ]);
});

it.each([
  ["-100", "卖出", true],
  ["100", "买入", true],
  ["-100", "买入", false],
  ["100", "卖出", false],
  ["100", "其他", false],
])(
  "uses signed postings %s despite operation %s",
  (amount, operation, conflict) => {
    // Even a conflicting embedded amount and subscription word cannot flip cash.
    const result = parse([
      row(
        "123456[007864]申购扣款[-22000.00]元，8214申购扣款",
        amount,
        operation,
      ),
    ]);
    const flow = result.cashFlows.find((f) => f.kind === "cashManagement")!;
    expect(flow.amount).toBe(Number(amount));
    expect(flow.warnings).toEqual(
      conflict ? ["操作列与资金方向不一致，以资金方向为准"] : [],
    );
    expect(
      result.diagnostics.filter((w) => w.includes("操作列与资金方向不一致")),
    ).toHaveLength(conflict ? 1 : 0);
  },
);

it.each(["", "NaN", "Infinity", "-Infinity", "0", "9".repeat(400)])(
  "refuses unknown posted direction %s without gross-amount fallback",
  (amount) => {
    const result = parse([row("[007864]赎回", amount)]);
    expect(result.cashFlows.map((f) => f.kind)).toEqual(["transferIn"]);
    expect(result.counts).toMatchObject({
      cashManagementUnknownDirection: 1,
      unresolved: 1,
    });
    expect(result.unresolved[0]!.reason).toContain("方向不可判");
    expect(result.diagnostics.some((w) => w.includes("方向不可判"))).toBe(true);
  },
);

it.each([
  "待确认申购",
  "未知业务",
  "[007864]申购待确认",
  "[7864]申购",
  "[007864]申购扣款[-100.00]元，9999申购扣款",
  "[007865]申购",
])("keeps unsupported or conflicting evidence unresolved: %s", (summary) => {
  const result = parse([row(summary, "-100", "其他")]);
  expect(result.cashFlows.map((f) => f.kind)).toEqual(["transferIn"]);
  expect(result.counts?.unresolved).toBe(1);
});

it("persists direction warnings and deduplicates both cash-management legs", () => {
  const db = new Database(":memory:");
  try {
    migrate(db);
    const data = table([
      row("[007864]申购", "-100"),
      row("[007864]赎回", "101"),
    ]);
    const parsed = importDeliveryTable(data, { scope: "cashFlowsOnly" });
    const store = new DeliveryStore(db);
    const input = {
      account: "w9-fixture",
      source: "ths" as const,
      scope: "cashFlowsOnly" as const,
      fileHash: "w9-fixture-a",
      fileName: "synthetic.tsv",
      importedAt: 1,
      parsed,
      rawRows: data.rows,
    };
    expect(store.commitImport(input).cashFlows).toBe(3);
    expect(store.commitImport(input).alreadyImported).toBe(true);
    expect(
      store.commitImport({ ...input, fileHash: "w9-fixture-b" }).duplicate,
    ).toBe(3);
    const flows = store.cashFlows("w9-fixture");
    expect(flows.filter((f) => f.kind === "cashManagement")).toHaveLength(2);
    expect(flows.find((f) => f.amount === -100)!.warnings).toEqual([
      "操作列与资金方向不一致，以资金方向为准",
    ]);
    const nav = reviewTradeNav({
      fills: [],
      cashFlows: flows,
      tradingDays: ["2025-01-01", "2025-01-02"],
      openingCash: 0,
      bars: {},
    });
    expect(nav.days.at(-1)!.cash.value).toBe(1001);
    // The +1 internal return stays in TWR; externalizing both legs would erase it.
    expect(nav.days.at(-1)!.dailyReturn.value).toBeCloseTo(0.001, 12);
  } finally {
    db.close();
  }
});

it.runIf(process.env.W9_REAL_DATA === "1")(
  "measures real imports through isolated storage and the production replay",
  () => {
    const db = new Database(":memory:");
    try {
      migrate(db);
      const bytes = (name: string) =>
        readFileSync(`.test-data/statements-v2/${name}.xls`);
      const fills = importDeliveryTable(
        parseDeliveryTable(bytes("lishi20-26")),
      );
      const statement = importDeliveryTable(
        parseDeliveryTable(bytes("duizhang20-26")),
        { scope: "cashFlowsOnly" },
      );
      const before = reviewTrades({
        fills: fills.fills,
        cashFlows: statement.cashFlows.filter(
          (f) => f.kind !== "cashManagement",
        ),
      });
      commitDeliveryImport(
        bytes("lishi20-26"),
        { account: "w9-test", source: "ths", fileName: "lishi20-26.xls" },
        db,
      );
      commitDeliveryImport(
        bytes("duizhang20-26"),
        {
          account: "w9-test",
          source: "ths",
          fileName: "duizhang20-26.xls",
          scope: "cashFlowsOnly",
        },
        db,
      );
      const store = new DeliveryStore(db);
      const input = {
        fills: store.fills("w9-test"),
        cashFlows: store.cashFlows("w9-test"),
      };
      const review = reviewTrades(input);
      const tradingDays = [
        ...new Set([
          ...input.fills.map((f) => f.tradeDate),
          ...input.cashFlows.map((f) => f.flowDate),
        ]),
      ].sort();
      const navInput = { ...input, tradingDays, bars: {}, openingCash: 0 };
      const nav = reviewTradeNav(navInput);
      const baseline = reviewTradeNav({
        ...navInput,
        cashFlows: input.cashFlows.filter((f) => f.kind !== "cashManagement"),
      });
      const summary = ["cashManagement", "transferIn", "transferOut"].map(
        (kind) => {
          const rows = input.cashFlows.filter((f) => f.kind === kind);
          return {
            kind,
            count: rows.length,
            amount:
              rows.reduce((s, f) => s + Math.round(f.amount * 100), 0) / 100,
          };
        },
      );
      console.log(
        JSON.stringify({
          summary,
          minimumCash: nav.minimumCash,
          minimumDate: nav.minimumDate,
          baselineMinimumCash: baseline.minimumCash,
          baselineMinimumDate: baseline.minimumDate,
          rounds: review.movingAverage.closedRounds.length,
          winRate: review.movingAverage.statistics.winRate,
          payoffRatio: review.movingAverage.statistics.payoffRatio,
          counts: statement.counts,
        }),
      );
      expect(summary).toEqual([
        { kind: "cashManagement", count: 48, amount: 114.13 },
        { kind: "transferIn", count: 64, amount: 1017222.79 },
        { kind: "transferOut", count: 30, amount: -788997.34 },
      ]);
      expect(review.movingAverage.closedRounds).toHaveLength(785);
      expect(review.movingAverage.statistics).toEqual(
        before.movingAverage.statistics,
      );
      expect(review.movingAverage.statistics.winRate).toBe(399 / 784);
      expect(review.movingAverage.statistics.payoffRatio).toBeCloseTo(
        0.8912012172774283,
        14,
      );
      // W10 reorders internal repayments; the old-path baseline is retained in
      // w10-intraday-order.test.ts rather than freezing the repaired cash minimum.
      expect(nav.minimumCash.value).toBeCloseTo(-9007.25, 2);
      expect(nav.minimumDate).toBe("2021-08-25");
      expect(baseline.minimumCash.value).toBeCloseTo(-8876.44, 2);
      expect(baseline.minimumDate).toBe("2022-06-28");
      expect(statement.counts?.cashManagementUnknownDirection).toBe(0);
      expect(
        input.cashFlows.filter(
          (f) => f.kind === "cashManagement" && f.warnings?.length,
        ),
      ).toHaveLength(23);
      expect(
        statement.cashFlows
          .filter((f) => f.code === "370409")
          .map((f) => [f.kind, f.amount]),
      ).toEqual([
        ["subscription", 0],
        ["subscription", -1000],
      ]);
    } finally {
      db.close();
    }
  },
);
