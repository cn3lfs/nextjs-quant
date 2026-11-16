import { expect, it } from "vitest";
import {
  restoreHistoricalBytes,
  oracleHash,
  assertOracleContributors,
} from "../../scripts/lib/research/classic-oracle";

it("restores only hash-matching historical bytes and refuses changed code", () => {
  const original = Buffer.from("const target = 0.15;\r\n");
  expect(
    restoreHistoricalBytes(
      Buffer.from("const target = 0.15;\n"),
      oracleHash(original),
    ),
  ).toEqual({ bytes: original, eol: "restored-crlf" });
  expect(() =>
    restoreHistoricalBytes(
      Buffer.from("const target = 0.16;\n"),
      oracleHash(original),
    ),
  ).toThrow("do not match");
});
it("rejects even bundled third-party contributions and permits fully removed dependencies", () => {
  const approved = new Set(["historical:exact-source.ts"]);
  expect(() =>
    assertOracleContributors(
      {
        "historical:exact-source.ts": { bytesInOutput: 10 },
        "node_modules/current.js": { bytesInOutput: 1 },
      },
      approved,
    ),
  ).toThrow("Unverified source");
  expect(() =>
    assertOracleContributors(
      {
        "historical:exact-source.ts": { bytesInOutput: 10 },
        "node_modules/current.js": { bytesInOutput: 0 },
      },
      approved,
    ),
  ).not.toThrow();
});
