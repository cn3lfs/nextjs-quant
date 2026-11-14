import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  researchSkillCatalog,
  volumePriceMethod,
} from "../../src/server/research/research-skills";
import { skillFile } from "../../src/server/infra/skill-location";
afterEach(() => vi.unstubAllEnvs());
it("registers new partial data adapters without claiming configured credentials or complete coverage", async () => {
  const root = await mkdtemp(join(tmpdir(), "quant-data-catalog-"));
  vi.stubEnv("QUANT_SKILLS_DIR", root);
  const ids = [
    "hithink-business-query",
    "hithink-management-query",
    "hithink-insresearch-query",
    "hithink-macro-query",
    "hithink-event-query",
  ];
  for (const id of ids) {
    await mkdir(dirname(skillFile(id)), { recursive: true });
    await writeFile(skillFile(id), "fixture");
  }
  vi.stubEnv("IWENCAI_API_KEY", "");
  const catalog = await researchSkillCatalog();
  for (const id of ids) {
    const e = catalog.find((s) => s.skillId === id)!;
    expect(e).toMatchObject({
      implemented: true,
      status: "adapter",
      missingFiles: [],
    });
    expect(e.prerequisites).toContain("IWENCAI_API_KEY");
  }
  expect(
    catalog.find((s) => s.skillId === "hithink-event-query")?.integrationScope,
  ).toContain("监管响应缺字段尚未接入");
});
it("does not advertise a complete quick review when reference files are missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "quant-skills-"));
  vi.stubEnv("QUANT_SKILLS_DIR", root);
  const id = "volume-price-analysis";
  await mkdir(dirname(skillFile(id, "references/vp-patterns.md")), {
    recursive: true,
  });
  await writeFile(skillFile(id), "### Phase 2: fixture\n## 参考文件");
  let item = (await researchSkillCatalog()).find(
    (s) => s.skillId === "volume-price-analysis",
  )!;
  expect(item.status).toBe("incomplete");
  expect(item.missingFiles).toHaveLength(3);
  for (const file of item.missingFiles) {
    await mkdir(dirname(skillFile(id, file)), { recursive: true });
    await writeFile(skillFile(id, file), "fixture");
  }
  item = (await researchSkillCatalog()).find(
    (s) => s.skillId === "volume-price-analysis",
  )!;
  expect(item.status).toBe("quick-review");
  expect(item.files).toEqual((await volumePriceMethod()).use.files);
  const previous = item.files.find((f) =>
    f.file.endsWith("vp-patterns.md"),
  )!.hash;
  await writeFile(skillFile(id, "references/vp-patterns.md"), "changed rules");
  item = (await researchSkillCatalog()).find(
    (s) => s.skillId === "volume-price-analysis",
  )!;
  expect(
    item.files.find((f) => f.file.endsWith("vp-patterns.md"))!.hash,
  ).not.toBe(previous);
  await unlink(skillFile(id, "references/vp-patterns.md"));
  expect(
    (await researchSkillCatalog()).find(
      (s) => s.skillId === "volume-price-analysis",
    )!.status,
  ).toBe("incomplete");
});
it("does not advertise deleted LLM workflows even when their source instructions are installed", async () => {
  const root = await mkdtemp(join(tmpdir(), "quant-current-catalog-"));
  vi.stubEnv("QUANT_SKILLS_DIR", root);
  const retired = [
    "canslim-analyst",
    "chan-theory",
    "wyckoff-trader",
    "fundamental-analyst",
    "guo-yongqing-valuation",
    "value-investing",
  ];
  for (const id of [
    ...retired,
    "hithink-finance-query",
    "announcement-search",
  ]) {
    await mkdir(dirname(skillFile(id)), { recursive: true });
    await writeFile(skillFile(id), "fixture");
  }
  const catalog = await researchSkillCatalog();
  for (const id of retired)
    expect(catalog.find((row) => row.skillId === id)).toBeUndefined();
  expect(
    catalog.find((row) => row.skillId === "hithink-finance-query"),
  ).toMatchObject({
    status: "adapter",
    implemented: true,
    outputSchema: "evidence-1",
  });
  expect(
    catalog.find((row) => row.skillId === "announcement-search"),
  ).toMatchObject({
    installed: true,
    implemented: false,
    status: "registered",
  });
});
