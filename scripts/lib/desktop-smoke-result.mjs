import { constants as osConstants } from "node:os";

/**
 * The desktop smoke result is decided from the one startup record the shell
 * appends to this run's server.log. Only the fixed prefix, a canonical UTC
 * timestamp, a known status and, for an exit, a bounded DWORD code or a known
 * signal are accepted. Nothing else in the log is read or echoed.
 */

export const STARTUP_RECORD_PREFIX = "[desktop-startup]";

const startupStatuses = new Set([
  "ready",
  "timeout",
  "exited",
  "spawn-error",
  "cancelled",
  "host-error",
]);

const knownSignals = new Set(Object.keys(osConstants.signals));
const canonicalIso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const canonicalExitCode = /^(0|[1-9]\d*)$/;
const maxExitCode = 0xffffffff;

/**
 * @typedef {"ready" | "not-ready" | "missing" | "malformed" | "ambiguous"} DesktopSmokeStartupState
 * @typedef {{
 *   state: DesktopSmokeStartupState,
 *   startupStatus: string | null,
 *   exitCode: number | null,
 *   signal: string | null,
 *   candidates: number,
 * }} DesktopSmokeStartupConclusion
 */

/** @param {string} value */
function isCanonicalIso(value) {
  if (!canonicalIso.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

/**
 * Parse exactly one writer record. The writer joins fields with single spaces
 * and emits the exit code before the signal, both optional.
 * @param {string} line
 * @returns {{status: string, code: number | null, signal: string | null} | null}
 */
function parseCandidate(line) {
  if (!line.startsWith(`${STARTUP_RECORD_PREFIX} `)) return null;
  const parts = line.split(" ");
  const prefix = parts[0];
  const at = parts[1];
  const status = parts[2];
  if (prefix !== STARTUP_RECORD_PREFIX) return null;
  if (at === undefined || status === undefined) return null;
  if (!isCanonicalIso(at)) return null;
  if (!startupStatuses.has(status)) return null;
  const fields = parts.slice(3);
  if (status !== "exited")
    return fields.length === 0 ? { status, code: null, signal: null } : null;

  /** @type {{status: string, code: number | null, signal: string | null}} */
  const parsed = { status, code: null, signal: null };
  let index = 0;
  const codeField = fields[index];
  if (codeField?.startsWith("code=")) {
    const raw = codeField.slice("code=".length);
    if (!canonicalExitCode.test(raw)) return null;
    const code = Number(raw);
    if (!Number.isInteger(code) || code > maxExitCode) return null;
    parsed.code = code;
    index += 1;
  }
  const signalField = fields[index];
  if (signalField?.startsWith("signal=")) {
    const signal = signalField.slice("signal=".length);
    if (!knownSignals.has(signal)) return null;
    parsed.signal = signal;
    index += 1;
  }
  return index === fields.length ? parsed : null;
}

/**
 * A missing file and an empty log are both missing. Any line that starts with
 * the fixed prefix is a candidate, so one bad record beside a good one is
 * ambiguous rather than a lucky success.
 * @param {string | null | undefined} text
 * @returns {DesktopSmokeStartupConclusion}
 */
export function readStartupConclusion(text) {
  const candidates =
    typeof text === "string"
      ? text
          .split(/\r?\n/)
          .filter((line) => line.startsWith(STARTUP_RECORD_PREFIX))
      : [];
  if (candidates.length === 0)
    return {
      state: "missing",
      startupStatus: null,
      exitCode: null,
      signal: null,
      candidates: 0,
    };
  if (candidates.length > 1)
    return {
      state: "ambiguous",
      startupStatus: null,
      exitCode: null,
      signal: null,
      candidates: candidates.length,
    };
  const parsed = parseCandidate(candidates[0] ?? "");
  if (parsed === null)
    return {
      state: "malformed",
      startupStatus: null,
      exitCode: null,
      signal: null,
      candidates: 1,
    };
  return {
    state: parsed.status === "ready" ? "ready" : "not-ready",
    startupStatus: parsed.status,
    exitCode: parsed.code,
    signal: parsed.signal,
    candidates: 1,
  };
}

/**
 * The mode decides how the source evidence is judged. The default mode must
 * prove the real source was checked and stayed identical; startup-only never
 * reads a real source, so it must report no check at all rather than reuse a
 * manufactured market result. Every other condition is mandatory in both
 * modes: a clean exit code cannot rescue a missing, malformed, ambiguous or
 * non-ready startup record, and a ready record cannot rescue a launch error,
 * timeout, signal exit or missing page.
 * @param {{
 *   mode: "default" | "startup-only",
 *   sourceChecked: boolean,
 *   sourceUnchanged: boolean | null,
 *   exitCode: number | null,
 *   launchFailed: boolean,
 *   timedOut: boolean,
 *   smokeOutputPresent: boolean,
 *   missingLabels: readonly string[],
 *   presentErrors: readonly string[],
 *   startupState: DesktopSmokeStartupState,
 * }} result
 */
export function smokePassed({
  mode,
  sourceChecked,
  sourceUnchanged,
  exitCode,
  launchFailed,
  timedOut,
  smokeOutputPresent,
  missingLabels,
  presentErrors,
  startupState,
}) {
  const sourceGate =
    mode === "startup-only"
      ? sourceChecked === false && sourceUnchanged === null
      : mode === "default"
        ? sourceChecked === true && sourceUnchanged === true
        : false;
  return (
    sourceGate &&
    !launchFailed &&
    !timedOut &&
    exitCode === 0 &&
    smokeOutputPresent &&
    missingLabels.length === 0 &&
    presentErrors.length === 0 &&
    startupState === "ready"
  );
}

/** @typedef {{ backend: number, worker: number, czscWorker: number, thsdkWorker: number, other: number }} ResidualProcesses */
/** @typedef {{ code: number | null, signal: string | null, failurePageShown: boolean, restartRecovered: boolean }} LifecycleExit */

/** @param {ResidualProcesses | null | undefined} counts */
export function noResidualProcesses(counts) {
  return (
    counts != null &&
    counts.backend === 0 &&
    counts.worker === 0 &&
    counts.czscWorker === 0 &&
    counts.thsdkWorker === 0 &&
    counts.other === 0
  );
}

/** @param {{
 *   exitCode: number | null,
 *   timedOut: boolean,
 *   launchFailed: boolean,
 *   cleaned: boolean,
 *   windowHidden?: boolean,
 *   trayAlive?: boolean,
 *   windowRestored?: boolean,
 *   unexpectedCleanExit?: LifecycleExit,
 *   unexpectedSignalExit?: LifecycleExit,
 *   taskRecovered: boolean,
 *   gracefulQuit?: boolean,
 *   residualProcesses: ResidualProcesses | null,
 * }} result */
export function lifecycleSmokePassed(result) {
  const clean = result.unexpectedCleanExit;
  const killed = result.unexpectedSignalExit;
  return (
    result.exitCode === 0 &&
    result.timedOut === false &&
    result.launchFailed === false &&
    result.cleaned === true &&
    result.windowHidden === true &&
    result.trayAlive === true &&
    result.windowRestored === true &&
    clean?.code === 0 &&
    clean.signal === null &&
    clean.failurePageShown === true &&
    clean.restartRecovered === true &&
    killed?.code === null &&
    killed.signal === "SIGTERM" &&
    killed.failurePageShown === true &&
    killed.restartRecovered === true &&
    result.taskRecovered === true &&
    result.gracefulQuit === true &&
    noResidualProcesses(result.residualProcesses)
  );
}

/** @param {{
 *   status: number,
 *   code: string | undefined,
 *   message: string | undefined,
 * }} error */
export function isThsdkDisabledRejection(error) {
  return (
    error.status === 500 &&
    error.code === "INTERNAL_SERVER_ERROR" &&
    error.message === "同花顺数据源未启用"
  );
}

/** @param {{
 *   failedAt: string | null,
 *   readOnlyWithoutDatabase: boolean,
 *   healthReady: boolean,
 *   archiveRead: boolean,
 *   jobStatus: string | null,
 *   boundaryState: string | null,
 *   schemaVersion: number | null,
 *   czsc: { apiVersion: number, dllHash: string, bundledHashMatches: boolean, workerObserved: boolean } | null,
 *   thsdk: { enabled: boolean, state: string, rejected: boolean, workerCount: number, sessionCreated: boolean } | null,
 *   gracefulShutdown: boolean,
 *   residualProcesses: ResidualProcesses | null,
 *   cleaned: boolean,
 * }} result */
export function diagnoseSmokePassed(result) {
  const { czsc, thsdk } = result;
  return (
    result.failedAt === null &&
    result.readOnlyWithoutDatabase === true &&
    result.healthReady === true &&
    result.archiveRead === true &&
    result.jobStatus === "completed" &&
    result.boundaryState === "zero-signal" &&
    result.schemaVersion === 24 &&
    czsc?.apiVersion === 22 &&
    typeof czsc.dllHash === "string" &&
    czsc.dllHash.length === 64 &&
    /^[0-9a-f]{64}$/i.test(czsc.dllHash) &&
    czsc.bundledHashMatches === true &&
    czsc.workerObserved === true &&
    thsdk?.enabled === false &&
    thsdk.state === "disabled" &&
    thsdk.rejected === true &&
    thsdk.workerCount === 0 &&
    thsdk.sessionCreated === false &&
    result.gracefulShutdown === true &&
    result.cleaned === true &&
    noResidualProcesses(result.residualProcesses)
  );
}
