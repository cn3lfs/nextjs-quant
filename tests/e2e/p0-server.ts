import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { encodeFiveMinuteBar } from "tstdx/local";
import { settingsSchema, type Bar } from "../../src/lib/domain";
import { migrate } from "../../src/server/db/migrations";
import daily from "../fixtures/breakout-valid.json";
import gbbq from "../fixtures/tdx-gbbq.json";
import { fixtureDirectory } from "./fixture-directory";
import { seedWorkbenchFixture } from "./workbench-fixture";

// A fresh database and local files for each acceptance run. Never load the
// user's settings or use the production database default.
const parent = fixtureDirectory(
  process.env.E2E_DATA_DIR ?? ".test-data/p0-acceptance",
);
const profile = process.env.E2E_FIXTURE_PROFILE ?? "core";
if (!["core", "pool", "workbench"].includes(profile))
  throw new Error(`Unknown acceptance fixture profile: ${profile}`);
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, "fixture-"));
const root = join(directory, "tdx");
for (const subdir of ["vipdoc/sh/fzline", "vipdoc/sh/lday", "T0002/hq_cache"])
  await mkdir(join(root, subdir), { recursive: true });
function dayFile(bars: readonly Bar[]) {
  return Buffer.concat(
    bars.map((bar) => {
      const row = Buffer.alloc(32);
      row.writeUInt32LE(Number(bar.date.replaceAll("-", "")), 0);
      [bar.open, bar.high, bar.low, bar.close].forEach((value, index) =>
        row.writeUInt32LE(Math.round(value * 100), 4 + index * 4),
      );
      row.writeFloatLE(bar.amount, 20);
      row.writeUInt32LE(bar.volume, 24);
      return row;
    }),
  );
}
// Daily bars exercise the existing fixed breakout fixture, under a synthetic
// security name. Minute bars exercise an actual current-engine purchase.
await writeFile(join(root, "vipdoc/sh/lday/sh600000.day"), dayFile(daily.bars));
const dates = ["2026-10-09", "2026-10-12"];
await writeFile(
  join(root, "vipdoc/sh/lday/sh000001.day"),
  dayFile(
    dates.map((date) => ({
      date,
      open: 10,
      high: 10,
      low: 10,
      close: 10,
      volume: 100000,
      amount: 1000000,
    })),
  ),
);
await writeFile(
  join(root, "vipdoc/sh/fzline/sh600000.lc5"),
  Buffer.concat(
    dates.flatMap((day, dayIndex) =>
      Array.from({ length: 48 }, (_, index) => {
        const minute = index < 24 ? 575 + index * 5 : 785 + (index - 24) * 5;
        return encodeFiveMinuteBar({
          time: `${day} ${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00`,
          open: dayIndex ? 10.5 : 10,
          close: dayIndex ? 10.5 : 10,
          high: 11,
          low: 9,
          volume: 100000,
          amount: 1000000,
        });
      }),
    ),
  ),
);
const poolFixture = profile === "pool";
const names = Buffer.alloc(50 + (poolFixture ? 41 : 1) * 360);
for (let index = 0; index < (poolFixture ? 41 : 1); index++) {
  names.write(String(600000 + index), 50 + index * 360, "ascii");
  names.write(
    index ? `P1_POOL_${index}` : "P0_FIXTURE",
    81 + index * 360,
    "ascii",
  );
}
if (poolFixture)
  await writeFile(
    join(root, "vipdoc/sh/lday/sh600040.day"),
    dayFile(daily.bars),
  );
await writeFile(join(root, "T0002/hq_cache/shs.tnf"), names);
await writeFile(
  join(root, "T0002/hq_cache/gbbq"),
  Buffer.from(gbbq.gbbqBase64, "base64"),
);
const db = new Database(join(directory, "quant.sqlite"));
try {
  migrate(db);
  // Reserve the existing scheduler lease for this fixture parent. Child web
  // processes still execute explicitly requested local tasks, while wall-clock
  // schedulers cannot race assertions or initiate unrelated background work.
  db.prepare(
    "INSERT INTO records (id,kind,payload,updated_at) VALUES (?,?,?,?)",
  ).run(
    "scheduler-owner",
    "lease",
    JSON.stringify({ owner: "e2e-fixture", pid: process.pid }),
    Date.now(),
  );
  const settings = settingsSchema.parse({
    tdxRoot: root,
    marketDataSource: "local",
    autoNewsAnalysis: false,
    outboundProxy: "",
    calendar: dates,
    clsDbPath: join(directory, "unused-news.sqlite"),
    industryBlocksRoot: join(directory, "unused-blocks"),
  });
  db.prepare(
    "INSERT INTO records (id,kind,payload,updated_at) VALUES (?,?,?,?)",
  ).run("settings", "settings", JSON.stringify(settings), Date.now());
  const retired = {
    id: "p0-retired-screen",
    type: "screen",
    status: "completed",
    progress: 100,
    createdAt: 1,
    updatedAt: 1,
    input: { strategy: {}, period: "day", symbols: ["sh600000"] },
    result: {
      candidates: [{ symbol: "sh600000", name: "LEGACY_SHOULD_NOT_RENDER" }],
      total: 1,
      errors: [],
    },
  };
  db.prepare(
    "INSERT INTO records (id,kind,payload,updated_at) VALUES (?,?,?,?)",
  ).run(retired.id, "job", JSON.stringify(retired), 1);
  if (profile === "workbench") await seedWorkbenchFixture(root, db);
  if (process.env.E2E_R3A === "1") {
    // The normal 30% industry cap stays enabled; provide explicit synthetic
    // classification rather than disabling a guard to make the UI path pass.
    const blocks = join(directory, "qa-blocks");
    await mkdir(join(blocks, "申万行业"), { recursive: true });
    await writeFile(join(blocks, "申万行业", "QA行业.txt"), "SH600000\n");
    settings.industryBlocksRoot = blocks;
    db.prepare("UPDATE records SET payload=? WHERE id='settings'").run(
      JSON.stringify(settings),
    );
    const { seedR3aFixture } = await import("./r3a-fixture");
    seedR3aFixture(db);
  }
  if (process.env.E2E_R2C === "1") {
    const { seedR2cFixture } = await import("./r2c-fixture");
    seedR2cFixture(db);
  }
  if (process.env.E2E_R3B === "1") {
    const { seedR3bFixture } = await import("./r3b-fixture");
    seedR3bFixture(db);
  }
  if (process.env.E2E_R3B_R5 === "1") {
    if (process.env.E2E_R3B !== "1")
      throw new Error("R3b R5 requires the R3b fixture");
    const { seedR3bR5Fixture } = await import("./r3b-r5-fixture");
    await seedR3bR5Fixture(db, root);
  }
  if (process.env.E2E_LIFECYCLE_REVIEW === "1") {
    const { seedLifecycleReviewFixture } =
      await import("./lifecycle-review-fixture");
    seedLifecycleReviewFixture(db);
  }
  if (process.env.E2E_INTEL_REVIEW === "1") {
    // 25 reports with 20 per page, one sample per day and 25 saved versions.
    const { seedClsReview } = await import("../helpers/cls-review-fixture");
    seedClsReview(db, 25, 25);
  }
  if (process.env.E2E_R3C === "1") {
    const { seedR3cFixture } = await import("./r3c-fixture");
    await seedR3cFixture(db, directory);
  }
  if (process.env.E2E_P1_ACCEPTANCE === "1") {
    if (profile !== "workbench")
      throw new Error("P1 requires the workbench fixture");
    const { seedP1Acceptance } = await import("./p1-fixture");
    await seedP1Acceptance(root, db);
  }
} finally {
  db.close();
}
console.log(`P0 fixture: ${directory}`);
const server = spawn(process.execPath, [resolve("scripts/start.mjs")], {
  stdio: "inherit",
  env: {
    ...process.env,
    E2E_FIXTURE_PROFILE: profile,
    QUANT_DATA_DIR: directory,
    QUANT_RESEARCH_BAR_STORE_DIR: "",
  },
});
for (const event of ["SIGINT", "SIGTERM"] as const)
  process.on(event, () => server.kill());
server.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
server.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
