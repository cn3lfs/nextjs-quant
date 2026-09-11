import { expect, it } from "vitest";
import { readFile, cp, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseTdxLocalBlocks,
  readTdxLocalBlocks,
  tdxBlockFiles,
} from "../src/server/tdx-local-blocks";
import {
  marketPoolCatalog,
  readMarketPool,
} from "../src/server/market-pool-files";
import { get } from "../src/server/db";
import { requireA500Selection } from "../src/server/a500-research";
import { researchSpecSchema } from "../src/lib/strategy-research";
import { readRpsBlockSource } from "../src/server/rps-block-source";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tdx-local-blocks-"));
  await cp("tests/fixtures/tdx-local-blocks", join(root, "T0002", "hq_cache"), {
    recursive: true,
  });
  return root;
}
it("ranks only top-level TDX industries and refuses damaged sources without fallback", async () => {
  const root = await fixture();
  const options = { source: "tdx" as const, tdxRoot: root, blocksRoot: "" };
  const snapshot = await readRpsBlockSource(options);
  expect(snapshot.classification).toBe("tdx-research-level1");
  expect(snapshot.files.map((file) => file.name)).toEqual([
    expect.stringContaining("研究金融"),
    expect.stringContaining("研究消费"),
  ]);
  expect(snapshot.files.flatMap((file) => file.members).sort()).toEqual([
    "sh600519",
    "sz000001",
  ]);
  const concepts = await readRpsBlockSource(options, "concept");
  expect(concepts.classification).toBe("tdx-concept");
  expect(concepts.files).toHaveLength(1);
  expect(concepts.sourceHash).toBe(snapshot.sourceHash);
  await writeFile(
    join(root, "T0002", "hq_cache", "infoharbor_block.dat"),
    "invalid",
  );
  await expect(readRpsBlockSource(options)).rejects.toThrow();
  expect(snapshot.files).toHaveLength(2);
});
it("restores full names, cross-market index members and industry ancestors from fixed bytes", async () => {
  const snapshot = await readTdxLocalBlocks(await fixture());
  expect(snapshot.blocks).toHaveLength(5);
  expect(snapshot.blocks.find((b) => b.category === "concept")).toMatchObject({
    name: "样本概念完整名",
    members: ["sh600519", "sz000001"],
    sourceDate: "2026-09-10",
  });
  expect(snapshot.blocks.find((b) => b.category === "index")).toMatchObject({
    name: "中证A500",
    code: null,
    members: ["sh600519", "sz000001"],
    sourceDate: null,
  });
  expect(
    snapshot.blocks
      .filter((b) => b.members.length === 1 && b.members[0] === "sz000001")
      .map((b) => b.name),
  ).toEqual(["研究金融", "研究银行"]);
});
it("rejects truncated membership instead of replacing it with a plausible partial pool", async () => {
  const files = Object.fromEntries(
    await Promise.all(
      tdxBlockFiles.map(async (file) => [
        file,
        new TextDecoder("gb18030").decode(
          await readFile(join("tests/fixtures/tdx-local-blocks", file)),
        ),
      ]),
    ),
  ) as Parameters<typeof parseTdxLocalBlocks>[0];
  files["infoharbor_block.dat"] = files["infoharbor_block.dat"].replace(
    "0#000001,",
    "",
  );
  expect(() => parseTdxLocalBlocks(files)).toThrow("数量不完整");
});
it("exposes local pools without an external Blocks directory and retains immutable selection evidence", async () => {
  const root = await fixture();
  const catalog = await marketPoolCatalog("", "index", root);
  expect(catalog.names).toContain("通达信·成分·中证A500");
  const selection = { category: "index", name: "通达信·成分·中证A500" };
  const first = await readMarketPool("", selection, root);
  expect(first.members).toHaveLength(2);
  const originalSpecial = await readFile(
    join(root, "T0002", "hq_cache", "spblock.dat"),
  );
  await writeFile(
    join(root, "T0002", "hq_cache", "spblock.dat"),
    Buffer.from(
      originalSpecial.toString("latin1").replace("1600519\r\n", ""),
      "latin1",
    ),
  );
  const second = await readMarketPool("", selection, root);
  expect(second.hash).not.toBe(first.hash);
  expect(second.members).toEqual(["sz000001"]);
  await writeFile(
    join(root, "T0002", "hq_cache", "spblock.dat"),
    Buffer.from("#" + "invalid"),
  );
  await expect(readMarketPool("", selection, root)).rejects.toThrow();
  expect(
    get<{ members: string[] }>(`market-pool-snapshot-${first.hash}`)?.members,
  ).toEqual(["sh600519", "sz000001"]);
});

it("accepts the explicit TDX A500 source while rejecting a different index", () => {
  const members = Array.from({ length: 500 }, (_, i) => `sh${600000 + i}`);
  const pool = {
    category: "index" as const,
    name: "通达信·成分·中证A500",
    members,
    file: "hq_cache",
    root: "tdx",
    hash: "a",
    mtimeMs: 1,
    observedAt: 1,
  };
  const spec = researchSpecSchema.parse({
    strategy: "dual-breakout",
    pool: { category: "index", name: pool.name },
    symbols: members.slice(0, 3),
    start: "2026-01-01",
    end: "2026-06-30",
    validationStart: "2026-04-01",
  });
  expect(() => requireA500Selection(spec, pool)).not.toThrow();
  expect(() =>
    requireA500Selection(spec, { ...pool, name: "通达信·成分·中证500" }),
  ).toThrow("A500");
});
