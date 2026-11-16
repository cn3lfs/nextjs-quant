"use strict";

// Run with <server-dir>/node-runtime/node.exe. Reads only; never loads app DB code.
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { createHash } = require("node:crypto");
const DAY = 86400000;
const candidates = [
  ["r2a-cn-equity-formula-range-trailing", "cn-equity"],
  ["r2a-cn-equity-double-breakout-time-neighbor-90", "cn-equity"],
  ["r2a-cn-equity-historical-low-trailing-neighbor-110", "cn-equity"],
  ["r2a-crypto-dual-ma-day-trailing-sizing-equal", "crypto"],
  ["r2a-crypto-dual-ma-day-trailing-sizing-volatility", "crypto"],
];
const sha = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const hash = (value) => sha(JSON.stringify(canonical(value)));
const beijing = (time) => new Date(time + 8 * 3600000).toISOString();
const dateValid = (value) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  new Date(Date.parse(value)).toISOString().slice(0, 10) === value;
const safeCode = (error) =>
  /^[A-Z][A-Z0-9_]{0,40}$/.test(error?.code ?? "")
    ? error.code
    : "OBSERVER_FAILED";
const contains = (parent, child) => {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

function argumentsOf() {
  const options = {};
  const allowed = new Set([
    "data-dir",
    "output-dir",
    "server-dir",
    "not-before-date",
    "start-at",
  ]);
  for (let i = 2; i < process.argv.length; i++) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(process.argv[i]);
    if (!match || !allowed.has(match[1]) || Object.hasOwn(options, match[1]))
      throw new Error("Invalid observer arguments");
    const value = match[2] ?? process.argv[++i];
    if (!value || value.startsWith("--"))
      throw new Error("Missing observer argument");
    options[match[1]] = value;
  }
  for (const key of ["data-dir", "output-dir", "server-dir"])
    if (
      !options[key] ||
      !path.isAbsolute(options[key]) ||
      !/^[A-Za-z]:[\\/]/.test(options[key])
    )
      throw new Error("Explicit absolute local directories required");
  const data = fs.realpathSync(options["data-dir"]);
  const server = fs.realpathSync(options["server-dir"]);
  const output = path.resolve(options["output-dir"]);
  // Refuse linked output ancestors and paths overlapping either read-only input.
  for (let current = output; ; current = path.dirname(current)) {
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error("Linked output refused");
    if (current === path.dirname(current)) break;
  }
  if (
    [data, server].some(
      (input) => contains(input, output) || contains(output, input),
    )
  )
    throw new Error("Independent output directory required");
  if (
    fs.realpathSync(process.execPath).toLowerCase() !==
    fs.realpathSync(path.join(server, "node-runtime", "node.exe")).toLowerCase()
  )
    throw new Error("Use the formal bundled Node runtime");
  let notBefore = options["not-before-date"] ?? "2026-11-17";
  if (!dateValid(notBefore)) throw new Error("Invalid not-before date");
  const startAt = options["start-at"] ? Date.parse(options["start-at"]) : null;
  if (options["start-at"]) {
    if (
      !/(?:Z|[+-]\d{2}:\d{2})$/.test(options["start-at"]) ||
      !Number.isFinite(startAt)
    )
      throw new Error("Explicit timestamp timezone required");
    const startDay = beijing(startAt).slice(0, 10);
    const midnight = Date.parse(`${startDay}T00:00:00+08:00`);
    const fullDay = beijing(midnight + (startAt === midnight ? 0 : DAY)).slice(
      0,
      10,
    );
    if (fullDay > notBefore) notBefore = fullDay;
  }
  return { data, server, output, notBefore, startAt };
}

function sourceDate(tdxRoot) {
  if (
    typeof tdxRoot !== "string" ||
    !path.isAbsolute(tdxRoot) ||
    !/^[A-Za-z]:[\\/]/.test(tdxRoot)
  )
    return { available: false, reason: "local-tdx-root-unavailable" };
  const file = path.join(tdxRoot, "vipdoc", "sh", "lday", "sh000906.day");
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const before = fs.fstatSync(fd),
      bytes = Buffer.alloc(32);
    if (
      before.size < 32 ||
      before.size % 32 !== 0 ||
      fs.readSync(fd, bytes, 0, 32, before.size - 32) !== 32
    )
      throw new Error("Invalid day file");
    const packed = String(bytes.readUInt32LE(0));
    const date = `${packed.slice(0, 4)}-${packed.slice(4, 6)}-${packed.slice(6, 8)}`;
    const after = fs.fstatSync(fd);
    if (
      !dateValid(date) ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    )
      throw new Error("Changing day file");
    return { available: true, symbol: "sh000906", path: file, lastDate: date };
  } catch (error) {
    return { available: false, symbol: "sh000906", code: safeCode(error) };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function receiptOf(data, date, now, closeAt) {
  try {
    const bytes = fs.readFileSync(
      path.join(data, `download-${date}-close.json`),
    );
    const receipt = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
    return {
      available: true,
      hash: sha(bytes),
      completedAt: receipt.completedAt,
      valid:
        receipt.date === date &&
        receipt.phase === "close" &&
        receipt.exitCode === 0 &&
        Number.isSafeInteger(receipt.completedAt) &&
        receipt.completedAt >= closeAt &&
        receipt.completedAt <= now &&
        beijing(receipt.completedAt).slice(0, 10) === date,
    };
  } catch (error) {
    return { available: false, valid: false, code: safeCode(error) };
  }
}

function currentRpsMetadata(db, root, now) {
  // Mirror market-pool-service's selection, not merely rpsStatus's strict-day
  // cache. Workflow observations with reused members need not enter rps_days.
  const stored =
    db
      .prepare(
        "SELECT date tableDate,json_extract(payload,'$.date') date,json_extract(payload,'$.createdAt') createdAt,json_extract(payload,'$.source.root') root,json_extract(payload,'$.inputHash') inputHash FROM rps_days ORDER BY date DESC LIMIT 1",
      )
      .get() ?? null;
  let observation = null;
  if (typeof root === "string" && path.isAbsolute(root)) {
    const rows = db
      .prepare(
        "SELECT id,json_extract(payload,'$.root') root,json_extract(payload,'$.date') date,json_extract(payload,'$.phase') phase,json_extract(payload,'$.createdAt') createdAt,json_extract(payload,'$.day.date') dayDate,json_extract(payload,'$.day.source.root') dayRoot,json_extract(payload,'$.day.inputHash') inputHash FROM records WHERE kind='rps-observation' AND json_extract(payload,'$.createdAt')<=? ORDER BY updated_at DESC,id DESC",
      )
      .iterate(now);
    for (const row of rows) {
      if (
        typeof row.root === "string" &&
        path.resolve(row.root) === path.resolve(root)
      ) {
        observation = row;
        break;
      }
    }
  }
  const preferObservation =
    observation &&
    (!stored ||
      observation.date > stored.date ||
      (observation.date === stored.date &&
        observation.createdAt > stored.createdAt));
  const selected = preferObservation
    ? { ...observation, source: "rps-observation" }
    : stored
      ? { ...stored, source: "rps_days", phase: "strict-day-history" }
      : null;
  const selectedRoot = preferObservation ? selected.dayRoot : selected?.root;
  return {
    historical: stored,
    observation,
    selected,
    rootMatches:
      typeof root === "string" &&
      typeof selectedRoot === "string" &&
      path.resolve(selectedRoot) === path.resolve(root),
    selection:
      "Current market-pool-service: matching-root latest observation wins if newer by date/createdAt; otherwise strict daily history. A noon/late estimate does not certify a complete close observation.",
  };
}

function businessSnapshot(Database, data, now) {
  const db = new Database(path.join(data, "quant.sqlite"), {
    readonly: true,
    fileMustExist: true,
    timeout: 1000,
  });
  try {
    db.pragma("query_only = ON");
    return db.transaction(() => {
      const settings = db
        .prepare(
          "SELECT json_extract(payload,'$.tdxRoot') tdxRoot,json_extract(payload,'$.alerts.mode') mode FROM records WHERE id='settings'",
        )
        .get();
      const runtime =
        db
          .prepare(
            "SELECT json_extract(payload,'$.lastCheck') lastCheck,json_extract(payload,'$.mode') mode,json_extract(payload,'$.error') IS NOT NULL hasError FROM records WHERE id='alerts:runtime'",
          )
          .get() ?? null;
      const accounts = candidates.map(([strategyId, market]) => {
        const id = `paper:${strategyId}:v1`;
        const row = db
          .prepare(
            "SELECT json_extract(payload,'$.initial') initial,json_extract(payload,'$.startedAt') startedAt,json_extract(payload,'$.lastBar') lastBar,json_extract(payload,'$.lastRun') lastRun,json_extract(payload,'$.error') error,json_extract(payload,'$.mirror.venue') mirror,json_extract(payload,'$.candidates') candidates FROM paper_accounts WHERE id=? AND market=?",
          )
          .get(id, market);
        if (!row) return { id, strategyId, market, available: false };
        const contract = JSON.parse(row.candidates);
        const shadow = db
          .prepare(
            "SELECT json_extract(payload,'$.active') active FROM records WHERE id=?",
          )
          .get(`alerts:shadow:${strategyId}:1`);
        return {
          id,
          strategyId,
          market,
          available: true,
          lastBar: row.lastBar,
          lastRun: row.lastRun,
          error: row.error == null ? null : "present-redacted",
          errorHash: row.error == null ? null : sha(String(row.error)),
          contractHash: hash({
            initial: row.initial,
            startedAt: row.startedAt,
            candidates: contract,
          }),
          contractMatches:
            Number.isFinite(row.initial) &&
            row.initial > 0 &&
            Number.isSafeInteger(row.startedAt) &&
            row.startedAt > 0 &&
            Array.isArray(contract) &&
            contract.length === 1 &&
            contract[0]?.strategy?.id === strategyId &&
            contract[0]?.strategy?.version === 1 &&
            contract[0]?.strategy?.market === market &&
            contract[0]?.strategy?.period === "day",
          mirror: row.mirror,
          shadowActive: shadow?.active === 1,
        };
      });
      const scans = db
        .prepare(
          "SELECT json_extract(payload,'$.market') market,json_extract(payload,'$.strategyId') strategyId,json_extract(payload,'$.version') version,json_extract(payload,'$.period') period,json_extract(payload,'$.bar') bar,json_extract(payload,'$.observedAt') observedAt FROM records WHERE kind='alert-state' AND id LIKE 'alerts:candidate-scan:cn-equity:%' ORDER BY id",
        )
        .all();
      return {
        settings,
        runtime,
        accounts,
        scans,
        rps: currentRpsMetadata(db, settings?.tdxRoot, now),
        paperAccountCount: db
          .prepare("SELECT count(*) count FROM paper_accounts")
          .get().count,
        subscriptions: db
          .prepare(
            "SELECT count(*) total,coalesce(sum(json_extract(payload,'$.enabled')=1),0) enabled FROM records WHERE kind='alert-subscription'",
          )
          .get(),
      };
    })();
  } finally {
    db.close();
  }
}

function diagnosticsOf(Database, data, since, now) {
  const file = path.join(data, "logs", "runtime-errors.sqlite");
  if (!fs.existsSync(file))
    return { available: true, exists: false, since, entries: [], blockers: 0 };
  let db;
  try {
    db = new Database(file, {
      readonly: true,
      fileMustExist: true,
      timeout: 1000,
    });
    db.pragma("query_only = ON");
    if (db.pragma("user_version", { simple: true }) !== 1)
      throw new Error("Unknown diagnostics schema");
    const entries = db
      .prepare(
        "SELECT code,event,lastSeen,count FROM errors ORDER BY lastSeen DESC",
      )
      .all();
    for (const row of entries)
      if (
        !/^[A-Z][A-Z0-9_]{0,40}$/.test(row.code) ||
        !/^[a-z][a-z-]{0,40}$/.test(row.event) ||
        !Number.isSafeInteger(row.lastSeen) ||
        row.lastSeen > now ||
        !Number.isSafeInteger(row.count) ||
        row.count < 1
      )
        throw new Error("Invalid diagnostics row");
    const knownCodes = new Set([
      "EACCES",
      "EPERM",
      "ENOENT",
      "ENOSPC",
      "ETIMEDOUT",
      "ECONNREFUSED",
      "ECONNRESET",
      "SQLITE_BUSY",
      "SQLITE_LOCKED",
      "SQLITE_FULL",
      "SQLITE_CORRUPT",
      "SQLITE_NOTADB",
      "SQLITE_CONSTRAINT",
    ]);
    return {
      available: true,
      exists: true,
      since,
      entries,
      blockers: entries.filter(
        (row) => row.lastSeen >= since && !knownCodes.has(row.code),
      ).length,
    };
  } catch (error) {
    return {
      available: false,
      exists: true,
      since,
      entries: [],
      blockers: null,
      code: safeCode(error),
    };
  } finally {
    db?.close();
  }
}

function main() {
  const options = argumentsOf(),
    now = Date.now(),
    date = beijing(now).slice(0, 10);
  const scopeHash = hash(options),
    dailyDir = path.join(options.output, "daily");
  const history = fs.existsSync(dailyDir)
    ? fs
        .readdirSync(dailyDir)
        .filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file))
        .sort()
        .map((file) => {
          const snapshot = JSON.parse(
            fs.readFileSync(path.join(dailyDir, file), "utf8"),
          );
          if (
            snapshot.version !== "lifecycle-day-observation-1" ||
            snapshot.scopeHash !== scopeHash ||
            !snapshot.qualified ||
            snapshot.date !== file.slice(0, 10) ||
            snapshot.date < options.notBefore ||
            snapshot.date > date
          )
            throw new Error("Existing observation scope differs");
          return snapshot;
        })
    : [];
  if (history.length > 3) throw new Error("Observation limit exceeded");
  if (history.length === 3) {
    process.stdout.write(
      JSON.stringify({
        status: "done",
        qualifiedDays: history.map((day) => day.date),
      }) + "\n",
    );
    return;
  }
  const start = Date.parse(`${date}T00:00:00+08:00`),
    closeAt = start + 15 * 3600000;
  const cryptoBar = new Date(Math.floor(now / DAY) * DAY - DAY)
    .toISOString()
    .slice(0, 10);
  const Database = createRequire(path.join(options.server, "package.json"))(
    "better-sqlite3",
  );
  const snapshot = {
    version: "lifecycle-day-observation-1",
    scopeHash,
    observedAt: now,
    beijingTime: beijing(now).replace("Z", "+08:00"),
    date,
    notBeforeDate: options.notBefore,
    deploymentStartAt: options.startAt,
    dataDirectory: options.data,
    serverDirectory: options.server,
    requiredCryptoBar: cryptoBar,
    diagnosticScope:
      "Recorded structured diagnostics with lastSeen since this Beijing day00:00; historical entries are retained but do not invalidate later days. Missing diagnostics file means no persisted entries, not proof against unrecorded process errors.",
    qualified: false,
    reasons: [],
    checks: {},
  };
  try {
    const state = businessSnapshot(Database, options.data, now);
    snapshot.source = sourceDate(state.settings?.tdxRoot);
    snapshot.receipt = receiptOf(options.data, date, now, closeAt);
    snapshot.rps = state.rps;
    snapshot.rpsMaxDate = state.rps.selected?.date ?? null;
    snapshot.paperAccountCount = state.paperAccountCount;
    snapshot.accounts = state.accounts;
    snapshot.scans = state.scans;
    snapshot.runtime = state.runtime;
    snapshot.configuredMode = state.settings?.mode ?? null;
    // alertsSchema.mode defaults to shadow when absent in persisted settings.
    snapshot.effectiveMode = state.settings?.mode ?? "shadow";
    snapshot.runtimeAgeMs =
      state.runtime?.lastCheck == null ? null : now - state.runtime.lastCheck;
    snapshot.subscriptions = state.subscriptions;
    snapshot.diagnostics = diagnosticsOf(Database, options.data, start, now);
    const priorContracts = history[0]?.accounts;
    snapshot.checks = {
      "whole-day-start": date >= options.notBefore,
      "after-close": now >= closeAt,
      "today-native-data":
        snapshot.source.available && snapshot.source.lastDate === date,
      "today-close-receipt": snapshot.receipt.valid,
      "today-rps":
        state.rps.rootMatches &&
        state.rps.selected?.date === date &&
        (state.rps.selected.source === "rps-observation"
          ? state.rps.selected.phase === "close" &&
            state.rps.selected.dayDate === date
          : state.rps.selected.tableDate === date) &&
        Number.isSafeInteger(state.rps.selected.createdAt) &&
        state.rps.selected.createdAt >= closeAt &&
        state.rps.selected.createdAt <= now,
      "five-original-paper-accounts":
        state.paperAccountCount === 5 &&
        state.accounts.every(
          (account) => account.available && account.contractMatches,
        ),
      "paper-progress": state.accounts.every(
        (account) =>
          account.lastBar ===
            (account.market === "cn-equity" ? date : cryptoBar) &&
          Number.isSafeInteger(account.lastRun) &&
          account.lastRun >=
            (account.market === "cn-equity"
              ? closeAt
              : Math.floor(now / DAY) * DAY) &&
          account.lastRun <= now,
      ),
      "paper-no-errors": state.accounts.every(
        (account) => account.available && account.error === null,
      ),
      "unchanged-contracts":
        !priorContracts ||
        state.accounts.every(
          (account) =>
            priorContracts.find((prior) => prior.id === account.id)
              ?.contractHash === account.contractHash,
        ),
      "shadow-active-mirrors-off": state.accounts.every(
        (account) => account.shadowActive && account.mirror === "off",
      ),
      "no-enabled-subscriptions": state.subscriptions.enabled === 0,
      "three-today-cn-scans": candidates
        .filter(([, market]) => market === "cn-equity")
        .every(([id]) =>
          state.scans.some(
            (scan) =>
              scan.market === "cn-equity" &&
              scan.strategyId === id &&
              scan.version === 1 &&
              scan.period === "day" &&
              scan.bar === date &&
              Number.isSafeInteger(scan.observedAt) &&
              scan.observedAt >= closeAt &&
              scan.observedAt <= now,
          ),
        ),
      "fresh-shadow-runtime":
        snapshot.effectiveMode === "shadow" &&
        state.runtime?.mode === "shadow" &&
        !state.runtime.hasError &&
        Number.isSafeInteger(state.runtime.lastCheck) &&
        state.runtime.lastCheck >= closeAt &&
        state.runtime.lastCheck <= now &&
        now - state.runtime.lastCheck <= 180000,
      "no-recorded-unknown-errors":
        snapshot.diagnostics.available && snapshot.diagnostics.blockers === 0,
    };
    snapshot.reasons = Object.keys(snapshot.checks).filter(
      (key) => !snapshot.checks[key],
    );
    snapshot.qualified = snapshot.reasons.length === 0;
  } catch (error) {
    snapshot.reasons = ["read-only-snapshot-unavailable"];
    snapshot.observerErrorCode = safeCode(error);
  }
  fs.mkdirSync(dailyDir, { recursive: true });
  snapshot.qualifiedDays = [
    ...new Set([
      ...history.map((day) => day.date),
      ...(snapshot.qualified ? [date] : []),
    ]),
  ].sort();
  snapshot.status =
    snapshot.qualifiedDays.length >= 3
      ? "done"
      : snapshot.qualified
        ? "qualified"
        : "incomplete";
  if (snapshot.qualified && !history.some((day) => day.date === date))
    fs.writeFileSync(
      path.join(dailyDir, `${date}.json`),
      JSON.stringify(snapshot, null, 2) + "\n",
      { flag: "wx" },
    );
  const temporary = path.join(options.output, `.latest-${process.pid}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(snapshot, null, 2) + "\n", {
    flag: "wx",
  });
  fs.renameSync(temporary, path.join(options.output, "latest.json"));
  process.stdout.write(
    JSON.stringify({
      status: snapshot.status,
      date,
      qualifiedDays: snapshot.qualifiedDays,
      reasons: snapshot.reasons,
    }) + "\n",
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(
    JSON.stringify({ status: "error", code: safeCode(error) }) + "\n",
  );
  process.exitCode = 1;
}
