import { describe, expect, it } from "vitest";
import {
  findStrategyRepresentative,
  hasOneRepresentativePerFamily,
  listStrategyRepresentatives,
} from "../src/index.js";

describe("strategy representative catalog", () => {
  it("keeps exactly one public representative per family", () => {
    const items = listStrategyRepresentatives();
    expect(items.length).toBe(9);
    expect(hasOneRepresentativePerFamily()).toBe(true);
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
    expect(new Set(items.map((item) => item.family)).size).toBe(items.length);
  });

  it("does not claim a backtest for planned representatives", () => {
    for (const item of listStrategyRepresentatives()) {
      if (item.readiness === "implemented-no-backtest") {
        expect(item.evidence).toBeUndefined();
      } else {
        expect(item.evidence).toBeDefined();
        expect(item.evidence?.rawPath).toContain(".codex-runs/r3-results/");
        expect(item.evidence?.evidenceLevel).toBe(
          item.family === "chan" || item.family === "wyckoff"
            ? "raw-only"
            : "raw-record-summary",
        );
      }
    }
  });

  it("rejects missing and duplicate families", () => {
    const items = listStrategyRepresentatives();
    expect(hasOneRepresentativePerFamily(items.slice(1))).toBe(false);
    expect(hasOneRepresentativePerFamily([...items.slice(1), items[1]!])).toBe(
      false,
    );
    expect(items.map((item) => item.family).sort()).toEqual([
      "breakout",
      "chan",
      "growth",
      "indicator-confluence",
      "industry-chain",
      "sentiment",
      "value",
      "volume-price",
      "wyckoff",
    ]);
  });

  it("resolves a representative by stable package id", () => {
    expect(findStrategyRepresentative("chan")?.presetId).toBe(
      "chan-third-native",
    );
    expect(findStrategyRepresentative("missing")).toBeUndefined();
  });
});
