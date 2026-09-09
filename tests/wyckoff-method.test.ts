import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  wyckoffMethod,
  wyckoffMethodFiles,
} from "../src/server/wyckoff-method";
afterEach(() => vi.unstubAllEnvs());
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "quant-wyckoff-method-"));
  vi.stubEnv("QUANT_SKILLS_DIR", root);
  const directory = join(root, "wyckoff-trader");
  await mkdir(join(directory, "references"), { recursive: true });
  for (const file of wyckoffMethodFiles)
    await writeFile(join(directory, file), `# ${file}\r\n完整资料\r\n`);
  return directory;
}
it("preserves complete documents and hashes every required source revision", async () => {
  const directory = await fixture();
  const before = await wyckoffMethod();
  expect(before.documents).toHaveLength(11);
  for (const document of before.documents) {
    expect(document.text).toBe(`# ${document.file}\r\n完整资料\r\n`);
    expect(document.hash).toBe(
      createHash("sha256").update(document.text).digest("hex"),
    );
  }
  await writeFile(
    join(directory, "references/wyckoff-mtf-guide.md"),
    "修订多周期定义",
  );
  const after = await wyckoffMethod();
  expect(
    after.files
      .filter((file, i) => file.hash !== before.files[i]!.hash)
      .map((f) => f.file),
  ).toEqual(["references/wyckoff-mtf-guide.md"]);
});
it("refuses missing or empty required methods rather than silently reducing the workflow", async () => {
  const directory = await fixture();
  const path = join(directory, "references/wyckoff-relative-strength.md");
  await writeFile(path, " \r\n");
  await expect(wyckoffMethod()).rejects.toThrow("方法文件为空");
  await unlink(path);
  await expect(wyckoffMethod()).rejects.toThrow();
});
