import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  importDeliveryTable,
  importOptionsSchema,
} from "~/lib/delivery-import";
import { parseDeliveryTable } from "~/lib/delivery-table";
import { migrate } from "~/server/db/migrations";
import {
  commitDeliveryImport,
  previewDeliveryImport,
} from "~/server/delivery-import-service";
import { DeliveryStore } from "~/server/delivery-store";

// Entirely synthetic statement; no real account or source records.
const header =
  "日期\t时间\t操作\t摘要\t证券代码\t成交价格\t成交数量\t发生金额\t资金余额\t批次号";
const rows = [
  "20250102\t090000\t其他\t银行转存\t\t\t\t10000\t10000\t1",
  "20250102\t100000\t买入\t证券买入\t600000\t10\t100\t-1000\t9000\t2",
  "20250103\t090000\t其他\t银行返回码:000000000000,返回信息:交易成功\t\t\t\t100\t9100\t3",
  "20250103\t100000\t其他\t银行返回码:000000000000,返回信息:交易成功\t\t\t\t-200\t8900\t4",
  "20250104\t090000\t其他\t批量客户结息处理批次:555， 利息归本：归本利息为 0.08\t\t\t\t0.08\t8900\t5",
  "20250104\t090000\t其他\t批量客户结息处理批次:555， 利息结算：预计利息：0.08，利息积数：12345，活期利率（年利率）：5.0E-4。\t\t\t\t0.08\t8900.08\t5",
  "20250105\t090000\t卖出\t融券回购购回日:20250106,预计利息:0.90\t131810\t0\t-10\t-1000.01\t7900.07\t6",
  "20250106\t090000\t卖出\t股息入账\t600000\t0\t0\t5\t7905.07\t7",
  "20250106\t100000\t卖出\t股息红利扣税\t600000\t0\t0\t-1\t7904.07\t8",
  "20250106\t110000\t买入\t新股中签资金扣款\t001001\t0\t0\t-500\t7404.07\t9",
];
const table = (data = rows) => parseDeliveryTable([header, ...data].join("\n"));
const parse = (data = rows) =>
  importDeliveryTable(table(data), { scope: "cashFlowsOnly" });

describe("W5 statement cash authority", () => {
  it("identifies the statement, preserves signed cash events and excludes both trade representations", () => {
    const result = parse();
    expect(result.diagnostics[0]).toContain("按对账单形态");
    expect(result.fills).toEqual([]);
    expect(result.cashFlows.map(({ kind, amount }) => [kind, amount])).toEqual([
      ["transferIn", 10000],
      ["transferIn", 100],
      ["transferOut", -200],
      ["interest", 0.08],
      ["dividend", 5],
      ["fee", -1],
      ["subscription", -500],
    ]);
    expect(result.counts).toEqual({
      discardedFills: 2,
      excludedInterest: 1,
      rejectedSigns: 0,
      failedFlows: 0,
      unresolved: 0,
    });
    expect(result.unresolved).toEqual([]);
    expect(result.statementOpeningCash).toBe(0);
  });
  it("uses the balance identity regardless of summary wording and descending order", () => {
    const result = parse([...rows].reverse());
    expect(
      result.cashFlows
        .filter((r) => r.kind === "interest")
        .map((r) => r.amount),
    ).toEqual([0.08]);
    expect(result.counts?.excludedInterest).toBe(1);
    expect(result.statementOpeningCash).toBe(0);
    const changed = [...rows];
    changed[5] = changed[5]!.replace("8900.08", "8900.09");
    expect(
      parse(changed).cashFlows.filter((r) => r.kind === "interest"),
    ).toEqual([]);
    expect(parse(changed).counts?.excludedInterest).toBe(2);
  });
  it("computes a nonzero opening and refuses to invent missing evidence", () => {
    expect(
      parse([rows[0]!.replace("10000\t10000", "5000\t8000")])
        .statementOpeningCash,
    ).toBe(3000);
    expect(
      parse([rows[0]!.replace("10000\t10000", "bad\t8000")])
        .statementOpeningCash,
    ).toBeNull();
    const result = parse([rows[4]!]);
    expect(result.cashFlows).toEqual([]);
    expect(result.unresolved[0]?.reason).toContain("缺少前一条");
  });
  it.each(["cashFlowsOnly", "all"] as const)(
    "rejects inconsistent quantities under %s",
    (scope) => {
      const result = importDeliveryTable(
        table([
          rows[0]!,
          "20250102\t100000\t买入\t证券买入\t600000\t10\t-100\t-1000\t9000\t2",
          "20250102\t110000\t卖出\t证券卖出\t600000\t10\t100\t1000\t10000\t3",
        ]),
        { scope },
      );
      expect(result.fills).toEqual([]);
      expect(result.counts?.rejectedSigns).toBe(2);
      expect(result.unresolved).toHaveLength(2);
    },
  );
  it("normalizes valid signed fills when all is explicitly selected", () => {
    const result = importDeliveryTable(
      table([
        rows[0]!,
        rows[1]!,
        "20250102\t110000\t卖出\t证券卖出\t600000\t11\t-100\t1100\t10100\t3",
      ]),
      { scope: "all" },
    );
    expect(result.fills.map((r) => [r.kind, r.quantity])).toEqual([
      ["buy", 100],
      ["sell", 100],
    ]);
  });
  it("keeps unknown, malformed and failed rows explicit", () => {
    const result = parse([
      rows[0]!,
      "20250103\t090000\t其他\t神秘变动\t\t\t\t50\t10050\t2",
      "20250103\t100000\t其他\t银行返回码:999999,交易失败\t\t\t\t100\t10050\t3",
      "20250103\t110000\t其他\t银行返回码:999999,交易成功\t\t\t\t100\t10050\t4",
      "not-a-date\t110000\t其他\t银行转存\t\t\t\t100\t10050\t5",
    ]);
    expect(result.cashFlows).toHaveLength(1);
    expect(result.counts?.failedFlows).toBe(1);
    expect(result.counts?.unresolved).toBe(4);
    expect(result.unresolved[0]?.reason).toContain("未知业务类型");
  });
  it.each(["ths-settlement.txt", "ths-history.txt", "ths-bank-flow.txt"])(
    "preserves legacy default output for %s",
    (name) => {
      const input = parseDeliveryTable(
        readFileSync(`tests/fixtures/delivery/${name}`),
      );
      expect(importDeliveryTable(input)).toEqual(
        importDeliveryTable(input, { scope: "all" }),
      );
      expect(importDeliveryTable(input).statementOpeningCash).toBeUndefined();
    },
  );
  it("validates scope and defaults omitted scope to existing behavior", () => {
    expect(
      importOptionsSchema.safeParse({
        account: "test",
        source: "generic",
        scope: "fillsOnly",
      }).success,
    ).toBe(false);
    expect(importDeliveryTable(table())).toEqual(
      importDeliveryTable(table(), { scope: "all" }),
    );
  });
  it("applies cashFlowsOnly to legacy files without changing cash fingerprints", () => {
    const input = parseDeliveryTable(
      readFileSync("tests/fixtures/delivery/ths-history.txt"),
    );
    const all = importDeliveryTable(input);
    const cash = importDeliveryTable(input, { scope: "cashFlowsOnly" });
    expect(all.fills.length).toBeGreaterThan(0);
    expect(cash.fills).toEqual([]);
    expect(cash.cashFlows).toEqual(all.cashFlows);
    expect(cash.counts?.discardedFills).toBe(all.fills.length);
  });
  it("rejects a caller bypassing the parser's cash-only filter before writing anything", () => {
    const db = new Database(":memory:");
    try {
      migrate(db);
      const store = new DeliveryStore(db);
      expect(() =>
        store.commitImport({
          account: "synthetic",
          source: "generic",
          scope: "cashFlowsOnly",
          fileHash: "synthetic",
          fileName: "synthetic.tsv",
          importedAt: 0,
          parsed: importDeliveryTable(table([rows[0]!, rows[1]!])),
          rawRows: [],
        }),
      ).toThrow("不能包含成交");
      expect(store.batches()).toEqual([]);
      expect(store.fills()).toEqual([]);
      expect(store.cashFlows()).toEqual([]);
    } finally {
      db.close();
    }
  });
  it("persists only cash, opening evidence and counters; repeated imports stay idempotent", () => {
    const db = new Database(":memory:");
    try {
      migrate(db);
      const bytes = Buffer.from([header, ...rows].join("\n"));
      const options = {
        account: "synthetic",
        source: "generic",
        scope: "cashFlowsOnly",
      };
      const preview = previewDeliveryImport(bytes, options, db);
      expect(preview.summary).toMatchObject({
        new: 7,
        unresolved: 0,
        counts: { discardedFills: 2 },
      });
      const result = commitDeliveryImport(bytes, options, db);
      expect(result).toMatchObject({
        fills: 0,
        cashFlows: 7,
        cashFlowSummary: expect.arrayContaining([
          { kind: "interest", count: 1, amount: 0.08 },
          { kind: "fee", count: 1, amount: -1 },
        ]),
        statementOpeningCash: 0,
      });
      const store = new DeliveryStore(db);
      expect(store.fills()).toEqual([]);
      expect(
        store
          .cashFlows()
          .filter((r) => r.kind === "interest")
          .reduce((sum, r) => sum + r.amount, 0),
      ).toBe(0.08);
      expect(store.batches()[0]?.payload).toMatchObject({
        scope: "cashFlowsOnly",
        cashFlowSummary: preview.summary.cashFlowSummary,
        statementOpeningCash: 0,
        counts: { discardedFills: 2 },
      });
      expect(commitDeliveryImport(bytes, options, db)).toMatchObject({
        cashFlowSummary: preview.summary.cashFlowSummary,
        alreadyImported: true,
        fills: 0,
        cashFlows: 0,
        statementOpeningCash: 0,
      });
      expect(() =>
        commitDeliveryImport(bytes, { ...options, scope: "all" }, db),
      ).toThrow("不同 scope");
      expect(store.cashFlows()).toHaveLength(7);
    } finally {
      db.close();
    }
  });
});

describe("W5b real-shaped adversarial summaries", () => {
  const adversarial = [
    ...rows,
    "20250107\t090000\t买入\t到期日[20250108]，利息[3.21]，金额[77003.21]，4076回购融券\t204001\t0\t77\t-77000.77\t0\t10",
    "20250107\t100000\t买入\t利息结转[0.000500]，2061批量利息归本\t\t0\t0\t4.24\t4.24\t11",
    "20250107\t110000\t卖出\t123456[007864]申购扣款[-22000.00]元，8214申购扣款\t007864\t0\t0\t-22000\t0\t12",
    "20250107\t120000\t其他\t费用扣收待核实\t\t0\t0\t-20\t0\t13",
  ];
  it("keeps default and explicit all at their pre-fix outputs", () => {
    expect(importDeliveryTable(table(adversarial))).toMatchSnapshot();
    expect(importDeliveryTable(table(adversarial), { scope: "all" })).toEqual(
      importDeliveryTable(table(adversarial)),
    );
  });
  it("separates real-shaped interest and repo, refusing other interest and debit wording", () => {
    const result = parse(adversarial);
    expect(
      result.cashFlows
        .filter((r) => r.kind === "interest")
        .map((r) => r.amount),
    ).toEqual([0.08]);
    expect(
      result.cashFlows.filter((r) => r.kind === "fee").map((r) => r.amount),
    ).toEqual([-1]);
    expect(result.counts).toMatchObject({ discardedFills: 2, unresolved: 4 });
    expect(result.unresolved.map((r) => r.rowIndex)).toEqual([11, 12, 13, 14]);
    expect(
      result.cashFlows.some((r) => r.summary.includes("融券回购购回日")),
    ).toBe(false);
  });
  it("uses the paired balance identity even when a descending export keeps the pair ascending", () => {
    const input = [rows[6]!, rows[4]!, rows[5]!, rows[0]!];
    expect(
      parse(input)
        .cashFlows.filter((r) => r.kind === "interest")
        .map((r) => r.amount),
    ).toEqual([0.08]);
  });
});

describe("W5b boundaries", () => {
  it("excludes explicit repo structure even without interest wording or consistent signs", () => {
    const result = parse([
      rows[0]!,
      rows[6]!
        .replace("预计利息:0.90", "参考占款天数:1-1")
        .replace("-10", "10"),
    ]);
    expect(result.counts).toMatchObject({
      discardedFills: 1,
      rejectedSigns: 0,
      unresolved: 0,
    });
    expect(result.cashFlows.map((r) => r.kind)).toEqual(["transferIn"]);
  });
  it("accepts bracketed successful bank responses, but not failed or nonzero codes", () => {
    const data = rows
      .slice(0, 4)
      .map((r) =>
        r.replace(
          "银行返回码:000000000000,返回信息:交易成功",
          "银行返回码[000000000000]返回信息[交易成功]|转账成功",
        ),
      );
    expect(parse(data).cashFlows.map((r) => r.amount)).toEqual([
      10000, 100, -200,
    ]);
    const rejected = parse(
      data.map((r) => r.replace("[000000000000]", "[999999999999]")),
    );
    expect(rejected.counts?.unresolved).toBe(2);
  });
  it("does not use an account-specific amount threshold", () => {
    const data = [...rows];
    data[4] = data[4]!.replace("0.08\t8900", "200000\t8900");
    data[5] = data[5]!.replace("0.08\t8900.08", "200000\t208900");
    expect(
      parse(data)
        .cashFlows.filter((r) => r.kind === "interest")
        .map((r) => r.amount),
    ).toEqual([200000]);
  });
});
