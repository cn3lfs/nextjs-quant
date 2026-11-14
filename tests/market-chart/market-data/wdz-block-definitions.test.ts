import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  mkdir,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import wdzExclusions from "~/server/data/wdz-block-ranking-exclusions.json";
import { readIndustryBlocks } from "~/server/market/industry-blocks";
import {
  eligibilityFromTdx,
  filterBlockSnapshot,
} from "~/server/market/block-eligibility";
import { readTdxLocalBlocks } from "tstdx/local";
import { readRpsBlockSource } from "~/server/screening/rps-block-source";
import { excludedBlock } from "~/lib/market/block-eligibility";

const archive = "docs/data-sources/wdz-blocks/2026-11-07";
const fixture = "tests/fixtures/wdz-block-definitions";
const oldStyleNames = [
  "中字头",
  "低市盈率",
  "历史新高",
  "基金重仓",
  "微盘股",
  "昨日涨停",
  "昨日连板",
  "百元股",
  "社保重仓",
  "科创成长层",
  "融资融券",
  "证金汇金",
  "近端次新",
];
async function tdxFixture() {
  const root = await mkdtemp(join(tmpdir(), "wdz-definitions-"));
  await cp("tests/fixtures/tdx-local-blocks", join(root, "T0002/hq_cache"), {
    recursive: true,
  });
  return root;
}
it("keeps the reviewed manifest identity and byte-exact classification fixtures", async () => {
  const manifest = JSON.parse(
    await readFile(join(archive, "manifest.json"), "utf8"),
  ) as {
    fileCount: number;
    bytes: number;
    sha256: string;
    files: { path: string; bytes: number; sha256: string }[];
  };
  expect(manifest.fileCount).toBe(2319);
  expect(manifest.files).toHaveLength(manifest.fileCount);
  expect(manifest.bytes).toBe(3703787);
  const files = await readdir(join(fixture, "概念"));
  expect(files).toHaveLength(41);
  for (const name of files) {
    const path = `概念/${name}`;
    const original = manifest.files.find((file) => file.path === path);
    expect(original, path).toBeDefined();
    const bytes = await readFile(join(fixture, path));
    expect(bytes.length, path).toBe(original!.bytes);
    expect(createHash("sha256").update(bytes).digest("hex"), path).toBe(
      original!.sha256,
    );
  }
  const identities = manifest.files.map(({ path, bytes, sha256 }) => ({
    path,
    bytes,
    sha256,
  }));
  expect(
    createHash("sha256").update(JSON.stringify(identities)).digest("hex"),
  ).toBe(manifest.sha256);
  expect(wdzExclusions.snapshotHash).toBe(manifest.sha256);
});
it("finds all reviewed style aliases while retaining sampled industry themes", async () => {
  const local = await readTdxLocalBlocks(await tdxFixture());
  const policy = eligibilityFromTdx({
    ...local,
    excludedBlocks: oldStyleNames.map((name) => ({
      name,
      code: null,
      kind: "style" as const,
    })),
  });
  // Full source names remain in the manifest: preserve the 452 -> 416 classification check
  // without requiring all membership files to stay in Git.
  const manifest = JSON.parse(
    await readFile(join(archive, "manifest.json"), "utf8"),
  ) as { files: { path: string }[] };
  const conceptFiles = manifest.files
    .filter(
      (file) => file.path.startsWith("概念/") && file.path.endsWith(".txt"),
    )
    .map((file) => file.path.slice("概念/".length));
  expect(conceptFiles).toHaveLength(452);
  expect(
    conceptFiles.filter(
      (file) => !excludedBlock(file.slice(0, -4), file, policy),
    ),
  ).toHaveLength(416);
  const raw = await readIndustryBlocks(fixture, undefined, "concept");
  expect(raw.files).toHaveLength(41);
  // Known violations in the unfiltered source prove that exclusion is exercised.
  expect(raw.files.map((file) => file.name)).toEqual(
    expect.arrayContaining([
      "大盘",
      "中盘",
      "低价",
      "高派息",
      "QFII持股",
      "ST板块",
    ]),
  );
  const filtered = filterBlockSnapshot(raw, policy);
  expect(filtered.files).toHaveLength(5);
  expect(filtered.selectionPolicy!.removed).toHaveLength(36);
  expect(
    new Set(wdzExclusions.groups.flatMap((group) => group.names)).size,
  ).toBe(23);
  for (const name of [
    ...oldStyleNames,
    ...wdzExclusions.groups.flatMap((group) => group.names),
  ])
    expect(
      filtered.files.some((file) => file.name === name),
      name,
    ).toBe(false);
  expect(filtered.files.map((file) => file.name)).toEqual(
    expect.arrayContaining([
      "上海国资",
      "福建国资",
      "海南自贸区",
      "人工智能",
      "线控底盘",
    ]),
  );
  expect(filterBlockSnapshot(filtered, policy)).toBe(filtered);
});
it("excludes WDZ aliases at the actual RPS source before forming the ranking population", async () => {
  const root = await tdxFixture();
  await mkdir(join(root, "Blocks/概念"), { recursive: true });
  for (const name of [
    "大盘",
    "中盘",
    "小盘",
    "低价",
    "高派息",
    "QFII持股",
    "人工智能",
    "线控底盘",
  ])
    await writeFile(join(root, "Blocks/概念", `${name}.txt`), "SZ000001\n");
  const snapshot = await readRpsBlockSource(
    { source: "blocks", blocksRoot: join(root, "Blocks"), tdxRoot: root },
    "concept",
  );
  expect(snapshot.files.map((file) => file.name)).toEqual([
    "人工智能",
    "线控底盘",
  ]);
  expect(snapshot.selectionPolicy!.removed).toHaveLength(6);
});
