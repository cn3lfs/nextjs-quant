import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  valuationMethod,
  valuationMethodFiles,
} from "~/server/valuation-method";
afterEach(() => vi.unstubAllEnvs());
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "quant-valuation-method-"));
  vi.stubEnv("QUANT_SKILLS_DIR", root);
  for (const file of new Set(Object.values(valuationMethodFiles).flat())) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), `# ${file}\r\n完整方法\r\n`);
  }
  return root;
}
it("loads each independent path completely with source hashes", async () => {
  const root = await fixture();
  for (const mode of ["fundamental", "guo", "value"] as const) {
    const result = await valuationMethod(mode);
    expect(result.documents.map((d) => d.file)).toEqual(
      valuationMethodFiles[mode],
    );
    for (const document of result.documents) {
      expect(document.text).toBe(`# ${document.file}\r\n完整方法\r\n`);
      expect(document.hash).toBe(
        createHash("sha256").update(document.text).digest("hex"),
      );
    }
  }
  const before = await valuationMethod("guo");
  await writeFile(
    join(
      root,
      "guo-yongqing-valuation/references/balance-sheet-restructure.md",
    ),
    "修订",
  );
  const after = await valuationMethod("guo");
  expect(after.files[1]!.hash).not.toBe(before.files[1]!.hash);
  expect((await valuationMethod("value")).files).toHaveLength(2);
});
it("missing or empty required sources cannot silently shorten a selected workflow", async () => {
  const root = await fixture();
  const file = join(root, "value-investing/references/philosophy.md");
  await writeFile(file, " \r\n");
  await expect(valuationMethod("value")).rejects.toThrow("方法文件为空");
  await unlink(file);
  await expect(valuationMethod("value")).rejects.toThrow();
  await expect(valuationMethod("unknown" as never)).rejects.toThrow("未知");
});
