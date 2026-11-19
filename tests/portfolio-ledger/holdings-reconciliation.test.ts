import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { HoldingsExplorer } from "~/components/portfolio/account-workspace/holdings-explorer";
import { settingsSchema } from "~/lib/domain";
import type { AccountPosition } from "~/lib/portfolio/account-workspace";
import { importDeliveryTable } from "~/lib/research/evidence/delivery-import";
import { parseDeliveryTable } from "~/lib/research/evidence/delivery-table";
import { AccountWorkspaceRepository } from "~/server/db/account-workspace-repository";
import { DeliveryStore } from "~/server/db/delivery-store";
import { TradeLedgerStore } from "~/server/db/trade-ledger-store";
import { migrate } from "~/server/db/migrations";
import {
  saveWorkspacePreferences,
  workspacePreferences,
} from "~/server/db/workspace-preferences";
import {
  loadAccountBook,
  pageAccountBook,
  reconcileRealHoldings,
} from "~/server/portfolio/account-workspace-service";

const holdingsApi = vi.hoisted(() => ({
  accountPositions: { useQuery: vi.fn() },
  workspacePreferences: { useQuery: vi.fn() },
  saveWorkspacePreferences: { useMutation: vi.fn() },
}));
const previewControl = vi.hoisted(() =>
  vi.fn<
    (
      onChange: (
        mode: "local-first" | "delivery-first" | "upper-bound",
      ) => void,
    ) => void
  >(),
);
vi.mock("~/trpc/react", () => ({ api: holdingsApi }));
vi.mock("~/components/portfolio/crypto-risk-notes", () => ({
  CryptoRiskNotes: () => null,
}));
vi.mock("~/components/panels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/components/panels")>();
  return {
    ...actual,
    Segmented: (props: Parameters<typeof actual.Segmented>[0]) => {
      if (props.label === "汇总视角") previewControl(props.onChange);
      return createElement(actual.Segmented, props);
    },
  };
});
afterEach(() => vi.clearAllMocks());

function holding(
  id: string,
  symbol: string,
  quantity: number,
  price: number,
): AccountPosition {
  const currency = symbol === "cxBTCUSDT" ? "USDT" : "CNY";
  return {
    id,
    account: "同名账户",
    kind: "real",
    market: currency === "CNY" ? "cn-equity" : "crypto",
    currency,
    symbol,
    sleeve: "swing",
    industry: "测试行业",
    quantity,
    cost: price,
    price,
    value: quantity * price,
    stop: null,
    at: "2026-01-09",
    strategyId: null,
    strategyVersion: null,
    reasons: [],
  };
}

it("aggregates each ledger for a single overlapping symbol before applying the conservative bounds", () => {
  const result = reconcileRealHoldings([
    holding("delivery:a", "sh600000", 100, 12),
    holding("delivery:b", "sh600000", 100, 12),
    holding("local:a", "sh600000", 300, 12),
  ]);
  // 券商 (100 + 100) × 12 = 2400，手工 300 × 12 = 3600。
  // 下限 max(2400, 3600) = 3600，上限 2400 + 3600 = 6000。
  expect(result.overlapSymbols).toEqual([
    {
      market: "cn-equity",
      symbol: "sh600000",
      name: null,
      currency: "CNY",
      deliveryQuantity: 200,
      localQuantity: 300,
      deliveryValue: 2400,
      localValue: 3600,
      grossTotal: 6000,
      lowerBound: 3600,
      upperBound: 6000,
      overlap: true,
    },
  ]);
  expect(result.industryLimitBasis).toBe("upper-bound");
});

it("adds per-symbol lower bounds across a partially overlapping book without mixing currencies", () => {
  const result = reconcileRealHoldings([
    holding("delivery:bank", "sh600000", 100, 12),
    holding("local:bank", "sh600000", 200, 12),
    holding("delivery:steel", "sh600001", 200, 12),
    holding("local:steel", "sh600001", 100, 12),
    holding("local:third", "sz000001", 100, 5),
    holding("local:btc", "cxBTCUSDT", 0.25, 40000),
    { ...holding("paper:synthetic", "sh600000", 999, 12), kind: "paper" },
  ]);
  // CNY 下限 max(1200,2400) + max(2400,1200) + 100×5 = 5300。
  // CNY 上限 (1200+2400) + (2400+1200) + 500 = 7700。
  // USDT 单账 0.25×40000 = 10000，上下限相等。
  expect(
    result.overlapSymbols.map(({ symbol, lowerBound, upperBound }) => ({
      symbol,
      lowerBound,
      upperBound,
    })),
  ).toEqual([
    { symbol: "sh600000", lowerBound: 2400, upperBound: 3600 },
    { symbol: "sh600001", lowerBound: 2400, upperBound: 3600 },
  ]);
  expect(result.summaryByCurrency).toEqual([
    {
      currency: "CNY",
      grossTotal: 7700,
      deduplicatedLowerBound: 5300,
      deliveryTotal: 3600,
      localTotal: 4100,
      overlapCount: 2,
    },
    {
      currency: "USDT",
      grossTotal: 10000,
      deduplicatedLowerBound: 10000,
      deliveryTotal: null,
      localTotal: 10000,
      overlapCount: 0,
    },
  ]);
});

it("collapses a two-ledger book with disjoint symbols to one value", () => {
  const result = reconcileRealHoldings([
    holding("delivery:a", "sh600000", 100, 12),
    holding("local:b", "sz000001", 200, 5),
  ]);
  // 两个独立标的各只需计入一次，100×12 + 200×5 = 2200。
  expect(result.overlapSymbols).toEqual([]);
  expect(result.summaryByCurrency[0]).toEqual({
    currency: "CNY",
    grossTotal: 2200,
    deduplicatedLowerBound: 2200,
    deliveryTotal: 1200,
    localTotal: 1000,
    overlapCount: 0,
  });
});

it.each([
  { source: "delivery", deliveryTotal: null, localTotal: 2400 },
  { source: "local", deliveryTotal: 1200, localTotal: null },
] as const)(
  "leaves both bounds unknown when one $source quote is missing, even with a previously recorded value",
  ({ source, deliveryTotal, localTotal }) => {
    const delivery = holding("delivery:a", "sh600000", 100, 12);
    const local = holding("local:a", "sh600000", 200, 12);
    // 已知账分别为 100×12 = 1200 或 200×12 = 2400，另一账缺价。
    const result = reconcileRealHoldings([
      source === "delivery" ? { ...delivery, price: null } : delivery,
      source === "local" ? { ...local, price: null, value: null } : local,
      holding("local:btc", "cxBTCUSDT", 0.25, 40000),
    ]);
    expect(result.overlapSymbols[0]).toMatchObject({
      deliveryValue: deliveryTotal,
      localValue: localTotal,
      grossTotal: null,
      lowerBound: null,
      upperBound: null,
      overlap: true,
    });
    expect(result.summaryByCurrency).toEqual([
      {
        currency: "CNY",
        grossTotal: null,
        deduplicatedLowerBound: null,
        deliveryTotal,
        localTotal,
        overlapCount: 1,
      },
      {
        currency: "USDT",
        grossTotal: 10000,
        deduplicatedLowerBound: 10000,
        deliveryTotal: null,
        localTotal: 10000,
        overlapCount: 0,
      },
    ]);
  },
);

it("switches the actual holdings preview through workspace preferences without writing either ledger", async () => {
  const db = new Database(":memory:");
  try {
    migrate(db);
    const repo = new AccountWorkspaceRepository(db);
    const raw = readFileSync("tests/fixtures/delivery/r3b-account.csv");
    const table = parseDeliveryTable(raw);
    new DeliveryStore(db).commitImport({
      account: "券商账",
      source: "generic",
      fileHash: createHash("sha256").update(raw).digest("hex"),
      fileName: "r3b-account.csv",
      importedAt: 1,
      parsed: importDeliveryTable(table),
      rawRows: table.rows,
      sourceHeader: table.header,
    });
    const today = "2026-01-09";
    const calendar = [
      "2026-01-05",
      "2026-01-06",
      "2026-01-07",
      "2026-01-08",
      today,
    ];
    const evidence = { events: [], coverageEnd: today, source: "synthetic" };
    new TradeLedgerStore(db).record(
      {
        id: "10000000-0000-4000-8000-000000000001",
        symbol: "sh600000",
        date: "2026-01-08",
        side: "buy",
        quantity: 200,
        price: 10,
        lowerLimit: 9,
        upperLimit: 11,
        limitSource: "synthetic",
        signalId: null,
        stop: 9,
        note: "",
      },
      {
        today,
        calendar,
        evidence,
        methods: ["astock-market-rules", "mock-trading"].map((skillId) => ({
          skillId,
          ruleVersion: "fixture",
          outputSchema: "fixture",
          files: [{ file: "SKILL.md", hash: "fixture" }],
          prerequisites: [],
        })),
      },
    );
    const load = () =>
      loadAccountBook(
        repo,
        settingsSchema.parse({}),
        Date.parse(today + "T08:00:00Z"),
        {
          context: {
            today,
            calendar,
            calendarSource: "synthetic",
            evidence: () => evidence,
          },
          bars: {
            sh600000: [
              {
                date: today,
                open: 12,
                high: 12,
                low: 12,
                close: 12,
                volume: 1000,
                amount: 12000,
              },
            ],
          },
        },
      );
    const before = repo.snapshot();
    expect(before.fills).toHaveLength(3);
    expect(before.local).toHaveLength(1);
    const book = await load();
    const page = pageAccountBook(book, { kind: "real" });
    // 交割单余 200−200+100 = 100 股，手工 200 股。按 12 元估值分别为 1200 与 2400，
    // 保守区间 [max(1200,2400),1200+2400] = [2400,3600]。
    expect(page.reconciliation.overlapSymbols[0]).toMatchObject({
      deliveryQuantity: 100,
      localQuantity: 200,
      lowerBound: 2400,
      upperBound: 3600,
    });
    holdingsApi.accountPositions.useQuery.mockReturnValue({ data: page });
    holdingsApi.workspacePreferences.useQuery.mockImplementation(() => ({
      data: workspacePreferences(db),
    }));
    const mutate = vi.fn(
      (patch: Parameters<typeof saveWorkspacePreferences>[0]) =>
        saveWorkspacePreferences(patch, db),
    );
    holdingsApi.saveWorkspacePreferences.useMutation.mockReturnValue({
      reset: vi.fn(),
      mutate,
    });
    const render = () =>
      renderToStaticMarkup(
        createElement(HoldingsExplorer, { search: "", position: null }),
      );

    expect(render()).toContain("毛合计（保守上限）");
    for (const [holdingsReconciliation, label, value] of [
      ["delivery-first", "券商账本合计（预览）", "1200.00"],
      ["local-first", "手工账本合计（预览）", "2400.00"],
      ["upper-bound", "毛合计（保守上限）", "3600.00"],
    ] as const) {
      previewControl.mock.lastCall![0](holdingsReconciliation);
      expect(mutate).toHaveBeenLastCalledWith({ holdingsReconciliation });
      expect(workspacePreferences(db).holdingsReconciliation).toBe(
        holdingsReconciliation,
      );
      const html = render();
      // Assert the amount paired with the preview label, rather than a total elsewhere on the page.
      const previewMetric = html.match(
        /<span\b[^>]*>[^<]*(?:账本合计（预览）|毛合计（保守上限）)<\/span>\s*<strong\b[^>]*>[^<]+/g,
      );
      expect(previewMetric?.[0]?.replace(/<[^>]+>/g, "")).toBe(label + value);
      expect(html).toContain("行业 30% 限额按保守上限核对");
    }
    expect(mutate).toHaveBeenCalledTimes(3);
    const after = repo.snapshot();
    expect(after.fills).toEqual(before.fills);
    expect(after.local).toEqual(before.local);
    expect(after.cashFlows).toEqual(before.cashFlows);
    expect(
      pageAccountBook(await load(), { kind: "real" }).reconciliation,
    ).toEqual(page.reconciliation);
  } finally {
    db.close();
  }
});
