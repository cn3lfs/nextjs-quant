import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseResearchBenchmark } from "../src/server/research-dataset";
import { requireA500Selection } from "../src/server/a500-research";
import { researchSpecSchema } from "../src/lib/strategy-research";
it("ignores unrelated malformed index history while rejecting corruption inside the study warmup", () => {
  const bytes = readFileSync("tests/fixtures/research-index-window.bin");
  expect(
    parseResearchBenchmark(bytes, "2026-09-10", "2026-09-10"),
  ).toHaveLength(251);
  const corrupt = Buffer.from(bytes);
  corrupt.writeUInt32LE(0, corrupt.length - 32 + 4);
  expect(() =>
    parseResearchBenchmark(corrupt, "2026-09-10", "2026-09-10"),
  ).toThrow("非法");
  expect(() =>
    parseResearchBenchmark(bytes.subarray(1), "2026-09-10", "2026-09-10"),
  ).toThrow("不完整");
});
it("requires a complete A500 membership and allows only its selected subset", () => {
  const members = Array.from(
    { length: 500 },
    (_, i) => `sh${String(600000 + i)}`,
  );
  const pool = {
    category: "index" as const,
    name: "中证A500",
    members,
    file: "中证A500.txt",
    root: "D:/Blocks",
    hash: "a".repeat(64),
    mtimeMs: 1,
    observedAt: 1,
  };
  const spec = researchSpecSchema.parse({
    strategy: "dual-breakout",
    symbols: members.slice(0, 5),
    start: "2026-01-01",
    end: "2026-06-30",
    validationStart: "2026-04-01",
  });
  expect(() => requireA500Selection(spec, pool)).not.toThrow();
  expect(() =>
    requireA500Selection({ ...spec, symbols: ["sz000001"] }, pool),
  ).toThrow("选择");
  expect(() =>
    requireA500Selection(spec, { ...pool, members: members.slice(1) }),
  ).toThrow("500");
});
