import { expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEstimateTdxZeroVolume } from "../../scripts/estimate-tdx-zero-volume";
import { spawnCommand } from "../../scripts/lib/local-check.mjs";
import { encodeFiveMinuteBar } from "tstdx/local";
import {
  estimateChartVolume,
  estimateCalibratedVolume,
  visualEstimateFromPlan,
  lc5TimeKey,
} from "../../scripts/lib/tdx-estimated-volume";

const bar = (volume = 0) =>
  encodeFiveMinuteBar({
    time: "2002-12-02 09:35:00",
    open: 9,
    high: 12,
    low: 8,
    close: 10,
    amount: 10000,
    volume,
  });

it("visual estimates require an exact zero-volume snapshot and explicit reference method", () => {
  const b = bar(),
    hex = b.toString("hex");
  expect(
    visualEstimateFromPlan("sh000001", b, hex, 12000, "nearby-amount-ratio", 5),
  ).toBe(12000);
  expect(
    visualEstimateFromPlan("sh1b0003", b, hex, 12000, "same-clock-volume", 3),
  ).toBe(12000);
  expect(
    visualEstimateFromPlan("../sh000001", b, hex, 12000, "nearest-volume", 1),
  ).toBeNull();
  expect(
    visualEstimateFromPlan("sh000001", b, hex, 12000, "nearby-amount-ratio", 4),
  ).toBeNull();
  expect(
    visualEstimateFromPlan(
      "sh000001",
      b,
      hex,
      0x100000000,
      "nearest-volume",
      1,
    ),
  ).toBeNull();
  const changed = Buffer.from(b);
  changed.writeFloatLE(10001, 20);
  expect(
    visualEstimateFromPlan(
      "sh000001",
      changed,
      hex,
      12000,
      "nearest-volume",
      1,
    ),
  ).toBeNull();
});

it("visual CLI fills a historical index alias, preserves other bytes and skips stale snapshots", async () => {
  const root = mkdtempSync(join(tmpdir(), "quant-visual-"));
  try {
    for (const market of ["sh", "sz"])
      mkdirSync(join(root, "vipdoc", market, "fzline"), { recursive: true });
    const first = bar(),
      second = bar();
    second.writeUInt16LE(580, 2);
    const target = join(root, "vipdoc/sh/fzline/sh1b0003.lc5");
    const original = Buffer.concat([first, second]);
    original.writeUInt32LE(555, 28);
    writeFileSync(target, original);
    const report = join(root, "visual.csv");
    const stale = Buffer.from(second);
    stale.writeFloatLE(9000, 20);
    writeFileSync(
      report,
      "symbol,time,status,estimate,oldHex,method,kind,samples,windowDays,ratio\n" +
        `sh1b0003,2002-12-02 09:35:00,candidate-visual-estimate,4321,${original.subarray(0, 32).toString("hex")},same-clock-volume,index,5,7,0\n` +
        `sh1b0003,2002-12-02 09:40:00,candidate-visual-estimate,4321,${stale.toString("hex")},same-clock-volume,index,5,7,0\n`,
    );
    for (const attempt of [1, 2]) {
      const out = join(root, `out-${attempt}`);
      expect(
        await runEstimateTdxZeroVolume([
          "--tdx-root",
          root,
          "--visual-plan",
          report,
          "--out",
          out,
        ]),
      ).toBe(0);
      const expected = Buffer.from(original);
      expected.writeUInt32LE(4321, 24);
      expect(readFileSync(target)).toEqual(expected);
      const result = JSON.parse(
        readFileSync(join(out, "summary.json"), "utf8"),
      );
      expect(result.repaired).toBe(attempt === 1 ? 1 : 0);
      expect(result.changedSnapshot).toBe(1);
      expect(result.errors).toBe(0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("estimates integer shares from HLC3 and excludes indices, repos and unknown units", () => {
  for (const symbol of [
    "sh600000",
    "sh688001",
    "sh510300",
    "sz000001",
    "sz159001",
  ])
    expect(estimateChartVolume(symbol, bar())).toBe(1000);
  for (const symbol of [
    "sh000001",
    "sz399001",
    "sh204001",
    "sz131810",
    "sh900001",
    "../sh600000",
  ])
    expect(estimateChartVolume(symbol, bar())).toBeNull();
  expect(estimateChartVolume("sh600000", bar(123))).toBeNull();
  expect(lc5TimeKey(bar(), 0, 2027)).toBe(20021202 * 1440 + 575);
});

it("uses calibrated bond factors and repo divisors without dividing by repo interest", () => {
  expect(estimateCalibratedVolume("sh129805", bar(), "cash-bond", 0.01)).toBe(
    10,
  );
  expect(estimateCalibratedVolume("sz125302", bar(), "cash-bond", 10)).toBe(
    10000,
  );
  expect(
    estimateCalibratedVolume("sh201001", bar(), "historical-repo", 100),
  ).toBe(100);
  expect(estimateCalibratedVolume("sh900901", bar(), "b-share", 1)).toBe(1000);
  expect(
    estimateCalibratedVolume("sh900901", bar(), "b-share", 100),
  ).toBeNull();
  expect(
    estimateCalibratedVolume("sh751001", bar(), "cash-bond", 1),
  ).toBeNull();
  expect(
    estimateCalibratedVolume("sh000001", bar(), "cash-bond", 1),
  ).toBeNull();
});

it("applies a calibrated plan with byte preservation, rejects weak evidence and repeats safely", async () => {
  const root = mkdtempSync(join(tmpdir(), "quant-calibrated-"));
  try {
    for (const market of ["sh", "sz"])
      mkdirSync(join(root, "vipdoc", market, "fzline"), { recursive: true });
    const original = bar();
    original.writeUInt32LE(9876, 28);
    const target = join(root, "vipdoc/sh/fzline/sh201001.lc5");
    writeFileSync(target, original);
    const report = join(root, "plan.csv");
    const header =
      "symbol,time,kind,status,estimate,factor,previousSamples,followingSamples,agreement,snapshotAmount,snapshotPrice\n";
    const line =
      "sh201001,2002-12-02 09:35:00,historical-repo,candidate-chart-estimate,100,100,100,100,0.99,10000,10\n";
    const run = (out: string) =>
      runEstimateTdxZeroVolume([
        "--tdx-root",
        root,
        "--calculation-plan",
        report,
        "--out",
        out,
      ]);
    writeFileSync(report, header + line.replace("0.99", "0.94"));
    await expect(run(join(root, "bad"))).rejects.toThrow();
    expect(readFileSync(target)).toEqual(original);
    writeFileSync(report, header + line);
    for (const attempt of [1, 2]) {
      const out = join(root, `out-${attempt}`);
      expect(await run(out)).toBe(0);
      const expected = Buffer.from(original);
      expected.writeUInt32LE(100, 24);
      expect(readFileSync(target)).toEqual(expected);
      const summary = JSON.parse(
        readFileSync(join(out, "summary.json"), "utf8"),
      );
      expect(summary.repaired).toBe(attempt === 1 ? 1 : 0);
      expect(summary.errors).toBe(0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("leaves tiny placeholder amounts, invalid prices and uint32 overflow unresolved", () => {
  for (const amount of [0.1, 0, NaN, Infinity, 1e20]) {
    const b = bar();
    b.writeFloatLE(amount, 20);
    expect(estimateChartVolume("sh600000", b)).toBeNull();
  }
  const b = bar();
  b.writeFloatLE(0, 12);
  expect(estimateChartVolume("sh600000", b)).toBeNull();
});
it("CLI patches only eligible zero-volume bytes, records provenance and repeats safely", async () => {
  const root = mkdtempSync(join(tmpdir(), "quant-estimate-"));
  try {
    for (const market of ["sh", "sz"])
      mkdirSync(join(root, "vipdoc", market, "fzline"), { recursive: true });
    const original = Buffer.concat([bar(), bar(55)]);
    original.writeUInt16LE(580, 34);
    original.writeUInt32LE(12345, 28);
    const target = join(root, "vipdoc/sh/fzline/sh600000.lc5");
    writeFileSync(target, original);
    const report = join(root, "remaining.csv");
    writeFileSync(
      report,
      "symbol,time,category,amount,low,high\nsh600000,2002-12-02 09:35:00,security-estimate,10000,8,12\nsh600000,2002-12-02 09:40:00,security-estimate,10000,8,12\nsh1b0003,2002-12-02 09:35:00,other-unit-unconfirmed,10000,8,12\n",
    );
    for (const attempt of [1, 2]) {
      const out = join(root, `out-${attempt}`);
      expect(
        await runEstimateTdxZeroVolume([
          "--tdx-root",
          root,
          "--remaining-report",
          report,
          "--out",
          out,
        ]),
      ).toBe(0);
      const expected = Buffer.from(original);
      expected.writeUInt32LE(1000, 24);
      expect(readFileSync(target)).toEqual(expected);
      const summary = JSON.parse(
        readFileSync(join(out, "summary.json"), "utf8"),
      );
      expect(summary.repaired).toBe(attempt === 1 ? 1 : 0);
      expect(summary.errors).toBe(0);
      expect(summary.excludedCategory).toBe(1);
      if (attempt === 1) {
        const journal = readFileSync(join(out, "estimates.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(journal[0].patches[0].oldHex).toBe(
          original.subarray(0, 32).toString("hex"),
        );
        expect(journal[1].state).toBe("verified");
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("runs the estimate CLI entrypoint and patches a one-bar file", async () => {
  const root = mkdtempSync(join(tmpdir(), "quant-estimate-smoke-"));
  try {
    for (const market of ["sh", "sz"])
      mkdirSync(join(root, "vipdoc", market, "fzline"), { recursive: true });
    const target = join(root, "vipdoc/sh/fzline/sh600000.lc5");
    const original = bar();
    original.writeUInt32LE(12345, 28);
    writeFileSync(target, original);
    const report = join(root, "remaining.csv");
    const out = join(root, "out");
    writeFileSync(
      report,
      "symbol,time,category,amount,low,high\n" +
        "sh600000,2002-12-02 09:35:00,security-estimate,10000,8,12\n",
    );

    const result = await spawnCommand(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/estimate-tdx-zero-volume.ts",
        "--tdx-root",
        root,
        "--remaining-report",
        report,
        "--out",
        out,
      ],
      { env: process.env, captureOutput: true, timeout: 30_000 },
    );

    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(
      JSON.parse(readFileSync(join(out, "summary.json"), "utf8")),
    ).toMatchObject({
      root,
      repaired: 1,
      errors: 0,
    });
    const expected = Buffer.from(original);
    expected.writeUInt32LE(1000, 24);
    expect(readFileSync(target)).toEqual(expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("exits nonzero on weak calibration evidence without changing the target", async () => {
  const root = mkdtempSync(join(tmpdir(), "quant-estimate-weak-"));
  try {
    for (const market of ["sh", "sz"])
      mkdirSync(join(root, "vipdoc", market, "fzline"), { recursive: true });
    const target = join(root, "vipdoc/sh/fzline/sh201001.lc5");
    const original = bar();
    writeFileSync(target, original);
    const report = join(root, "plan.csv");
    writeFileSync(
      report,
      "symbol,time,kind,status,estimate,factor,previousSamples,followingSamples,agreement,snapshotAmount,snapshotPrice\n" +
        "sh201001,2002-12-02 09:35:00,historical-repo,candidate-chart-estimate,100,100,100,100,0.94,10000,10\n",
    );

    const result = await spawnCommand(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/estimate-tdx-zero-volume.ts",
        "--tdx-root",
        root,
        "--calculation-plan",
        report,
        "--out",
        join(root, "out"),
      ],
      { env: process.env, captureOutput: true, timeout: 30_000 },
    );

    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBeGreaterThan(0);
    expect(result.stderr).toContain("Invalid calibration evidence");
    expect(readFileSync(target)).toEqual(original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
