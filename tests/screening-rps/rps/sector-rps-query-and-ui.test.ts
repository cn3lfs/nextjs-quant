import Database from "better-sqlite3";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ConceptRpsControls } from "~/components/market/concept-rps-controls";
import { IndustryRpsControls } from "~/components/market/industry-rps-controls";
import { DataSection } from "~/components/workbench/connections/data-section";
import type { TableSort } from "~/lib/common/server-sort";
import { settingsSchema } from "~/lib/domain";
import { rpsSortColumnId } from "~/lib/market/market-pool";
import { aggregateIndustryRps } from "~/lib/screening/industry-rps";
import { migrate } from "~/server/db/migrations";
import { RpsStore } from "~/server/db/rps-store";
import { industryRpsPage } from "~/server/screening/industry-rps-query";
import { calculateRpsDay } from "~/server/screening/rps-adapter";
import { industrySnapshot } from "../../helpers/industry-rps-fixture";
import {
  rpsCalendar,
  rpsDate,
  rpsDay,
  tenStocks,
} from "../../helpers/rps-fixture";

const { useSectorPage } = vi.hoisted(() => ({ useSectorPage: vi.fn() }));

vi.mock("~/trpc/react", () => {
  const useStatus = () => ({ isSuccess: true, data: { ready: true } });
  const useMutation = () => ({ isPending: false, isError: false });
  return {
    api: {
      industryRpsStatus: { useQuery: useStatus },
      conceptRpsStatus: { useQuery: useStatus },
      industryRpsPage: { useQuery: useSectorPage },
      conceptRpsPage: { useQuery: useSectorPage },
      rpsStart: { useMutation },
      rpsCancel: { useMutation },
      thsdkStatus: { useQuery: () => ({ data: undefined }) },
      industryRpsInspect: { useMutation },
      workspacePreferences: { useQuery: () => ({ data: undefined }) },
      saveWorkspacePreferences: { useMutation },
      useUtils: () => ({}),
    },
  };
});

const alpha = "Alpha Metals";
const beta = "Beta Metals";
const energy = "Alpha Energy";
const periods = [5, 10, 20, 50];

function sectorPage(input: {
  period: number;
  search?: string;
  order?: TableSort;
}) {
  const groups = {
    [alpha]: ["sz000000"],
    [beta]: ["sz000001"],
    [energy]: ["sz000002"],
  };
  const stocks = tenStocks().slice(0, 3);
  const baselineCloses = [
    [5, 10, 8, 5],
    [10, 8, 5, 10],
    [8, 5, 10, 8],
  ];
  const dateIndex = rpsCalendar.indexOf(rpsDate);
  for (const [index, stock] of stocks.entries()) {
    stock.closes.set(rpsDate, { close: 10, volume: 100 });
    for (const [periodIndex, period] of periods.entries()) {
      stock.closes.set(rpsCalendar[dateIndex - period]!, {
        close: baselineCloses[index]![periodIndex]!,
        volume: 100,
      });
    }
  }
  const result = aggregateIndustryRps(
    industrySnapshot(groups),
    calculateRpsDay(stocks, rpsCalendar, rpsDate, periods),
    periods,
  );
  const db = new Database(":memory:");
  try {
    migrate(db);
    const store = new RpsStore(db, "industry");
    store.saveDay(
      {
        ...rpsDay().day,
        periods,
        total: result.industry.snapshot.files.length,
        pool: result.pool,
        counts: result.counts,
        missing: result.missing,
        industry: result.industry,
      },
      result.rows,
    );
    return industryRpsPage(store, input);
  } finally {
    db.close();
  }
}

describe("industry RPS page", () => {
  it("returns the stored return, rank and RPS for every row and batch period", () => {
    const { rows, total } = sectorPage({ period: 10 });
    expect(total).toBe(3);
    expect(rows.map(({ name }) => name)).toEqual([energy, beta, alpha]);
    const expectedRanks: Record<string, number[]> = {
      [alpha]: [1, 3, 2, 1],
      [beta]: [3, 2, 1, 3],
      [energy]: [2, 1, 3, 2],
    };
    const returnsByRank = [1, 0.25, 0];
    for (const row of rows) {
      expect(row.rpsValues).toMatchObject({ 1: null, 3: null, 120: null });
      for (const [index, period] of periods.entries()) {
        const rank = expectedRanks[row.name]![index]!;
        const metric = row.rpsValues[String(period)];
        expect(metric).toMatchObject({ rank, return: returnsByRank[rank - 1] });
        expect(metric?.rps).toBeCloseTo(((3 - rank) / 3) * 100, 10);
      }
      expect(row.value).toEqual(row.rpsValues["10"]);
    }
  });

  it("matches case-insensitive substrings without recomputing ranks or RPS", () => {
    const { rows, total } = sectorPage({ period: 10, search: "mEtAL" });
    expect(total).toBe(2);
    expect(rows.map(({ name, value }) => [name, value?.rank])).toEqual([
      [beta, 2],
      [alpha, 3],
    ]);
    expect(rows[0]!.value?.rps).toBeCloseTo(100 / 3, 10);
    expect(rows[1]!.value?.rps).toBe(0);
    const full = sectorPage({ period: 10 });
    expect(rows.map(({ rpsValues }) => rpsValues)).toEqual(
      full.rows
        .filter(({ name }) => name !== energy)
        .map(({ rpsValues }) => rpsValues),
    );
  });

  it.each([
    { id: "return", desc: false, expected: [alpha, beta, energy] },
    { id: "rps", desc: false, expected: [alpha, beta, energy] },
    { id: rpsSortColumnId(5), desc: true, expected: [alpha, energy, beta] },
    { id: rpsSortColumnId(20), desc: true, expected: [beta, alpha, energy] },
  ])("sorts by `$id` on the server", ({ id, desc, expected }) => {
    const { rows } = sectorPage({ period: 10, order: { id, desc } });
    expect(rows.map(({ name }) => name)).toEqual(expected);
  });
});

it("excludes ST and *ST returns from the sector average", () => {
  const stocks = tenStocks();
  const ordinary = stocks[5]!;
  const st = stocks[0]!;
  const starred = stocks[9]!;
  st.name = "ST样本";
  starred.name = "*ST样本";
  const result = aggregateIndustryRps(
    industrySnapshot({
      样本行业: [ordinary.symbol, st.symbol, starred.symbol],
    }),
    calculateRpsDay([ordinary, st, starred], rpsCalendar, rpsDate),
  );
  expect(result.industry.members[0]?.excluded.st).toBe(2);
  expect(result.rows[0]?.values.map((metric) => metric?.return)).toEqual([
    0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5,
  ]);
});

it("renders enabled sector membership settings and inspection in DataSection", () => {
  const config = settingsSchema.parse({
    tdxRoot: "D:/fixture/tdx",
    industryMembershipSource: "blocks",
    industryBlocksRoot: "D:/fixture/blocks",
  });
  const html = renderToStaticMarkup(
    createElement(DataSection, {
      config,
      value: config,
      setConfig: () => {},
      fieldProps: (id) => ({
        id,
        "aria-invalid": false,
        "aria-describedby": undefined,
      }),
      fieldError: () => null,
      dirty: false,
      savePending: false,
      scanning: false,
      onScan: () => {},
      coverage: null,
    }),
  );
  const source = html.match(
    /<button\b[^>]*aria-label="板块成分来源"[^>]*>/,
  )?.[0];
  expect(source).toContain('role="combobox"');
  expect(source).not.toMatch(/\sdisabled(?:[\s=>])/i);
  const root = html.match(/<input\b[^>]*id="industryBlocksRoot"[^>]*>/)?.[0];
  expect(root).toContain('placeholder="外部 Blocks 根目录（绝对路径）"');
  expect(root).toContain('value="D:/fixture/blocks"');
  expect(root).not.toMatch(/\s(?:disabled|readonly)(?:[\s=>])/i);
  const inspect = html.match(/<button\b[^>]*>核对板块成分变化<\/button>/)?.[0];
  expect(inspect).toBeDefined();
  expect(inspect).not.toMatch(/\sdisabled(?:[\s=>])/i);
});

it.each([
  { View: IndustryRpsControls, label: "行业RPS排名", period: 20 },
  { View: ConceptRpsControls, label: "概念RPS排名", period: 50 },
])(
  "$label renders ranking rows without membership audit columns or settings",
  ({ View, label, period }) => {
    useSectorPage.mockReturnValue({
      data: sectorPage({ period }),
      isSuccess: true,
    });
    const html = renderToStaticMarkup(createElement(View));

    expect(html).toMatch(new RegExp(`<table\\b[^>]*aria-label="${label}"`));
    expect(html).toContain(`>${alpha}</a>`);
    expect(html).toContain(">RPS5<");
    expect(html).not.toMatch(
      />成分<|成分\s*\/\s*本周期有效|本周期有效|端点不足|剔除原因及数量|名单文件证据|外部 Blocks 根目录/,
    );
  },
);
