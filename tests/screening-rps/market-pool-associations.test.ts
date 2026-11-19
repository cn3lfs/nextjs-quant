import { afterEach, expect, it } from "vitest";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  marketPoolAssociations,
  selectMarketPoolAssociations,
} from "../../src/server/market/market-pool-associations";
import { readTdxLocalBlocks } from "tstdx/local";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "market-pool-associations-"));
  roots.push(root);
  await cp("tests/fixtures/tdx-local-blocks", join(root, "T0002", "hq_cache"), {
    recursive: true,
  });
  return root;
}

it("returns compact industry and concept rows from the current TDX snapshot", async () => {
  const root = await fixture();
  const local = await readTdxLocalBlocks(root);
  const result = await marketPoolAssociations({ symbol: "sh600519" }, root);
  expect(result).toMatchObject({
    symbol: "sh600519",
    status: "ready",
    industry: [
      {
        category: "industry",
        code: "881003",
        name: "研究消费",
        selectionName: "通达信·881003·研究消费",
        sourceDate: null,
      },
    ],
    concept: [
      {
        category: "concept",
        code: "880001",
        name: "样本概念完整名",
        selectionName: "通达信·880001·样本概念完整名",
        sourceDate: "2026-09-10",
      },
    ],
  });
  expect(result.observedAt).toBeGreaterThan(0);
  // Index membership is not a supported association, and members stay on disk.
  expect(JSON.stringify(result)).not.toContain("sz000001");
  expect(JSON.stringify(result)).not.toContain("中证A500");
  expect(
    selectMarketPoolAssociations(local.blocks, "sh600519").concept,
  ).toEqual(result.concept);
});

it("separates a symbol with no supported membership from a broken source", async () => {
  const root = await fixture();
  expect(await marketPoolAssociations({ symbol: "sh600196" }, root)).toEqual({
    symbol: "sh600196",
    status: "ready",
    observedAt: expect.any(Number),
    industry: [],
    concept: [],
  });
  await writeFile(
    join(root, "T0002", "hq_cache", "infoharbor_block.dat"),
    "invalid",
  );
  const broken = await marketPoolAssociations({ symbol: "sh600519" }, root);
  expect(broken).toMatchObject({
    symbol: "sh600519",
    status: "source-unavailable",
    observedAt: null,
    industry: [],
    concept: [],
  });
  expect(broken.message).toMatch(/^通达信板块资料不可用/);
});

it("distinguishes an unconfigured source and rejects non-stock symbols", async () => {
  expect(await marketPoolAssociations({ symbol: "sh600519" }, "")).toEqual({
    symbol: "sh600519",
    status: "source-unconfigured",
    observedAt: null,
    industry: [],
    concept: [],
    message: "未配置本机通达信目录，无法读取所属板块。",
  });
  await expect(
    marketPoolAssociations({ symbol: "sh880652" }, ""),
  ).rejects.toThrow("仅支持 A 股股票");
});
