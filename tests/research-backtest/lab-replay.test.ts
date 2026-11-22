import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { strategyObjectSchema } from "trading-strategies";
import { executeLabBacktest } from "../../src/server/research/lab-backtest";
import { runResearchLabReplay } from "../../scripts/research-lab-replay";
import { dataDirectory } from "../../src/server/db";
import { saveSettings, settings } from "../../src/server/infra/settings";
import { readBars } from "../../src/server/market/bar-store/read-bars";
import fixture from "../fixtures/tdx-gbbq.json";

// Runtime bytes are not needed to replay a frozen request; keep this fixture
// independent of whichever packaged worker happens to be present.
vi.mock("../../src/server/research/forward-identity", () => ({
  forwardExecutionBuildHash: () => "d".repeat(64),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const strategy = strategyObjectSchema.parse({
  id: "QA-lab-replay",
  version: 1,
  market: "cn-equity",
  period: "day",
  universe: { kind: "symbols", symbols: ["sh600000"] },
  entry: { kind: "constant", value: true },
  exit: { maxBars: 2 },
  sizing: { kind: "weight", weight: 0.2 },
  sleeve: "swing",
});
const bars = ["2025-01-02", "2025-01-03", "2025-01-06", "2025-01-07"].map(
  (date) => ({
    date,
    open: 10,
    high: 10.2,
    low: 9.8,
    close: 10,
    volume: 100000,
    amount: 1000000,
  }),
);
const fakeRead = (async () => ({
  bars,
  rawBars: bars,
  hash: "QA-replay",
  barStore: {
    formingDates: [],
    priceRepaired: false,
    adjustmentReference: "QA-replay",
  },
})) as unknown as typeof readBars;

async function labExport() {
  const root = join(dataDirectory(), "tdx");
  await mkdir(join(root, "T0002/hq_cache"), { recursive: true });
  await writeFile(
    join(root, "T0002/hq_cache/gbbq"),
    Buffer.from(fixture.gbbqBase64, "base64"),
  );
  saveSettings({ ...settings(), tdxRoot: root });
  const work = {
    type: "lab-backtest" as const,
    input: {
      strategy,
      initial: 100000,
      start: bars[0]!.date,
      end: bars.at(-1)!.date,
    },
  };
  // The first half of the comparison is the real server entry.
  const live = await executeLabBacktest(work, () => {}, fakeRead);
  const directory = join(dataDirectory(), "lab-replay");
  await mkdir(directory, { recursive: true });
  const exported = { input: work, result: live };
  const exportPath = join(directory, "task-export.json");
  await writeFile(exportPath, JSON.stringify(exported));
  return { live, exportPath, directory, exported };
}

function quiet() {
  const sink = (_chunk: string | Uint8Array) => true;
  return {
    stdout: vi.spyOn(process.stdout, "write").mockImplementation(sink),
    stderr: vi.spyOn(process.stderr, "write").mockImplementation(sink),
  };
}

describe("read-only replay of an exported lab backtest", () => {
  it("fails the lab task when the next symbol's raw and signal pair exceeds the shared budget", async () => {
    const symbols = ["sh600000", "sh600001"];
    const read: typeof readBars = (input, frozen, _fetchHistory, budget) =>
      readBars(
        input,
        frozen,
        async () => ({ bars, source: "thsdk-hq", historyExhausted: true }),
        budget,
      );
    const work = {
      type: "lab-backtest" as const,
      input: {
        source: "thsdk" as const,
        strategy: {
          ...strategy,
          universe: { kind: "symbols" as const, symbols },
        },
        initial: 100000,
        start: bars[0]!.date,
        end: bars.at(-1)!.date,
      },
    };
    vi.stubEnv("QUANT_BAR_STORE_MAX_BARS", "12");
    vi.stubEnv("QUANT_BAR_STORE_MAX_ESTIMATED_BYTES", undefined);
    await expect(
      executeLabBacktest(work, undefined, read),
    ).rejects.toMatchObject({
      code: "BAR_STORE_BUDGET_EXCEEDED",
      diagnostic: {
        period: "day",
        symbol: symbols[1],
        stage: "source",
        retainedBars: 8,
        requestedBars: 8,
        maxBars: 12,
        estimatedBytes: 4096,
        maxEstimatedBytes: 3072,
      },
    });
    vi.stubEnv("QUANT_BAR_STORE_MAX_BARS", "16");
    const result = await executeLabBacktest(work, undefined, read);
    expect(result.frozen.request.instruments.map((i) => i.symbol)).toEqual(
      symbols,
    );
  });

  it("replays the frozen request through the CLI and matches the lab entry", async () => {
    const { live, exportPath, directory } = await labExport();
    expect(live.result.fills.length).toBeGreaterThan(0);
    const outputPath = join(directory, "replay.json");
    const io = quiet();
    const exitCode = await runResearchLabReplay([
      "--export",
      exportPath,
      "--output",
      outputPath,
    ]);
    io.stdout.mockRestore();
    io.stderr.mockRestore();
    expect(exitCode).toBe(0);
    const replayed = JSON.parse(await readFile(outputPath, "utf8")) as {
      inputHash: string;
      result: typeof live.result;
    };
    expect(replayed.inputHash).toBe(live.inputHash);
    expect(replayed.result.fills).toEqual(live.result.fills);
    expect(replayed.result.rejections).toEqual(live.result.rejections);
    expect(replayed.result.curve).toEqual(live.result.curve);
    expect(replayed.result.fills.length).toBeGreaterThan(0);
  });

  it("refuses to overwrite an existing output and leaves it unchanged", async () => {
    const { exportPath, directory } = await labExport();
    const outputPath = join(directory, "existing-replay.json");
    // An existing output can alias the export itself; exclusive create must
    // refuse it rather than truncate the file the replay verifies.
    const existing = await readFile(exportPath, "utf8");
    await writeFile(outputPath, existing);
    const io = quiet();
    const exitCode = await runResearchLabReplay([
      "--export",
      exportPath,
      "--output",
      outputPath,
    ]);
    const stderr = io.stderr.mock.calls
      .map(([chunk]) => String(chunk))
      .join("");
    io.stdout.mockRestore();
    io.stderr.mockRestore();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--output 已存在，拒绝覆盖");
    expect(await readFile(outputPath, "utf8")).toBe(existing);
    expect(await readFile(exportPath, "utf8")).toBe(existing);
  });

  it("rejects a tampered frozen request before replaying it", async () => {
    const { directory, exported } = await labExport();
    const tampered = structuredClone(exported);
    tampered.result.frozen.request.initial = 100001;
    const tamperedPath = join(directory, "tampered-frozen.json");
    await writeFile(tamperedPath, JSON.stringify(tampered));
    const io = quiet();
    const exitCode = await runResearchLabReplay(["--export", tamperedPath]);
    const stderr = io.stderr.mock.calls
      .map(([chunk]) => String(chunk))
      .join("");
    io.stdout.mockRestore();
    io.stderr.mockRestore();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("冻结请求摘要不匹配");
  });

  it("rejects an export whose original result no longer matches the replay", async () => {
    const { directory, exported } = await labExport();
    const tampered = structuredClone(exported);
    tampered.result.result.fills[0]!.price += 1;
    const tamperedPath = join(directory, "tampered-result.json");
    await writeFile(tamperedPath, JSON.stringify(tampered));
    const io = quiet();
    const exitCode = await runResearchLabReplay(["--export", tamperedPath]);
    const stderr = io.stderr.mock.calls
      .map(([chunk]) => String(chunk))
      .join("");
    io.stdout.mockRestore();
    io.stderr.mockRestore();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("fills 不一致");
  });
});
