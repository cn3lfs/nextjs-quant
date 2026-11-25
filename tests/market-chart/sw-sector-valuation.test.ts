import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SW_L1_SECTORS,
  SW_L2_SECTORS,
} from "../../src/lib/financial/sw-sector-codes";
import {
  clearSwSectorValuationCache,
  swSectorValuation,
} from "../../src/server/financial/sw-sector-valuation";

const electronics = "pt01801080";
const banks = "pt01801780";
const property = "pt01801180";
const steel = "pt01801040";

const sourceRows = [
  {
    IndustryCode: "801080",
    EndDate: 20261123,
    PeTTM: 24.5,
    PeTTMPct: 70.25,
    PeTTMPrevM: 23,
    PeTTMPrevY: 19,
    PbLF: 2.4,
    PbLFPct: 61.5,
    PbLFPrevM: 2.3,
    PbLFPrevY: 1.9,
    DivTTM: 1.45,
    DivTTMPct: 27.5,
    DivTTMPrevM: 1.5,
    DivTTMPrevY: 1.6,
  },
  { code: banks, EndDate: "2026-11-24", PeTTM: 8, PeTTMPct: 0 },
  { code: property, PeTTM: -5, PeTTMPct: 10 },
  { code: steel, PeTTM: 0, PeTTMPct: 90 },
  {
    code: "pt01801081",
    PeTTM: 38,
    PeTTMPct: null,
    PbLF: 3,
    DivTTM: 0.5,
    DivTTMPct: undefined,
  },
];

type SourceFixtureRow = {
  code?: string;
  IndustryCode?: string;
  [field: string]: unknown;
};

function mockExecute(rows: SourceFixtureRow[] = sourceRows) {
  return vi.fn(async (args: string[]) => {
    const codes = args[2]!.split(",");
    return rows.filter((row) =>
      codes.includes(row.code ?? `pt01${row.IndustryCode}`),
    );
  });
}

beforeEach(clearSwSectorValuationCache);

describe("申万板块估值", () => {
  it("包含 31 个一级行业和 123 个二级行业，代码唯一且父级均存在", () => {
    const all = [...SW_L1_SECTORS, ...SW_L2_SECTORS];
    const parents = new Set(SW_L1_SECTORS.map(({ name }) => name));
    expect(SW_L1_SECTORS).toHaveLength(31);
    expect(SW_L2_SECTORS).toHaveLength(123);
    expect(new Set(all.map(({ swCode }) => swCode)).size).toBe(154);
    expect(new Set(all.map(({ code }) => code)).size).toBe(154);
    for (const sector of SW_L1_SECTORS) {
      expect(sector.level).toBe("l1");
      expect(sector.parentL1).toBeNull();
    }
    for (const sector of SW_L2_SECTORS) {
      expect(sector.level).toBe("l2");
      expect(parents.has(sector.parentL1 ?? ""), sector.name).toBe(true);
    }
  });

  it("按 30 只分批请求所有 154 个代码并准确映射腾讯字段", async () => {
    const execute = mockExecute();
    const result = await swSectorValuation({}, { execute });
    const batches = execute.mock.calls.map(([args]) => {
      expect(args.slice(0, 2)).toEqual(["sector", "valuation"]);
      expect(args).toHaveLength(3);
      return args[2]!.split(",");
    });
    expect(batches.map((batch) => batch.length)).toEqual([
      30, 30, 30, 30, 30, 4,
    ]);
    expect(batches.flat().sort()).toEqual(
      [...SW_L1_SECTORS, ...SW_L2_SECTORS].map(({ code }) => code).sort(),
    );
    expect(result).toMatchObject({
      available: true,
      asOfDate: "2026-11-24",
      counts: { l1: 31, l2: 123 },
      total: 31,
    });
    expect(result.rows.find(({ code }) => code === electronics)).toEqual({
      code: electronics,
      swCode: "801080",
      name: "电子",
      level: "l1",
      parentL1: null,
      endDate: "2026-11-23",
      pe: 24.5,
      pePct: 70.25,
      pePrevM: 23,
      pePrevY: 19,
      pb: 2.4,
      pbPct: 61.5,
      pbPrevM: 2.3,
      pbPrevY: 1.9,
      div: 1.45,
      divPct: 27.5,
      divPrevM: 1.5,
      divPrevY: 1.6,
      missing: false,
    });
    expect(result.rows.find(({ code }) => code === banks)).toMatchObject({
      endDate: "2026-11-24",
      pePct: 0,
    });
  });

  it("保留显式 null、未定义及省略的分位为 null", async () => {
    const result = await swSectorValuation(
      { level: "l2", search: "801081" },
      { execute: mockExecute() },
    );
    expect(result.rows).toMatchObject([
      {
        name: "半导体",
        pePct: null,
        pbPct: null,
        divPct: null,
        missing: false,
      },
    ]);
  });

  it.each([
    [-1, null],
    [101, null],
    [NaN, null],
    [Infinity, null],
    [0, 0],
    [100, 100],
  ])("估值分位 %s 映射为 %s", async (value, expected) => {
    const execute = mockExecute([
      {
        code: banks,
        PeTTM: 8,
        PeTTMPct: value,
        PbLFPct: value,
        DivTTMPct: value,
      },
    ]);
    const result = await swSectorValuation({ search: "801780" }, { execute });
    expect(result.rows).toMatchObject([
      { pePct: expected, pbPct: expected, divPct: expected },
    ]);
  });

  it.each([
    ["pe", false, [banks, electronics, property, steel]],
    ["pe", true, [electronics, banks, steel, property]],
    ["pePct", false, [banks, electronics, property, steel]],
    ["pePct", true, [electronics, banks, steel, property]],
  ] as const)(
    "按 %s 排序（descending=%s）时非正 PE 排在正 PE 之后",
    async (sort, descending, expected) => {
      const result = await swSectorValuation(
        { sort, descending },
        {
          execute: mockExecute(),
        },
      );
      expect(result.rows.slice(0, 4).map(({ code }) => code)).toEqual(expected);
      expect(result.rows.find(({ code }) => code === property)?.pe).toBe(-5);
      expect(result.rows.find(({ code }) => code === steel)?.pe).toBe(0);
    },
  );

  it.each([false, true])(
    "PE 分位排序（descending=%s）先区分正、非正、未知 PE，再将缺分位项排到组末",
    async (descending) => {
      const unknownPe = "pt01801030";
      const execute = mockExecute([
        { code: banks, PeTTM: 8, PeTTMPct: 0 },
        { code: electronics, PeTTM: 24.5, PeTTMPct: null },
        { code: property, PeTTM: -5, PeTTMPct: 10 },
        { code: steel, PeTTM: 0, PeTTMPct: null },
        { code: unknownPe, PeTTMPct: 50 },
      ]);
      const result = await swSectorValuation(
        { sort: "pePct", descending },
        { execute },
      );
      expect(result.rows.slice(0, 5).map(({ code }) => code)).toEqual([
        banks,
        electronics,
        property,
        steel,
        unknownPe,
      ]);
    },
  );

  it("按层级、父级、行业名和行业代码组合筛选", async () => {
    const execute = mockExecute();
    const l2 = await swSectorValuation({ level: "l2" }, { execute });
    expect(l2.rows).toHaveLength(123);
    expect(l2.rows.every(({ level }) => level === "l2")).toBe(true);
    const subset = await swSectorValuation(
      { level: "l2", parentL1: "电子" },
      { execute },
    );
    expect(subset.rows.map(({ name }) => name).sort()).toEqual(
      [
        "半导体",
        "其他电子",
        "元件",
        "光学光电子",
        "消费电子",
        "电子化学品",
      ].sort(),
    );
    for (const search of [" 半导体 ", "801081"]) {
      const match = await swSectorValuation(
        { level: "l2", parentL1: "电子", search },
        { execute },
      );
      expect(match.rows.map(({ name }) => name)).toEqual(["半导体"]);
    }
    const excluded = await swSectorValuation(
      { level: "l2", parentL1: "银行", search: "半导体" },
      { execute },
    );
    expect(excluded.rows).toEqual([]);
  });

  it("TTL 内跨筛选复用快照，手动刷新替换快照，满 10 分钟重新查询", async () => {
    const execute = mockExecute();
    const start = Date.UTC(2026, 10, 24);
    const initial = await swSectorValuation({}, { execute, now: start });
    expect(initial).toMatchObject({ cached: false, fetchedAt: start });

    const now = start + 599_999;
    const hit = await swSectorValuation({ level: "l2" }, { execute, now });
    expect(hit).toMatchObject({ cached: true, fetchedAt: start, total: 123 });
    expect(execute).toHaveBeenCalledTimes(6);

    const updated = mockExecute([{ code: banks, PeTTM: 9 }]);
    const refreshed = await swSectorValuation(
      { refresh: true },
      {
        execute: updated,
        now,
      },
    );
    expect(refreshed).toMatchObject({ cached: false, fetchedAt: now });
    expect(updated).toHaveBeenCalledTimes(6);
    const next = await swSectorValuation({ search: "银行" }, { execute, now });
    expect(next.cached).toBe(true);
    expect(next.rows).toMatchObject([{ code: banks, pe: 9 }]);
    expect(execute).toHaveBeenCalledTimes(6);

    const expired = await swSectorValuation(
      {},
      { execute, now: now + 600_000 },
    );
    expect(expired).toMatchObject({ cached: false, fetchedAt: now + 600_000 });
    expect(execute).toHaveBeenCalledTimes(12);
  });

  it.each([false, true])(
    "一批重试失败后返回不可用且不写入缓存（已有快照=%s）",
    async (hasSnapshot) => {
      const start = Date.UTC(2026, 10, 24);
      if (hasSnapshot) {
        await swSectorValuation({}, { execute: mockExecute(), now: start });
      }

      const partialRows = mockExecute([{ code: banks, PeTTM: 9 }]);
      const finalCode = SW_L2_SECTORS.at(-1)!.code;
      const failedBatch = vi.fn(() => {
        throw new Error("fixture batch failed");
      });
      const execute = (args: string[]) =>
        args[2]!.split(",").includes(finalCode)
          ? failedBatch()
          : partialRows(args);
      const result = await swSectorValuation(
        { refresh: true, search: "801780" },
        { execute, now: start + 1 },
      );
      expect(failedBatch).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({
        available: false,
        cached: false,
        reason: expect.stringContaining("1 批板块估值查询失败"),
        rows: [{ code: banks, pe: 9 }],
      });

      const recovered = mockExecute([{ code: banks, PeTTM: 10 }]);
      const next = await swSectorValuation(
        { search: "801780" },
        { execute: recovered, now: start + 2 },
      );
      expect(next).toMatchObject({
        available: true,
        cached: hasSnapshot,
        fetchedAt: hasSnapshot ? start : start + 2,
        rows: [{ code: banks, pe: hasSnapshot ? 8 : 10 }],
      });
      expect(recovered).toHaveBeenCalledTimes(hasSnapshot ? 0 : 6);
    },
  );

  it.each(["执行失败", "只有二级数据"] as const)(
    "%s时返回不可用，下一次普通请求可恢复",
    async (failure) => {
      const execute =
        failure === "执行失败"
          ? vi.fn(async () => {
              throw new Error("fixture transport failed");
            })
          : mockExecute(sourceRows.filter(({ code }) => code === "pt01801081"));
      const now = Date.UTC(2026, 10, 24);
      const unavailable = await swSectorValuation({}, { execute, now });
      expect(execute).toHaveBeenCalled();
      expect(unavailable).toMatchObject({
        available: false,
        cached: false,
        missingCount: 31,
      });
      expect(unavailable.reason).toBeTruthy();

      const restoredExecute = mockExecute();
      const restored = await swSectorValuation(
        {},
        {
          execute: restoredExecute,
          now: now + 1,
        },
      );
      expect(restored).toMatchObject({ available: true, cached: false });
      expect(restoredExecute).toHaveBeenCalledTimes(6);
    },
  );
});
