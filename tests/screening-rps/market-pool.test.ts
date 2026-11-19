import { afterEach, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  marketPoolQuerySchema,
  selectMarketPoolRows,
  type MarketPoolRow,
} from "../../src/lib/market/market-pool";
import {
  marketPoolCatalog,
  readMarketPool,
} from "../../src/server/market/market-pool-files";
import { readIndustryBlocks } from "../../src/server/market/industry-blocks";

const roots: string[] = [];
if (process.env.MARKET_POOL_BLOCKS_ROOT) {
  it("configured real A500 and concept lists parse read-only and match the catalog", async () => {
    const root = process.env.MARKET_POOL_BLOCKS_ROOT!;
    const a500 = await readMarketPool(root, {
      category: "index",
      name: "中证A500",
    });
    expect(a500.members.length).toBeGreaterThan(0);
    expect(new Set(a500.members).size).toBe(a500.members.length);
    const catalog = await marketPoolCatalog(root, "concept");
    const snapshot = await readIndustryBlocks(root, () => {}, "concept");
    expect([...snapshot.files.map((f) => f.name)].sort()).toEqual(
      [...catalog.names].sort(),
    );
    expect(snapshot.category).toBe("concept");
    expect(snapshot.files.every((f) => f.hash.length === 64)).toBe(true);
  });
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "market-pool-"));
  roots.push(root);
  for (const name of ["概念", "申万行业", "中证指数"])
    await mkdir(join(root, name));
  return root;
}
it("separates same-named concepts and industries, restricts index to A500, preserves source bytes and times", async () => {
  const root = await setup();
  const fixture = await readFile(
    new URL("../fixtures/industry-members.bin", import.meta.url),
  );
  await writeFile(join(root, "概念/同名.TXT"), fixture);
  await writeFile(join(root, "申万行业/同名.txt"), "SH600000\r\n");
  await writeFile(join(root, "中证指数/中证A500.txt"), "SH600000\r\n");
  await writeFile(join(root, "中证指数/中证500.txt"), "SH600001\r\n");
  const before = await stat(join(root, "概念/同名.TXT"));
  expect((await marketPoolCatalog(root, "index")).names).toEqual(["中证A500"]);
  expect((await marketPoolCatalog(root, "concept")).names).toEqual(["同名"]);
  const concept = await readMarketPool(root, {
    category: "concept",
    name: "同名",
  });
  const industry = await readMarketPool(root, {
    category: "industry",
    name: "同名",
  });
  expect(concept.members).toEqual(["sz000423", "sh600519", "bj920001"]);
  expect(industry.members).toEqual(["sh600000"]);
  expect(concept.hash).not.toBe(industry.hash);
  expect(await readFile(join(root, "概念/同名.TXT"))).toEqual(fixture);
  expect((await stat(join(root, "概念/同名.TXT"))).mtimeMs).toBe(
    before.mtimeMs,
  );
});
it("rejects traversal, unsupported indices, malformed and duplicate members without empty success", async () => {
  const root = await setup();
  await expect(
    readMarketPool(root, { category: "concept", name: "../secret" }),
  ).rejects.toThrow();
  await expect(
    readMarketPool(root, { category: "index", name: "中证500" }),
  ).rejects.toThrow("仅接入");
  await expect(
    readMarketPool(root, { category: "concept", name: "缺失" }),
  ).rejects.toThrow("不存在");
  for (const value of ["SH600000\nSH600000", "BAD", "SH600000\n\nSH600001"]) {
    await writeFile(join(root, "概念/非法.txt"), value);
    await expect(
      readMarketPool(root, { category: "concept", name: "非法" }),
    ).rejects.toThrow();
  }
  await writeFile(join(root, "概念/空.txt"), "");
  expect(
    (await readMarketPool(root, { category: "concept", name: "空" })).members,
  ).toEqual([]);
});
const rows: MarketPoolRow[] = [
  {
    symbol: "sh600003",
    name: "缺值",
    localDay: false,
    value: null,
    reason: "历史不足",
  },
  {
    symbol: "sh600002",
    name: "乙",
    localDay: true,
    value: { rank: 50, rps: 99, return: 0.2 },
    reason: null,
  },
  {
    symbol: "sh600001",
    name: "甲",
    localDay: true,
    value: { rank: 50, rps: 99, return: 0.2 },
    reason: null,
  },
  {
    symbol: "bj920001",
    name: "北交",
    localDay: true,
    value: null,
    reason: "非沪深",
  },
];
it("validates zero to three unique RPS conditions with integer 0-100 thresholds", () => {
  expect(marketPoolQuerySchema.parse({}).conditions).toEqual([]);
  const condition = { period: 20, side: "gte", value: 80 } as const;
  expect(
    marketPoolQuerySchema.safeParse({ conditions: [condition] }).success,
  ).toBe(true);
  expect(
    marketPoolQuerySchema.safeParse({
      conditions: [
        condition,
        { ...condition, period: 50 },
        { ...condition, period: 120 },
        { ...condition, period: 10 },
      ],
    }).success,
  ).toBe(false);
  expect(
    marketPoolQuerySchema.safeParse({ conditions: [condition, condition] })
      .success,
  ).toBe(false);
  for (const value of [-1, 101, 12.5]) {
    expect(
      marketPoolQuerySchema.safeParse({
        conditions: [{ ...condition, value }],
      }).success,
    ).toBe(false);
  }
  expect(
    marketPoolQuerySchema.safeParse({
      conditions: [{ ...condition, period: 2 }],
    }).success,
  ).toBe(false);
  expect(
    marketPoolQuerySchema.safeParse({
      conditions: [{ ...condition, side: "gt" }],
    }).success,
  ).toBe(false);
});

const conditionedRows: MarketPoolRow[] = [
  {
    symbol: "sh600001",
    name: "全中",
    localDay: true,
    value: { rank: 1, rps: 99, return: 0.1 },
    conditionValues: {
      "20": { rank: 1, rps: 90, return: 0.1 },
      "50": { rank: 2, rps: 80, return: 0.1 },
    },
    reason: null,
  },
  {
    symbol: "sh600002",
    name: "缺RPS50",
    localDay: true,
    value: { rank: 2, rps: 98, return: 0.1 },
    conditionValues: {
      "20": { rank: 2, rps: 95, return: 0.1 },
      "50": null,
    },
    reason: null,
  },
  {
    symbol: "sh600003",
    name: "差一分",
    localDay: true,
    value: { rank: 3, rps: 97, return: 0.1 },
    conditionValues: {
      "20": { rank: 3, rps: 89, return: 0.1 },
      "50": { rank: 3, rps: 80, return: 0.1 },
    },
    reason: null,
  },
  {
    symbol: "sh600004",
    name: "零值",
    localDay: true,
    value: { rank: 4, rps: 10, return: 0.1 },
    conditionValues: {
      "20": { rank: 4, rps: 0, return: 0.1 },
      "50": { rank: 1, rps: 100, return: 0.1 },
    },
    reason: null,
  },
  {
    symbol: "sh600005",
    name: "缺RPS20",
    localDay: true,
    value: { rank: 5, rps: 9, return: 0.1 },
    conditionValues: {
      "20": null,
      "50": { rank: 4, rps: 90, return: 0.1 },
    },
    reason: null,
  },
];
it("requires every condition, includes threshold boundaries, and never fills missing values", () => {
  const query = marketPoolQuerySchema.parse({
    conditions: [
      { period: 20, side: "gte", value: 90 },
      { period: 50, side: "gte", value: 80 },
    ],
  });
  const selected = selectMarketPoolRows(conditionedRows, query);
  expect(selected.map((row) => row.symbol)).toEqual(["sh600001"]);
  // Original full-market ranks and returns survive filtering unchanged.
  expect(selected[0]!.value).toEqual({ rank: 1, rps: 99, return: 0.1 });
  expect(selected[0]!.conditionValues).toEqual(
    conditionedRows[0]!.conditionValues,
  );
  // A zero threshold still needs a real value: sh600005's missing RPS20 never
  // becomes zero, while sh600004's actual zero passes ≥ 0.
  expect(
    selectMarketPoolRows(
      conditionedRows,
      marketPoolQuerySchema.parse({
        conditions: [{ period: 20, side: "gte", value: 0 }],
      }),
    ).map((row) => row.symbol),
  ).toEqual(["sh600001", "sh600002", "sh600003", "sh600004"]);
  // ≤ includes the boundary and still excludes a missing period value.
  expect(
    selectMarketPoolRows(
      conditionedRows,
      marketPoolQuerySchema.parse({
        conditions: [{ period: 50, side: "lte", value: 80 }],
      }),
    ).map((row) => row.symbol),
  ).toEqual(["sh600001", "sh600003"]);
});

it("retains full-market RPS, uses deterministic ties and keeps unavailable members until explicitly filtered", () => {
  const query = marketPoolQuerySchema.parse({});
  const selected = selectMarketPoolRows(rows, query);
  expect(selected.map((r) => r.symbol)).toEqual([
    "sh600001",
    "sh600002",
    "sh600003",
  ]);
  expect(selected[0]!.value).toEqual({ rank: 50, rps: 99, return: 0.2 });
  expect(selectMarketPoolRows(rows, { ...query, minimumRps: 90 })).toHaveLength(
    2,
  );
  expect(
    selectMarketPoolRows(rows, { ...query, search: "甲" })[0]!.symbol,
  ).toBe("sh600001");
  expect(
    selectMarketPoolRows(rows, { ...query, search: "SH600003" })[0]!.value,
  ).toBeNull();
  expect(rows[0]!.symbol).toBe("sh600003");
});
