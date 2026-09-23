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
