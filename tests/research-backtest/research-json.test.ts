import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  researchJsonHash,
  streamResearchJson,
  writeResearchJsonFile,
} from "../../src/server/backtest/research-json";

describe("research JSON streaming", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const directory of tempDirs.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  it("matches JSON.stringify bytes and the historical SHA-256 hash", () => {
    const value = {
      z: "中文\n",
      date: new Date("2020-01-02T03:04:05.000Z"),
      custom: { toJSON: (key: string) => `custom:${key}` },
      omitted: undefined,
      array: [undefined, Number.NaN, -0, { keep: true, omit: () => 1 }],
    };
    const expected = JSON.stringify(value);
    const chunks: string[] = [];
    streamResearchJson(value, (chunk) => chunks.push(chunk));

    expect(chunks.join("")).toBe(expected);
    expect(researchJsonHash(value)).toBe(
      createHash("sha256").update(expected).digest("hex"),
    );
  });

  it("falls back to chunks when the root JSON string is too large", () => {
    const value = { rows: [{ id: 1 }, { id: 2 }], text: "保留原字节" };
    const nativeStringify = JSON.stringify.bind(JSON) as typeof JSON.stringify;
    const expected = nativeStringify(value)!;
    const expectedHash = createHash("sha256").update(expected).digest("hex");
    const stringify = vi.spyOn(JSON, "stringify").mockImplementation(((
      input: unknown,
    ) => {
      if (input === value) throw new RangeError("Invalid string length");
      return nativeStringify(input);
    }) as typeof JSON.stringify);
    try {
      expect(researchJsonHash(value)).toBe(expectedHash);
      const directory = mkdtempSync(join(tmpdir(), "quant-research-json-"));
      tempDirs.push(directory);
      const path = join(directory, "result.json");
      writeResearchJsonFile(path, value);
      expect(readFileSync(path, "utf8")).toBe(expected);
    } finally {
      stringify.mockRestore();
    }
  });
});
