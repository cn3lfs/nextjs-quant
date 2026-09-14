import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  valuationMethod,
  valuationMethodFiles,
  valuationMethodVersions,
} from "../src/server/valuation-method";
import {
  wyckoffMethod,
  wyckoffMethodFiles,
  wyckoffMethodVersion,
} from "../src/server/wyckoff-method";
import {
  canslimMethodFiles,
  canslimMethodVersion,
} from "../src/server/canslim-method";
import {
  chanMethod,
  chanMethodFiles,
  chanMethodVersion,
} from "../src/server/chan-method";
import {
  researchSkillCatalog,
  volumePriceMethod,
} from "../src/server/research-skills";
afterEach(() => vi.unstubAllEnvs());
it("uses the actual fundamental, Guo and value method dependencies and rejects missing or empty methods", async () => {
  const root = await mkdtemp(join(tmpdir(), "quant-valuation-catalog-"));
  vi.stubEnv("QUANT_SKILLS_DIR", root);
  for (const file of new Set(Object.values(valuationMethodFiles).flat())) {
    const parts = file.split("/");
    await mkdir(join(root, ...parts.slice(0, -1)), { recursive: true });
    await writeFile(join(root, file), `fixture ${file}`);
  }
  const catalog = await researchSkillCatalog();
  for (const [id, modes] of [
    ["fundamental-analyst", ["fundamental"]],
    ["guo-yongqing-valuation", ["guo"]],
    ["value-investing", ["value"]],
  ] as const) {
    const entry = catalog.find((s) => s.skillId === id)!;
    expect(entry).toMatchObject({
      implemented: true,
      status: "staged-research",
      missingFiles: [],
    });
    const runtimeFiles = new Map<string, string>();
    for (const mode of modes) {
      const method = await valuationMethod(mode);
      expect(entry.ruleVersion).toContain(method.version);
      expect(method.version).toBe(valuationMethodVersions[mode]);
      for (const f of method.files)
        runtimeFiles.set(f.file.slice(id.length + 1), f.hash);
    }
    expect(entry.files).toEqual(
      [...runtimeFiles].map(([file, hash]) => ({ file, hash })),
    );
  }
  const missing = join(
    root,
    "guo-yongqing-valuation/references/balance-sheet-restructure.md",
  );
  await unlink(missing);
  expect(
    (await researchSkillCatalog()).find(
      (s) => s.skillId === "guo-yongqing-valuation",
    ),
  ).toMatchObject({
    status: "incomplete",
    missingFiles: ["references/balance-sheet-restructure.md"],
  });
  await expect(valuationMethod("guo")).rejects.toThrow();
  const philosophy = join(root, "value-investing/references/philosophy.md");
  await writeFile(philosophy, " \r\n");
  expect(
    (await researchSkillCatalog()).find((s) => s.skillId === "value-investing"),
  ).toMatchObject({
    status: "incomplete",
    missingFiles: ["references/philosophy.md"],
  });
  await expect(valuationMethod("value")).rejects.toThrow(/为空/);
});
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
    await mkdir(join(root, id));
    await writeFile(join(root, id, "SKILL.md"), "fixture");
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
it("registers partial Wyckoff research with its actual method dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "quant-wyckoff-catalog-"));
  vi.stubEnv("QUANT_SKILLS_DIR", root);
  const directory = join(root, "wyckoff-trader");
  await mkdir(join(directory, "references"), { recursive: true });
  for (const file of wyckoffMethodFiles)
    await writeFile(join(directory, file), `fixture ${file}`);
  const item = (await researchSkillCatalog()).find(
    (s) => s.skillId === "wyckoff-trader",
  )!;
  expect(item).toMatchObject({
    implemented: true,
    status: "staged-research",
    ruleVersion: wyckoffMethodVersion,
    missingFiles: [],
  });
  expect(item.files).toEqual((await wyckoffMethod()).files);
  expect(item.integrationScope).toContain("不提供综合评分、目标价或自动信号");
  await unlink(join(directory, "references/wyckoff-mtf-guide.md"));
  expect(
    (await researchSkillCatalog()).find((s) => s.skillId === "wyckoff-trader"),
  ).toMatchObject({
    status: "incomplete",
    missingFiles: ["references/wyckoff-mtf-guide.md"],
  });
});
it("registers Chan annotation with the report's files and version, exposing missing references", async () => {
  const root = await mkdtemp(join(tmpdir(), "quant-chan-catalog-"));
  vi.stubEnv("QUANT_SKILLS_DIR", root);
  const directory = join(root, "chan-theory");
  await mkdir(join(directory, "references"), { recursive: true });
  for (const file of chanMethodFiles)
    await writeFile(join(directory, file), "## 定义（第62课）\n> 待核验引文。");
  const item = (await researchSkillCatalog()).find(
    (s) => s.skillId === "chan-theory",
  )!;
  expect(item).toMatchObject({
    status: "staged-research",
    implemented: true,
    ruleVersion: chanMethodVersion,
    outputSchema: chanMethodVersion,
    missingFiles: [],
  });
  expect(item.files).toEqual((await chanMethod()).files);
  expect(item.integrationScope).toContain("不开放自动扫描或信号");
  await unlink(join(directory, "references/04-dynamics.md"));
  expect(
    (await researchSkillCatalog()).find((s) => s.skillId === "chan-theory"),
  ).toMatchObject({
    status: "incomplete",
    missingFiles: ["references/04-dynamics.md"],
  });
  await expect(chanMethod()).rejects.toThrow();
});
it("does not advertise a complete quick review when reference files are missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "quant-skills-"));
  vi.stubEnv("QUANT_SKILLS_DIR", root);
  const directory = join(root, "volume-price-analysis");
  await mkdir(join(directory, "references"), { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    "### Phase 2: fixture\n## 参考文件",
  );
  let item = (await researchSkillCatalog()).find(
    (s) => s.skillId === "volume-price-analysis",
  )!;
  expect(item.status).toBe("incomplete");
  expect(item.missingFiles).toHaveLength(3);
  for (const file of item.missingFiles)
    await writeFile(join(directory, file), "fixture");
  item = (await researchSkillCatalog()).find(
    (s) => s.skillId === "volume-price-analysis",
  )!;
  expect(item.status).toBe("quick-review");
  expect(item.files).toEqual((await volumePriceMethod()).use.files);
  const previous = item.files.find((f) =>
    f.file.endsWith("vp-patterns.md"),
  )!.hash;
  await writeFile(
    join(directory, "references/vp-patterns.md"),
    "changed rules",
  );
  item = (await researchSkillCatalog()).find(
    (s) => s.skillId === "volume-price-analysis",
  )!;
  expect(
    item.files.find((f) => f.file.endsWith("vp-patterns.md"))!.hash,
  ).not.toBe(previous);
  await unlink(join(directory, "references/vp-patterns.md"));
  expect(
    (await researchSkillCatalog()).find(
      (s) => s.skillId === "volume-price-analysis",
    )!.status,
  ).toBe("incomplete");
});
it("distinguishes installed instructions from implemented partial adapters", async () => {
  const root = await mkdtemp(join(tmpdir(), "quant-skills-"));
  vi.stubEnv("QUANT_SKILLS_DIR", root);
  for (const id of ["hithink-finance-query", "canslim-analyst"]) {
    await mkdir(join(root, id));
    await writeFile(join(root, id, "SKILL.md"), "fixture");
  }
  const catalog = await researchSkillCatalog();
  expect(catalog).toHaveLength(54);
  expect(catalog.some((s) => s.skillId === "tdx-finance-skill")).toBe(false);
  expect(
    catalog.find((s) => s.skillId === "hithink-finance-query"),
  ).toMatchObject({
    status: "adapter",
    implemented: true,
    outputSchema: "evidence-1",
  });
  expect(catalog.find((s) => s.skillId === "canslim-analyst")).toMatchObject({
    status: "incomplete",
    implemented: true,
    outputSchema: canslimMethodVersion,
  });
  expect(catalog.find((s) => s.skillId === "wyckoff-trader")?.status).toBe(
    "missing",
  );
});
it("advertises the CANSLIM flow only with the report's complete method file set", async () => {
  const root = await mkdtemp(join(tmpdir(), "quant-canslim-catalog-"));
  vi.stubEnv("QUANT_SKILLS_DIR", root);
  await mkdir(join(root, "canslim-analyst", "references"), { recursive: true });
  for (const file of canslimMethodFiles)
    await writeFile(join(root, "canslim-analyst", file), `fixture ${file}`);
  const item = (await researchSkillCatalog()).find(
    (s) => s.skillId === "canslim-analyst",
  )!;
  expect(item).toMatchObject({
    status: "staged-research",
    implemented: true,
    ruleVersion: canslimMethodVersion,
    missingFiles: [],
  });
  expect(item.files.map((f) => f.file)).toEqual([...canslimMethodFiles]);
  expect(item.files.every((f) => /^[a-f0-9]{64}$/.test(f.hash ?? ""))).toBe(
    true,
  );
  await unlink(join(root, "canslim-analyst", "references/data-queries.md"));
  expect(
    (await researchSkillCatalog()).find((s) => s.skillId === "canslim-analyst"),
  ).toMatchObject({
    status: "incomplete",
    missingFiles: ["references/data-queries.md"],
  });
});
