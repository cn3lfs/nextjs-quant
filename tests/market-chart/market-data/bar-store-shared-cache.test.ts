import { expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  rm,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import samples from "../../fixtures/vipdoc-source-samples.json";
import { readBars } from "~/server/market/bar-store/read-bars";
import { sqlite } from "~/server/db";
import {
  cachePath,
  columnCacheDirectory,
} from "~/server/market/bar-store/column-cache";

it("reuses one research cache across isolated data directories without weakening source isolation", async () => {
  const parent = resolve(".test-data");
  await mkdir(parent, { recursive: true });
  const owned = await mkdtemp(join(parent, "bar-store-reuse-"));
  const root = join(owned, "tdx"),
    shared = join(owned, "shared");
  try {
    const sample = samples.find(
      (s) => s.symbol === "sh600000" && s.period === "day",
    )!;
    const source = join(root, "vipdoc", "sh", "lday", "sh600000.day");
    await mkdir(join(root, "vipdoc", "sh", "lday"), { recursive: true });
    const original = Buffer.from(sample.hex, "hex");
    await writeFile(source, original);
    vi.stubEnv("QUANT_RESEARCH_BAR_STORE_DIR", shared);
    vi.stubEnv("QUANT_DATA_DIR", join(owned, "data-one"));
    const input = {
      instrument: { market: "cn-equity" as const, symbol: "sh600000" },
      root,
      period: "day" as const,
      adjustment: "none" as const,
    };
    const first = await readBars(input);
    const file = cachePath(`tdx:${root}:sh600000:day`);
    const before = await stat(file);
    const body = await readFile(file);
    vi.stubEnv("QUANT_DATA_DIR", join(owned, "data-two"));
    const second = await readBars(input);
    expect(second.bars).toEqual(first.bars);
    expect(second.hash).toBe(first.hash);
    expect(cachePath(`tdx:${root}:sh600000:day`)).toBe(file);
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(file)).toEqual(body);
    expect(await readFile(source)).toEqual(original);
    vi.stubEnv("QUANT_RESEARCH_BAR_STORE_DIR", "relative-cache");
    expect(() => columnCacheDirectory()).toThrow(
      "must be absolute and inside .test-data",
    );
    vi.stubEnv(
      "QUANT_RESEARCH_BAR_STORE_DIR",
      join(parent, "..", "outside-cache"),
    );
    expect(() => columnCacheDirectory()).toThrow(
      "must be absolute and inside .test-data",
    );
    vi.stubEnv("QUANT_RESEARCH_BAR_STORE_DIR", join(root, "must-not-write"));
    await expect(readBars(input)).rejects.toThrow(
      "缓存目录不能位于通达信只读目录内",
    );
  } finally {
    const connection = sqlite();
    if (connection.open) connection.close();
    vi.unstubAllEnvs();
    if (!owned.startsWith(parent + sep))
      throw new Error("Unexpected cleanup target");
    await rm(owned, { recursive: true, force: true });
  }
});
