import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { inspectFullDayPackage } from "../../../src/server/data-sources/tdx/tdx-full-day-import";
const fixture = (name: string) => `tests/fixtures/tdx-full-day/${name}.zip`;
it.skipIf(process.platform !== "win32")(
  "extracts requested histories, reports missing symbols, and leaves the archive unchanged",
  async () => {
    const before = await readFile(fixture("valid"));
    const result = await inspectFullDayPackage(fixture("valid"), [
      "sh600000",
      "sh600001",
    ]);
    expect(result.records.map((row) => row.symbol)).toEqual(["sh600000"]);
    expect(result.records[0]?.bars[0]?.close).toBe(11);
    expect(result.missing).toEqual(["sh600001"]);
    expect(await readFile(fixture("valid"))).toEqual(before);
  },
);
it
  .skipIf(process.platform !== "win32")
  .each(["traversal", "duplicate", "incomplete"])(
  "rejects %s packages before publication",
  async (name) => {
    await expect(
      inspectFullDayPackage(fixture(name), ["sh600000"]),
    ).rejects.toThrow();
  },
);
