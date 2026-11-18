import { describe, expect, it } from "vitest";
import { exitedResult, spawnErrorResult } from "../../electron/startup-health";
import {
  desktopStartupLine,
  type DesktopStartupOutcome,
} from "../../electron/startup-log";
import {
  readStartupConclusion,
  smokePassed,
} from "../../scripts/lib/desktop-smoke-result.mjs";

const at = new Date("2026-11-19T01:02:03.456Z");
const record = (outcome: DesktopStartupOutcome) =>
  desktopStartupLine(outcome, at);

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
