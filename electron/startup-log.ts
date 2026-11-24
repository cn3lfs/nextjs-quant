/**
 * One startup conclusion per launch attempt, appended to the same server.log
 * the tray already opens.
 *
 * The record exists so a human can tell how the last launch ended. It carries
 * only the fixed prefix, a UTC ISO timestamp, the status and, for an exit,
 * a bounded integer code or a known signal name. Process errors, paths,
 * tokens, environment values and response bodies never reach it.
 */

import { appendFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import type { StartupHealthResult } from "./startup-health";

export type DesktopStartupOutcome =
  StartupHealthResult | { status: "host-error" };

export const DESKTOP_STARTUP_PREFIX = "[desktop-startup]";

// Windows reports exit codes and STATUS_* values as an unsigned DWORD.
const MAX_EXIT_CODE = 0xffffffff;
const knownSignals = new Set(Object.keys(osConstants.signals));

export function desktopStartupLine(
  outcome: DesktopStartupOutcome,
  at: Date = new Date(),
): string {
  const fields = [DESKTOP_STARTUP_PREFIX, at.toISOString(), outcome.status];
  if (
    outcome.status === "exited" &&
    typeof outcome.code === "number" &&
    Number.isInteger(outcome.code) &&
    outcome.code >= 0 &&
    outcome.code <= MAX_EXIT_CODE
  )
    fields.push(`code=${outcome.code}`);
  if (
    outcome.status === "exited" &&
    outcome.signal !== null &&
    knownSignals.has(outcome.signal)
  )
    fields.push(`signal=${outcome.signal}`);
  return fields.join(" ");
}

export function recordUnexpectedServiceExit(
  file: string,
  code: number | null,
  signal: NodeJS.Signals | null,
) {
  const line = desktopStartupLine({ status: "exited", code, signal }).replace(
    DESKTOP_STARTUP_PREFIX,
    "[desktop-service-exit]",
  );
  safeAppend(file, "\n" + line + "\n");
}

/** Log writes are diagnostics: a failed append never interrupts startup or teardown. */
export function safeAppend(file: string, text: string): void {
  try {
    appendFileSync(file, text);
  } catch {}
}

export interface DesktopStartupRecorder {
  /** The first confirmed outcome wins; later calls are ignored. */
  record(outcome: DesktopStartupOutcome): void;
}

export function createDesktopStartupRecorder(
  file: string,
  now: () => Date = () => new Date(),
): DesktopStartupRecorder {
  let recorded = false;
  return {
    record(outcome) {
      if (recorded) return;
      recorded = true;
      // The leading newline keeps the record off a stderr line that did not
      // end with one.
      safeAppend(file, "\n" + desktopStartupLine(outcome, now()) + "\n");
    },
  };
}
