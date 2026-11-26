import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { exitedResult, spawnErrorResult } from "../../electron/startup-health";
import {
  checkSmokeShutdown,
  createSmokeJob,
  defaultSmokePassed,
  observeSmokeProcess,
  seedCandidateDatabase,
  terminateSmokeProcess,
  windowsProcesses,
} from "../../scripts/desktop-smoke.mjs";
import {
  desktopStartupLine,
  type DesktopStartupOutcome,
} from "../../electron/startup-log";
import {
  candidateSmokePassed,
  diagnoseSmokePassed,
  isThsdkDisabledRejection,
  lifecycleSmokePassed,
  readStartupConclusion,
  smokePassed,
} from "../../scripts/lib/desktop-smoke-result.mjs";

describe("candidate release receipt", () => {
  const receipt = {
    gitCommit: "a".repeat(40),
    appVersion: "0.4.0",
    schemaVersion: 26,
    czscSha256: "b".repeat(64),
    thsdkSha256: "c".repeat(64),
    envFileCount: 0,
    residualProcesses: 0,
    failedAt: null,
    checks: {
      upgradeV24: true,
      upgradeV25: true,
      rejectV27: true,
      clsWebView: true,
      thsdkLoad: true,
      thsdkRejectBadHash: true,
      diagnose: true,
      cleaned: true,
    },
  };

  it("requires the exact version, source commit, DLL identities and clean package and process counts", () => {
    expect(candidateSmokePassed(receipt)).toBe(true);
    for (const mismatch of [
      { gitCommit: null },
      { gitCommit: "1234567" },
      { appVersion: "0.3.0" },
      { schemaVersion: 24 },
      { schemaVersion: 25 },
      { schemaVersion: 27 },
      { czscSha256: "g".repeat(64) },
      { thsdkSha256: null },
      { thsdkSha256: "ab" },
      { envFileCount: 1 },
      { envFileCount: null },
      { residualProcesses: 1 },
      { residualProcesses: null },
      { failedAt: "diagnose" },
    ]) {
      expect(candidateSmokePassed({ ...receipt, ...mismatch })).toBe(false);
    }
  });

  it("rejects a failure in any required probe or cleanup", () => {
    for (const check of Object.keys(receipt.checks)) {
      expect(
        candidateSmokePassed({
          ...receipt,
          checks: { ...receipt.checks, [check]: false },
        }),
        check,
      ).toBe(false);
    }
  });

  it.each([24, 25, 27])(
    "plants a real v%i SQLite fixture with related business rows",
    async (version) => {
      const directory = await mkdtemp(
        join(await realpath(tmpdir()), "quant-candidate-fixture-"),
      );
      const path = join(directory, "quant.sqlite");
      try {
        await seedCandidateDatabase(directory, version);
        const db = new Database(path, { readonly: true, fileMustExist: true });
        try {
          expect(db.pragma("user_version", { simple: true })).toBe(version);
          expect(db.pragma("foreign_key_check")).toEqual([]);
          expect(db.prepare("SELECT symbol FROM sim_fills").all()).toEqual([
            { symbol: "sh600000" },
          ]);
          expect(
            db
              .prepare(
                "SELECT delta_atoms FROM sim_cash_flows WHERE fill_id = 'fill'",
              )
              .get(),
          ).toEqual({ delta_atoms: -10050000 });
          const table = db.prepare(
            "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?",
          );
          expect(Boolean(table.get("pipeline_runs"))).toBe(version >= 25);
          expect(Boolean(table.get("intraday_watch_rules"))).toBe(
            version === 27,
          );
          expect(Boolean(table.get("future_only"))).toBe(version === 27);
        } finally {
          db.close();
        }
      } finally {
        await unlink(path).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
        await rmdir(directory);
      }
    },
  );
});

const noResiduals = {
  backend: 0,
  worker: 0,
  czscWorker: 0,
  thsdkWorker: 0,
  other: 0,
};

const at = new Date("2026-11-19T01:02:03.456Z");
const record = (outcome: DesktopStartupOutcome) =>
  desktopStartupLine(outcome, at);

it.skipIf(process.platform !== "win32")(
  "terminates a surviving smoke descendant by job handle and leaves unrelated processes running",
  async () => {
    const job = createSmokeJob();
    const unrelated = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { windowsHide: true },
    );
    const unrelatedExit = once(unrelated, "exit");
    const launcher = spawn(
      process.execPath,
      [
        "-e",
        `
    process.once("message", () => {
      const child = require("node:child_process").spawn(process.execPath,
        ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore", windowsHide: true });
      child.once("spawn", () => process.exit(0));
      child.once("error", () => process.exit(1));
    });
  `,
      ],
      { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true },
    );
    const launcherExit = once(launcher, "exit");
    try {
      expect(job.attach(launcher)).toBe(true);
      launcher.send("start");
      expect(await launcherExit).toEqual([0, null]);
      await expect.poll(() => job.activeProcesses()).toBe(1);
      job.terminate();
      await expect.poll(() => job.activeProcesses()).toBe(0);
      expect(unrelated.exitCode).toBeNull();
      expect(unrelated.signalCode).toBeNull();
      expect(unrelated.kill()).toBe(true);
    } finally {
      job.close();
      launcher.kill();
      unrelated.kill();
      await Promise.all([launcherExit, unrelatedExit]);
    }
  },
);

it.skipIf(process.platform !== "win32")(
  "reports and reaps a process outside the job only when live identity and profile match",
  async () => {
    const data = join(process.env.QUANT_DATA_DIR!, "escape fixture");
    const launch = (profile: string) =>
      spawn(
        process.execPath,
        [
          "-e",
          "setInterval(() => {}, 1000)",
          "--",
          `--user-data-dir=${profile}`,
        ],
        { detached: true, stdio: "ignore", windowsHide: true },
      );
    const escaped = launch(join(data, "electron-profile"));
    const unrelated = launch(`${data} other`);
    const escapedExit = once(escaped, "exit");
    const unrelatedExit = once(unrelated, "exit");
    const desktop = observeSmokeProcess(
      () =>
        spawn(
          process.execPath,
          ["-e", "process.once('message', () => process.exit(0))"],
          {
            stdio: ["ignore", "ignore", "ignore", "ipc"],
            windowsHide: true,
          },
        ),
      data,
    );
    try {
      expect(desktop.contained).toBe(true);
      desktop.child.send("quit");
      expect(await desktop.outcome).toEqual({ code: 0, launchFailed: false });
      expect(desktop.jobProcessIds()).not.toContain(escaped.pid);
      const processes = windowsProcesses(data);
      const escapedIdentity = processes.find(({ pid }) => pid === escaped.pid)!;
      const otherIdentity = processes.find(({ pid }) => pid === unrelated.pid)!;
      expect(escapedIdentity.matchesProfile).toBe(true);
      expect(otherIdentity.matchesProfile).toBe(false);
      expect(
        terminateSmokeProcess(
          { ...escapedIdentity, creationTime: "old" },
          data,
        ),
      ).toBe(false);
      expect(
        terminateSmokeProcess({ ...otherIdentity, matchesProfile: true }, data),
      ).toBe(false);
      expect(escaped.exitCode).toBeNull();
      expect(unrelated.exitCode).toBeNull();

      const shutdown = { failedAt: null, residualProcesses: null };
      await checkSmokeShutdown(shutdown, desktop);
      expect(shutdown).toEqual({
        failedAt: "residual-processes",
        residualProcesses: { ...noResiduals, other: 1 },
      });
      expect(await escapedExit).toEqual([1, null]);
      expect(unrelated.exitCode).toBeNull();
      expect(unrelated.signalCode).toBeNull();
    } finally {
      desktop.close();
      desktop.child.kill();
      escaped.kill();
      unrelated.kill();
      await Promise.all([desktop.outcome, escapedExit, unrelatedExit]);
    }
  },
  25_000,
);

describe("startup conclusion", () => {
  it("accepts exactly one writer record and keeps its bounded outcome", () => {
    expect(readStartupConclusion(record({ status: "ready" }) + "\n")).toEqual({
      state: "ready",
      startupStatus: "ready",
      exitCode: null,
      signal: null,
      candidates: 1,
    });
    expect(readStartupConclusion(record(exitedResult(0, null)) + "\n")).toEqual(
      {
        state: "not-ready",
        startupStatus: "exited",
        exitCode: 0,
        signal: null,
        candidates: 1,
      },
    );
    expect(
      readStartupConclusion(record(exitedResult(0xc0000005, null)) + "\n"),
    ).toEqual({
      state: "not-ready",
      startupStatus: "exited",
      exitCode: 3221225477,
      signal: null,
      candidates: 1,
    });
    expect(
      readStartupConclusion(record(exitedResult(null, "SIGTERM")) + "\n"),
    ).toEqual({
      state: "not-ready",
      startupStatus: "exited",
      exitCode: null,
      signal: "SIGTERM",
      candidates: 1,
    });
    for (const outcome of [
      { status: "timeout" },
      spawnErrorResult(new Error("spawn EACCES C:\\secret\\node.exe")),
      { status: "cancelled" },
      { status: "host-error" },
    ] satisfies DesktopStartupOutcome[])
      expect(readStartupConclusion(record(outcome) + "\n")).toEqual({
        state: "not-ready",
        startupStatus: outcome.status,
        exitCode: null,
        signal: null,
        candidates: 1,
      });
  });

  it("reads LF and CRLF records after unbounded stderr text", () => {
    const ready = record({ status: "ready" });
    for (const text of [
      `${ready}\n`,
      `${ready}\r\n`,
      `partial stderr\n${ready}\n`,
      `partial stderr\r\n${ready}\r\n`,
    ])
      expect(readStartupConclusion(text)).toEqual({
        state: "ready",
        startupStatus: "ready",
        exitCode: null,
        signal: null,
        candidates: 1,
      });
  });

  it("treats an absent, unreadable or unrelated log as missing", () => {
    for (const text of [
      null,
      undefined,
      "",
      "warn\nready\n",
      "partial [desktop-startup] 2026-11-19T01:02:03.456Z ready\n",
    ])
      expect(readStartupConclusion(text)).toEqual({
        state: "missing",
        startupStatus: null,
        exitCode: null,
        signal: null,
        candidates: 0,
      });
  });

  it("rejects a single record that is not canonical or carries extra fields", () => {
    for (const text of [
      "[desktop-startup]\n",
      "[desktop-startup] 2026-11-19T01:02:03Z ready",
      "[desktop-startup] 2026-11-19t01:02:03.456z ready",
      "[desktop-startup] 2026-02-30T01:02:03.456Z ready",
      "[desktop-startup] 2026-11-19T01:02:03.456Z READY",
      "[desktop-startup] 2026-11-19T01:02:03.456Z ready extra",
      "[desktop-startup] 2026-11-19T01:02:03.456Z exited code=0 extra=1",
      "[desktop-startup] 2026-11-19T01:02:03.456Z exited code=-1",
      "[desktop-startup] 2026-11-19T01:02:03.456Z exited code=4294967296",
      "[desktop-startup] 2026-11-19T01:02:03.456Z exited code=007",
      "[desktop-startup] 2026-11-19T01:02:03.456Z exited code=",
      "[desktop-startup] 2026-11-19T01:02:03.456Z exited signal=SIGBOGUS",
      "[desktop-startup] 2026-11-19T01:02:03.456Z exited signal=SIGTERM code=0",
      "[desktop-startup] 2026-11-19T01:02:03.456Z exited code=0 code=1",
    ])
      expect(readStartupConclusion(text)).toEqual({
        state: "malformed",
        startupStatus: null,
        exitCode: null,
        signal: null,
        candidates: 1,
      });
  });

  it("calls more than one prefix candidate ambiguous even beside a valid record", () => {
    const ready = record({ status: "ready" });
    const ambiguous = {
      state: "ambiguous",
      startupStatus: null,
      exitCode: null,
      signal: null,
      candidates: 2,
    };
    expect(readStartupConclusion(`${ready}\n${ready}\n`)).toEqual(ambiguous);
    expect(
      readStartupConclusion(
        `[desktop-startup] broken\n${record(exitedResult(0, null))}\n`,
      ),
    ).toEqual(ambiguous);
    expect(
      readStartupConclusion(`${ready}\r\n${record(exitedResult(1, null))}\r\n`),
    ).toEqual(ambiguous);
  });
});

describe("smoke pass gate", () => {
  const allGood = {
    mode: "default" as const,
    sourceChecked: true,
    sourceUnchanged: true,
    exitCode: 0,
    launchFailed: false,
    timedOut: false,
    smokeOutputPresent: true,
    missingLabels: [],
    presentErrors: [],
    startupState: "ready" as const,
  };
  const startupOnlyGood = {
    ...allGood,
    mode: "startup-only" as const,
    sourceChecked: false,
    sourceUnchanged: null,
  };

  it("passes only a clean process, unchanged source and a ready record", () => {
    expect(smokePassed(allGood)).toBe(true);
    expect(smokePassed({ ...allGood, exitCode: 1 })).toBe(false);
    expect(smokePassed({ ...allGood, exitCode: null })).toBe(false);
    expect(smokePassed({ ...allGood, launchFailed: true })).toBe(false);
    expect(smokePassed({ ...allGood, timedOut: true })).toBe(false);
    expect(smokePassed({ ...allGood, sourceUnchanged: false })).toBe(false);
    expect(smokePassed({ ...allGood, smokeOutputPresent: false })).toBe(false);
    expect(smokePassed({ ...allGood, missingLabels: ["今日"] })).toBe(false);
    expect(smokePassed({ ...allGood, presentErrors: ["Forbidden"] })).toBe(
      false,
    );
    for (const startupState of [
      "not-ready",
      "missing",
      "malformed",
      "ambiguous",
    ] as const)
      expect(smokePassed({ ...allGood, startupState })).toBe(false);
  });

  it("requires a real source check only in the default mode", () => {
    expect(smokePassed(startupOnlyGood)).toBe(true);
    // A startup-only run must never claim a source result, and the default
    // mode must never accept a missing or null source conclusion.
    expect(smokePassed({ ...startupOnlyGood, sourceChecked: true })).toBe(
      false,
    );
    expect(smokePassed({ ...startupOnlyGood, sourceUnchanged: true })).toBe(
      false,
    );
    expect(smokePassed({ ...allGood, sourceChecked: false })).toBe(false);
    expect(smokePassed({ ...allGood, sourceUnchanged: null })).toBe(false);
    expect(smokePassed({ ...allGood, mode: "unknown" as "default" })).toBe(
      false,
    );
  });

  it("applies the process and page gate in both modes", () => {
    for (const base of [allGood, startupOnlyGood]) {
      expect(smokePassed({ ...base, exitCode: 1 })).toBe(false);
      expect(smokePassed({ ...base, exitCode: null })).toBe(false);
      expect(smokePassed({ ...base, launchFailed: true })).toBe(false);
      expect(smokePassed({ ...base, timedOut: true })).toBe(false);
      expect(smokePassed({ ...base, smokeOutputPresent: false })).toBe(false);
      expect(smokePassed({ ...base, missingLabels: ["今日"] })).toBe(false);
      expect(smokePassed({ ...base, presentErrors: ["启动超时"] })).toBe(false);
      for (const startupState of [
        "not-ready",
        "missing",
        "malformed",
        "ambiguous",
      ] as const)
        expect(smokePassed({ ...base, startupState })).toBe(false);
    }
  });

  it("requires a successful process census with zero residuals in both modes", () => {
    for (const base of [allGood, startupOnlyGood]) {
      const clean = { ...base, failedAt: null, residualProcesses: noResiduals };
      expect(defaultSmokePassed(clean)).toBe(true);
      expect(defaultSmokePassed({ ...clean, residualProcesses: null })).toBe(
        false,
      );
      expect(
        defaultSmokePassed({
          ...clean,
          residualProcesses: { ...noResiduals, other: 1 },
        }),
      ).toBe(false);
    }
  });

  it("fails a valid exited or timeout record with the rest all good", () => {
    for (const outcome of [
      exitedResult(0, null),
      exitedResult(0xc0000005, null),
      exitedResult(null, "SIGTERM"),
      { status: "timeout" },
    ] satisfies DesktopStartupOutcome[]) {
      const conclusion = readStartupConclusion(record(outcome) + "\n");
      expect(conclusion.state).toBe("not-ready");
      expect(smokePassed({ ...allGood, startupState: conclusion.state })).toBe(
        false,
      );
    }
  });
});

describe("lifecycle smoke pass gate", () => {
  const passedExit = { failurePageShown: true, restartRecovered: true };
  const clean = {
    exitCode: 0,
    timedOut: false,
    launchFailed: false,
    cleaned: true,
    windowHidden: true,
    trayAlive: true,
    windowRestored: true,
    unexpectedCleanExit: { ...passedExit, code: 0, signal: null },
    unexpectedSignalExit: { ...passedExit, code: null, signal: "SIGTERM" },
    taskRecovered: true,
    gracefulQuit: true,
    residualProcesses: noResiduals,
  };
  it("requires both runtime exits, restarted services, task recovery and a clean quit", () => {
    expect(lifecycleSmokePassed(clean)).toBe(true);
    for (const patch of [
      { exitCode: null },
      { timedOut: true },
      { launchFailed: true },
      { cleaned: false },
      { windowHidden: false },
      { trayAlive: false },
      { windowRestored: false },
      { unexpectedCleanExit: undefined },
      { unexpectedCleanExit: { ...clean.unexpectedCleanExit, code: 1 } },
      {
        unexpectedCleanExit: {
          ...clean.unexpectedCleanExit,
          failurePageShown: false,
        },
      },
      { unexpectedSignalExit: { ...clean.unexpectedSignalExit, signal: null } },
      {
        unexpectedSignalExit: {
          ...clean.unexpectedSignalExit,
          restartRecovered: false,
        },
      },
      { taskRecovered: false },
      { gracefulQuit: false },
      { residualProcesses: null },
    ])
      expect(lifecycleSmokePassed({ ...clean, ...patch })).toBe(false);
    for (const kind of Object.keys(noResiduals))
      expect(
        lifecycleSmokePassed({
          ...clean,
          residualProcesses: { ...noResiduals, [kind]: 1 },
        }),
      ).toBe(false);
  });
});

describe("diagnose smoke pass gate", () => {
  const clean = {
    failedAt: null,
    readOnlyWithoutDatabase: true,
    healthReady: true,
    archiveRead: true,
    jobStatus: "completed",
    boundaryState: "zero-signal",
    schemaVersion: 26,
    czsc: {
      apiVersion: 22,
      dllHash: "ab".repeat(32),
      bundledHashMatches: true,
      workerObserved: true,
    },
    thsdk: {
      enabled: false,
      state: "disabled",
      rejected: true,
      workerCount: 0,
      sessionCreated: false,
    },
    gracefulShutdown: true,
    residualProcesses: noResiduals,
    cleaned: true,
  };

  it("requires SQLite schema v26", () => {
    expect(diagnoseSmokePassed(clean)).toBe(true);
    for (const schemaVersion of [null, 24, 25, 27]) {
      expect(diagnoseSmokePassed({ ...clean, schemaVersion })).toBe(false);
    }
  });

  it("requires the packaged CZSC version, file hash, observed worker and verified teardown", () => {
    expect(diagnoseSmokePassed(clean)).toBe(true);
    for (const czsc of [
      null,
      { ...clean.czsc, apiVersion: 21 },
      { ...clean.czsc, dllHash: "g".repeat(64) },
      { ...clean.czsc, dllHash: clean.czsc.dllHash + "\n" },
      { ...clean.czsc, bundledHashMatches: false },
      { ...clean.czsc, workerObserved: false },
    ])
      expect(diagnoseSmokePassed({ ...clean, czsc })).toBe(false);
    expect(
      diagnoseSmokePassed({
        ...clean,
        residualProcesses: { ...noResiduals, czscWorker: 1 },
      }),
    ).toBe(false);
    expect(diagnoseSmokePassed({ ...clean, residualProcesses: null })).toBe(
      false,
    );
  });

  it("requires a real default-disabled THSDK response and zero workers", () => {
    for (const thsdk of [
      null,
      { ...clean.thsdk, enabled: true },
      { ...clean.thsdk, state: "unconfigured" },
      { ...clean.thsdk, rejected: false },
      { ...clean.thsdk, workerCount: 1 },
      { ...clean.thsdk, sessionCreated: true },
    ])
      expect(diagnoseSmokePassed({ ...clean, thsdk })).toBe(false);
    const rejection = {
      status: 500,
      code: "INTERNAL_SERVER_ERROR",
      message: "同花顺数据源未启用",
    };
    expect(isThsdkDisabledRejection(rejection)).toBe(true);
    expect(isThsdkDisabledRejection({ ...rejection, status: 403 })).toBe(false);
    expect(
      isThsdkDisabledRejection({ ...rejection, code: "BAD_REQUEST" }),
    ).toBe(false);
    expect(
      isThsdkDisabledRejection({
        ...rejection,
        message: "请先配置同花顺数据源",
      }),
    ).toBe(false);
  });
});
