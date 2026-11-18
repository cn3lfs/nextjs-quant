import { ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { acceptanceEnvironment } from "../../src/lib/common/acceptance-environment";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(async () => undefined),
  mkdtemp: vi.fn(async (prefix: string) => `${prefix}mock`),
  writeFile: vi.fn(async () => undefined),
}));
vi.mock("better-sqlite3", () => ({
  default: class {
    prepare() {
      return { run: vi.fn() };
    }
    close() {}
  },
}));
vi.mock("../../src/server/db/migrations", () => ({ migrate: vi.fn() }));
vi.mock("../e2e/workbench-fixture", () => ({
  seedWorkbenchFixture: vi.fn(async () => undefined),
}));

const signals = ["SIGINT", "SIGTERM"] as const;
let existingListeners: Map<NodeJS.Signals, Set<NodeJS.SignalsListener>>;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  existingListeners = new Map(
    signals.map((signal) => [signal, new Set(process.listeners(signal))]),
  );
  const server = new ChildProcess();
  vi.spyOn(server, "kill").mockReturnValue(true);
  vi.mocked(spawn).mockReturnValue(server);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubEnv("E2E_DATA_DIR", ".test-data/p0-launcher-contract");
  for (const flag of [
    "E2E_R3A",
    "E2E_R2C",
    "E2E_R3B",
    "E2E_R3C",
    "E2E_LIFECYCLE_REVIEW",
    "E2E_P1_ACCEPTANCE",
  ])
    vi.stubEnv(flag, "");
});

afterEach(() => {
  for (const signal of signals)
    for (const listener of process.listeners(signal))
      if (!existingListeners.get(signal)?.has(listener))
        process.removeListener(signal, listener);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([
  [undefined, "core"],
  ["pool", "pool"],
  ["workbench", "workbench"],
])(
  "passes fixture profile %s to the application as %s",
  async (input, expected) => {
    vi.stubEnv("E2E_FIXTURE_PROFILE", input);
    await import("../e2e/p0-server");
    expect(spawn).toHaveBeenCalledTimes(1);
    const [executable, args, options] = vi.mocked(spawn).mock.calls[0]!;
    expect(executable).toBe(process.execPath);
    expect(args).toEqual([resolve("scripts/start.mjs")]);
    // Compare only relevant fields: a failed assertion must never print the
    // inherited environment, which can contain credentials.
    const childEnvironment = options!.env!;
    expect(childEnvironment.E2E_FIXTURE_PROFILE).toBe(expected);
    expect(childEnvironment.QUANT_DATA_DIR).toBe(
      resolve(".test-data/p0-launcher-contract/fixture-mock"),
    );
    expect(childEnvironment.QUANT_RESEARCH_BAR_STORE_DIR).toBe("");
    expect(
      acceptanceEnvironment(childEnvironment.E2E_FIXTURE_PROFILE),
    ).toContain("合成测试数据");
  },
);
