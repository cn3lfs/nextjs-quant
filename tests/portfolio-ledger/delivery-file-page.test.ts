import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { deliveryFilePage } from "../../src/server/portfolio/delivery-file-page";

it("enumerates complete supported files in stable pages and detects directory changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-delivery-files-"));
  try {
    for (let i = 0; i < 43; i++)
      await writeFile(
        join(directory, `${String(i).padStart(3, "0")}.csv`),
        "synthetic",
      );
    await mkdir(join(directory, "folder.csv"));
    await writeFile(join(directory, "unsupported.xlsx"), "synthetic");
    const first = await deliveryFilePage({ directory });
    expect(first.items).toHaveLength(20);
    expect(first.count).toBe(43);
    const second = await deliveryFilePage({
      directory,
      offset: 20,
      version: first.version,
    });
    const last = await deliveryFilePage({
      directory,
      offset: 40,
      version: first.version,
    });
    expect(
      new Set(
        [...first.items, ...second.items, ...last.items].map((row) => row.path),
      ).size,
    ).toBe(43);
    expect(last.nextOffset).toBeNull();
    expect(first.items[0]).toMatchObject({
      name: "000.csv",
      size: 9,
      error: null,
    });
    expect(
      (await deliveryFilePage({ directory, keyword: "042" })).items,
    ).toHaveLength(1);
    await writeFile(join(directory, "new.txt"), "synthetic");
    await expect(
      deliveryFilePage({ directory, offset: 20, version: first.version }),
    ).rejects.toThrow("目录文件已变化");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
