import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  calculateFactor,
  factorCatalog,
  qlibAlpha158Variants,
} from "trading-strategy-core/factors";
import type { Bar } from "trading-strategy-core/bars";

it("matches all 157 available Alpha158 variants against the pinned expressions interpreted by pandas/numpy", () => {
  const golden = JSON.parse(
    readFileSync("tests/fixtures/factors/qlib-alpha158-golden.json", "utf8"),
  ) as {
    bars: Bar[];
    indices: number[];
    sourceSha256: string;
    expected: Record<string, (number | null)[]>;
  };
  expect(
    createHash("sha256")
      .update(
        readFileSync("docs/data-sources/public-factors/qlib-v0.9.7/loader.py"),
      )
      .digest("hex"),
  ).toBe(golden.sourceSha256);
  expect(Object.keys(golden.expected).sort()).toEqual(
    qlibAlpha158Variants.map((v) => v.name).sort(),
  );
  for (const variant of qlibAlpha158Variants) {
    const actual = calculateFactor(golden.bars, variant.spec).values;
    golden.indices.forEach((index, position) => {
      const expected = golden.expected[variant.name]![position];
      if (expected === null)
        expect(actual[index], `${variant.name}@${index}`).toBeNull();
      else
        expect(actual[index], `${variant.name}@${index}`).toBeCloseTo(
          expected!,
          9,
        );
    });
  }
});
it("keeps exact frozen-source hashes and discloses every unavailable Alpha101 number", () => {
  const root = "docs/data-sources/public-factors/qlib-v0.9.7/";
  const manifest = JSON.parse(readFileSync(root + "manifest.json", "utf8")) as {
    files: { path: string; sha256: string }[];
  };
  for (const file of manifest.files)
    expect(
      createHash("sha256")
        .update(readFileSync(root + file.path))
        .digest("hex"),
    ).toBe(file.sha256);
  const coverage = JSON.parse(
    readFileSync(
      "docs/data-sources/public-factors/alpha101-coverage.json",
      "utf8",
    ),
  ) as {
    items: {
      number: number;
      id: string;
      status: string;
      dependencies: string[];
    }[];
  };
  expect(coverage.items.map((v) => v.number)).toEqual(
    Array.from({ length: 101 }, (_, i) => i + 1),
  );
  expect(
    coverage.items.filter((v) => v.status === "implemented").map((v) => v.id),
  ).toEqual(
    factorCatalog.filter((f) => f.id.startsWith("alpha101-")).map((f) => f.id),
  );
  expect(
    coverage.items
      .filter((v) => v.status !== "implemented")
      .every((v) => v.dependencies.length > 0),
  ).toBe(true);
});
