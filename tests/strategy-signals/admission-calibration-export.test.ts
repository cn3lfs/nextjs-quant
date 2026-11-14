import { beforeEach, expect, it, vi } from "vitest";
import { join, resolve } from "node:path";
const io = vi.hoisted(() => ({ readFile: vi.fn(), writeFile: vi.fn() }));
vi.mock("node:fs/promises", () => io);
import {
  admissionCalibrationFromExport,
  calibrationPaths,
  summarizeDistributions,
} from "../../scripts/u8-calibration-distribution";
import {
  admissionPageSchema,
  exportStrategyAdmission,
} from "~/server/research/performance/strategy-admission-service";

beforeEach(() => vi.resetAllMocks());
const root = resolve(".test-data/virtual-calibration-repo");
it("requires an exported input and an explicit external destination", () => {
  expect(
    calibrationPaths(
      ["--from", "input.json", "--out", "../distribution.json"],
      root,
    ),
  ).toEqual({
    from: join(root, "input.json"),
    target: resolve(root, "../distribution.json"),
  });
  for (const args of [
    [],
    ["--from", "input.json"],
    ["--out", "../out.json"],
    ["--from", "--out", "../out.json"],
    ["--unknown", "x"],
    ["--from", "a", "--from", "b", "--out", "../out.json"],
  ])
    expect(() => calibrationPaths(args, root)).toThrow();
  expect(io.readFile).not.toHaveBeenCalled();
  expect(io.writeFile).not.toHaveBeenCalled();
});
it("rejects repository outputs, misleading dot-prefixes and overwriting the input", () => {
  for (const out of [".", "report.json", "..report.json", "docs/report.json"])
    expect(() =>
      calibrationPaths(["--from", "input.json", "--out", out], root),
    ).toThrow("仓库外");
  expect(() =>
    calibrationPaths(
      ["--from", "../report.json", "--out", "../report.json"],
      root,
    ),
  ).toThrow("不能覆盖");
});
it("replays current exported inputs rather than trusting embedded decisions, without returning private daily series", async () => {
  const source = {
    note: "fixed numeric input",
    input: {
      dates: ["2026-01-05", "2026-01-06", "2026-01-07"],
      strategyDaily: [0.01, -0.02, 0.03],
      benchDaily: [-0.01, 0.02, 0.01],
      evidenceLevel: "合成/受控样本" as const,
    },
  };
  const exported = exportStrategyAdmission(
    source,
    admissionPageSchema.parse({}).params,
    true,
  );
  io.readFile.mockResolvedValue(
    JSON.stringify({
      ...exported,
      results: [{ isGood: true, yearlyMetrics: "fabricated" }],
    }),
  );
  const report = await admissionCalibrationFromExport("controlled.json");
  expect(io.readFile).toHaveBeenCalledWith("controlled.json", "utf8");
  expect(report.distributions).toEqual(
    summarizeDistributions(exported.results),
  );
  expect(report.evidenceLevel).toEqual(["合成/受控样本"]);
  expect(report.calibrationStatus).toBe("未标定");
  expect(report).not.toHaveProperty("inputs");
  expect(report).not.toHaveProperty("results");
  expect(JSON.stringify(report)).not.toContain("strategyDaily");
  expect(io.writeFile).not.toHaveBeenCalled();
});
it("rejects unsupported exports and missing or invalid return inputs", async () => {
  for (const invalid of [
    null,
    { version: "old-sample" },
    { version: "strategy-admission-export-1", inputs: [] },
    {
      version: "strategy-admission-export-1",
      inputs: [{ dates: ["invalid"], strategyDaily: [null] }],
    },
  ]) {
    io.readFile.mockResolvedValue(JSON.stringify(invalid));
    await expect(
      admissionCalibrationFromExport("invalid.json"),
    ).rejects.toThrow();
  }
  expect(io.writeFile).not.toHaveBeenCalled();
});
