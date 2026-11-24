import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import { fixtureDirectory } from "./tests/e2e/fixture-directory";

const loaded = process.env.E2E_P1_ACCEPTANCE === "1";
const suites = [
  {
    name: "workbench",
    port: 3217,
    profile: "workbench",
    match: "**/*.spec.ts",
    ignore: [
      "p0-workflow.spec.ts",
      "stock-pool.spec.ts",
      "chart-shared-drawings.spec.ts",
      "route-visual.spec.ts",
      "p1-acceptance.spec.ts",
      "r3a-daily-path.spec.ts",
      "r2c-paper-workflow.spec.ts",
      "r3b-accounts.spec.ts",
      "r3b-accounts-r5.spec.ts",
      "r3c-workspaces.spec.ts",
      "lifecycle-review.spec.ts",
      "intel-review-r5.spec.ts",
      "system-monitor-r5.spec.ts",
      "wave-global-opt.spec.ts",
    ],
    timeout: 180000,
    serverTimeout: 120000,
    env: {},
  },
  {
    name: "p0",
    port: 3917,
    profile: "core",
    match: "p0-workflow.spec.ts",
    env: {},
  },
  {
    name: "p1",
    port: 3918,
    profile: "pool",
    match: ["stock-pool.spec.ts", "chart-shared-drawings.spec.ts"],
    env: {},
  },
  {
    name: "visual",
    port: 3919,
    profile: loaded ? "workbench" : "pool",
    match: loaded ? "p1-acceptance.spec.ts" : "route-visual.spec.ts",
    timeout: loaded ? 180000 : 60000,
    serverTimeout: loaded ? 120000 : 60000,
    env: { TZ: "Asia/Shanghai", E2E_P1_ACCEPTANCE: loaded ? "1" : "0" },
  },
  {
    name: "daily",
    port: 3920,
    profile: "core",
    match: "r3a-daily-path.spec.ts",
    env: { E2E_R3A: "1" },
  },
  {
    name: "paper",
    port: 3921,
    profile: "core",
    match: "r2c-paper-workflow.spec.ts",
    env: { E2E_R3A: "1", E2E_R2C: "1" },
  },
  {
    name: "accounts",
    port: 3922,
    profile: "core",
    match: "r3b-accounts.spec.ts",
    env: { E2E_R3B: "1" },
  },
  {
    name: "accounts-r5",
    port: 3925,
    profile: "core",
    match: "r3b-accounts-r5.spec.ts",
    env: { E2E_R3B: "1", E2E_R3B_R5: "1" },
  },
  {
    name: "workspaces",
    port: 3923,
    profile: "pool",
    match: "r3c-workspaces.spec.ts",
    env: { E2E_R3A: "1", E2E_R3B: "1", E2E_R3C: "1" },
  },
  {
    name: "review",
    port: 3924,
    profile: "core",
    match: "lifecycle-review.spec.ts",
    env: { E2E_R3B: "1", E2E_LIFECYCLE_REVIEW: "1" },
  },
  {
    name: "intel",
    port: 3926,
    profile: "core",
    match: "intel-review-r5.spec.ts",
    env: { E2E_INTEL_REVIEW: "1" },
  },
  {
    name: "system",
    port: 3927,
    profile: "core",
    match: "system-monitor-r5.spec.ts",
    env: { E2E_SYSTEM_MONITOR: "1" },
  },
  {
    name: "wave-opt",
    port: 3928,
    profile: "pool",
    match: "wave-global-opt.spec.ts",
    timeout: 120000,
    serverTimeout: 120000,
    env: {},
  },
];
// Each project owns a fresh server. Only selected projects start servers;
// an unfiltered run uses distinct ports and directories for every project.
const cliSelected = process.argv.flatMap((arg, i, args) =>
  arg.startsWith("--project=")
    ? [arg.slice(10)]
    : arg === "--project"
      ? [args[i + 1]!]
      : [],
);
// Workers reload this file without the runner's --project arguments.
const selected = cliSelected.length
  ? cliSelected
  : (process.env.QUANT_E2E_PROJECTS?.split(",").filter(Boolean) ?? []);
process.env.QUANT_E2E_PROJECTS = selected.join(",");
const active = suites.filter(
  (s) => !selected.length || selected.includes(s.name),
);
if (process.env.E2E_PORT && active.length !== 1)
  throw new Error("E2E_PORT requires exactly one project");
const paths = (name: string) =>
  fixtureDirectory(
    process.env.E2E_DATA_DIR
      ? active.length === 1
        ? process.env.E2E_DATA_DIR
        : resolve(process.env.E2E_DATA_DIR, name)
      : `.test-data/${name}-acceptance`,
  );
const portFor = (suite: (typeof suites)[number]) =>
  Number(
    process.env.E2E_PORT && active.length === 1
      ? process.env.E2E_PORT
      : suite.port,
  );
export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  reporter:
    active.length === 1 && active[0]?.name === "workbench"
      ? [
          ["list"],
          ["json", { outputFile: resolve(paths("workbench"), "report.json") }],
        ]
      : "list",
  projects: suites.map((suite) => ({
    name: suite.name,
    testMatch: suite.match,
    testIgnore: suite.ignore,
    timeout: suite.timeout ?? 60000,
    expect: suite.name === "workbench" ? undefined : { timeout: 15000 },
    outputDir: fixtureDirectory(resolve(paths(suite.name), "results")),
    snapshotPathTemplate:
      suite.name === "visual" ? "{testDir}/baselines/p1/{arg}{ext}" : undefined,
    use: {
      baseURL: `http://127.0.0.1:${portFor(suite)}`,
      channel: "chrome",
      headless: true,
      viewport:
        suite.name === "workbench"
          ? { width: 1600, height: 1000 }
          : { width: 1440, height: 900 },
      ...(suite.name === "workbench"
        ? {
            actionTimeout: 15000,
            navigationTimeout: 30000,
            trace: "retain-on-failure" as const,
          }
        : { screenshot: "only-on-failure" as const }),
      ...(suite.name === "visual"
        ? {
            deviceScaleFactor: 1,
            locale: "zh-CN",
            timezoneId: "Asia/Shanghai",
            actionTimeout: 15000,
          }
        : {}),
    },
  })),
  webServer: active.map((suite) => ({
    command: "pnpm exec tsx tests/e2e/p0-server.ts",
    url: `http://127.0.0.1:${portFor(suite)}`,
    reuseExistingServer: false,
    timeout: suite.serverTimeout ?? 60000,
    env: Object.fromEntries(
      Object.entries({
        ...suite.env,
        PORT: String(portFor(suite)),
        E2E_DATA_DIR: paths(suite.name),
        E2E_FIXTURE_PROFILE: suite.profile,
      }).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
  })),
});
