import { execFile, fork } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createThsdkClient,
  type ThsdkCallOptions,
  type ThsdkClient,
  type ThsdkClientOptions,
} from "~/server/data-sources/thsdk/thsdk-client";
import type { ThsdkWorkerMessage } from "~/server/data-sources/thsdk/thsdk-contract";
import { migrate } from "~/server/db/migrations";

// Observe actual child handles and process launches while preserving the Node APIs.
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    fork: vi.fn(original.fork),
    execFile: vi.fn(original.execFile),
  };
});

const fakeWorker = String.raw`
const { appendFileSync, existsSync } = require("node:fs");
const trace = (event, details) => {
  appendFileSync("ipc.jsonl", JSON.stringify({ event, pid: process.pid, ...details }) + "\n");
};
const send = (message, data) => {
  trace("reply", { id: message.id, label: message.params?.label });
  process.send({ id: message.id, ok: true, data });
};
const attempts = new Map();
let initialized = false;

process.on("disconnect", () => process.exit(3));
process.on("message", (message) => {
  trace(message.type, { ...message, event: message.type });
  if (message.type === "init") {
    if (initialized || message.parentPid !== process.ppid) process.exit(4);
    initialized = true;
    process.send({ id: message.id, ok: true, abiVersion: "2.0.0", methodsCount: 70 });
    return;
  }
  if (!initialized) process.exit(5);
  if (message.type === "shutdown") {
    trace("closed");
    process.exit(0);
  }
  const { label, behavior, stale_id } = message.params;
  const data = { label, price: 42, pid: process.pid };
  if (behavior === "crash") process.exit(7);
  if (behavior === "hang") {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  if (behavior === "hold") {
    const gate = setInterval(() => {
      if (!existsSync("release")) return;
      clearInterval(gate);
      send(message, data);
    }, 10);
    return;
  }
  const attempt = (attempts.get(label) ?? 0) + 1;
  attempts.set(label, attempt);
  if (behavior === "always_limited" || (behavior === "retry" && attempt === 1)) {
    process.send({
      id: message.id,
      ok: false,
      errorCode: "rate_limited",
      safeMessage: "fixture rate limit",
      retryAfterMs: 180,
    });
    return;
  }
  if (stale_id !== undefined) {
    trace("replay", { id: stale_id });
    process.send({ id: stale_id, ok: true, data: { label: "stale reply" } });
  }
  send(message, data);
});
`;

type TraceEntry =
  | (ThsdkWorkerMessage & { event: ThsdkWorkerMessage["type"]; pid: number })
  | {
      event: "reply" | "replay" | "closed";
      pid: number;
      id?: number;
      label?: string;
    };

const dataParent = process.env.QUANT_DATA_DIR!;
const forks = vi.mocked(fork);
const minIntervalMs = 100;
const method = "get_market_metadata";
const expectedSha256 = "ab".repeat(32);
let root: string;
let sessionRoot: string;
let workerScriptPath: string;
let sessionDir: string;
let clients: ThsdkClient[];

beforeEach(() => {
  forks.mockClear();
  vi.mocked(execFile).mockClear();
  root = mkdtempSync(join(dataParent, "thsdk-lifecycle-"));
  vi.stubEnv("QUANT_DATA_DIR", root);
  sessionRoot = join(root, "runtime-sessions", "thsdk");
  workerScriptPath = join(root, "fake-worker.cjs");
  sessionDir = join(sessionRoot, "worker");
  clients = [];
});

afterEach(async () => {
  try {
    await Promise.all(clients.map((client) => client.shutdown(2_500)));
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});

function startClient(options: ThsdkClientOptions = {}) {
  writeFileSync(workerScriptPath, fakeWorker);
  const client = createThsdkClient({
    sessionRoot,
    workerScriptPath,
    minIntervalMs,
    defaultTimeoutMs: 3_000,
    watchdogGraceMs: 75,
    ...options,
  });
  clients.push(client);
  return client;
}

const dllPath = () => join(root, "fixture-hq.dll");
const lockPath = () => join(sessionRoot, "worker.lock");

function read(
  client: ThsdkClient,
  label: string,
  behavior = "read",
  options: Partial<ThsdkCallOptions> = {},
  staleId?: number,
) {
  return client.invokeRead<{ label: string; price: number; pid: number }>(
    method,
    {
      label,
      behavior,
      ...(staleId === undefined ? {} : { stale_id: staleId }),
    },
    { dllPath: dllPath(), expectedSha256, sessionDir, ...options },
  );
}

function trace(): TraceEntry[] {
  const file = join(sessionDir, "ipc.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TraceEntry);
}

function receivedCalls() {
  return trace().flatMap((entry) =>
    entry.event === "call" && "type" in entry && entry.type === "call"
      ? [{ ...entry, label: (entry.params as { label: string }).label }]
      : [],
  );
}

function childAt(index: number) {
  const result = forks.mock.results[index];
  if (result?.type !== "return") throw new Error("Expected a forked worker");
  return result.value;
}

function sentCalls() {
  const child = childAt(0);
  const send = child.send;
  const times: number[] = [];
  vi.spyOn(child, "send").mockImplementation((...args) => {
    const [message] = args;
    if ((message as ThsdkWorkerMessage).type === "call")
      times.push(performance.now());
    return Reflect.apply(send, child, args) as boolean;
  });
  return times;
}

it("handshakes with a real child and dispatches queued reads serially at the minimum interval", async () => {
  const client = startClient();
  const warm = await read(client, "warm");
  expect(warm).toEqual({ label: "warm", price: 42, pid: childAt(0).pid });
  expect(trace().slice(0, 2)).toEqual([
    expect.objectContaining({
      event: "init",
      pid: warm.pid,
      parentPid: process.pid,
      dllPath: dllPath(),
      expectedSha256,
    }),
    expect.objectContaining({ event: "call", kind: "read", method }),
  ]);
  const dispatched = sentCalls();

  const first = read(client, "first", "hold");
  const second = read(client, "second");
  const third = read(client, "third");
  const results = Promise.all([first, second, third]);
  void results.catch(() => {});
  await vi.waitFor(() =>
    expect(receivedCalls().map(({ label }) => label)).toEqual([
      "warm",
      "first",
    ]),
  );
  writeFileSync(join(sessionDir, "release"), "");
  expect((await results).map(({ label }) => label)).toEqual([
    "first",
    "second",
    "third",
  ]);
  expect(
    trace()
      .slice(3)
      .map((entry) => entry.event),
  ).toEqual(["call", "reply", "call", "reply", "call", "reply"]);
  expect(dispatched).toHaveLength(3);
  expect(dispatched[1]! - dispatched[0]!).toBeGreaterThanOrEqual(minIntervalMs);
  expect(dispatched[2]! - dispatched[1]!).toBeGreaterThanOrEqual(minIntervalMs);
  expect(forks).toHaveBeenCalledTimes(1);
});

it("backs off and retries rate_limited once on the same worker", async () => {
  const client = startClient();
  const warm = await read(client, "warm");
  const dispatched = sentCalls();
  await expect(read(client, "retry", "retry")).resolves.toEqual({
    label: "retry",
    price: 42,
    pid: warm.pid,
  });
  await expect(read(client, "bounded", "always_limited")).rejects.toMatchObject(
    {
      code: "rate_limited",
      retryAfterMs: 180,
    },
  );
  expect(dispatched).toHaveLength(4);
  expect(dispatched[1]! - dispatched[0]!).toBeGreaterThanOrEqual(180);
  expect(dispatched[3]! - dispatched[2]!).toBeGreaterThanOrEqual(180);
  expect(receivedCalls().map(({ label }) => label)).toEqual([
    "warm",
    "retry",
    "retry",
    "bounded",
    "bounded",
  ]);
  expect(forks).toHaveBeenCalledTimes(1);
});

it("cancels a queued job without sending IPC or disturbing adjacent jobs", async () => {
  const client = startClient();
  const warm = await read(client, "warm");
  const inFlight = read(client, "in-flight", "hold");
  void inFlight.catch(() => {});
  await vi.waitFor(() =>
    expect(receivedCalls().at(-1)?.label).toBe("in-flight"),
  );

  const controller = new AbortController();
  const aborted = read(client, "aborted", "read", {
    signal: controller.signal,
  });
  const remaining = read(client, "remaining");
  void remaining.catch(() => {});
  controller.abort();
  await expect(aborted).rejects.toMatchObject({ code: "cancelled" });
  expect(receivedCalls().map(({ label }) => label)).toEqual([
    "warm",
    "in-flight",
  ]);
  writeFileSync(join(sessionDir, "release"), "");
  expect(
    (await Promise.all([inFlight, remaining])).map(({ pid }) => pid),
  ).toEqual([warm.pid, warm.pid]);
  expect(receivedCalls().map(({ label }) => label)).toEqual([
    "warm",
    "in-flight",
    "remaining",
  ]);
  expect(forks).toHaveBeenCalledTimes(1);
});

it("kills a blocked worker on timeout, drops stale replies and recovers on a new generation", async () => {
  const client = startClient();
  const before = await read(client, "warm");
  const initialGeneration = client.getState().generation;
  const child = childAt(0);
  const kill = child.kill.bind(child);
  let staleId: number | undefined;
  let ignoredRetiredReply = false;
  const killed = vi.spyOn(child, "kill").mockImplementation((signal) => {
    const call = receivedCalls().find(({ label }) => label === "blocked");
    staleId = call?.id;
    if (staleId !== undefined) {
      // Deliver the last possible matching reply at the retirement boundary.
      // A real worker blocked in a native call cannot reliably produce this race.
      const listeners = child.listenerCount("message");
      child.emit("message", { id: staleId, ok: true, data: "retired reply" });
      ignoredRetiredReply =
        listeners > 0 && child.listenerCount("message") === listeners;
    }
    return kill(signal);
  });

  const blocked = read(client, "blocked", "hang", { timeoutMs: 650 });
  const queued = read(client, "queued");
  await Promise.all([
    expect(blocked).rejects.toMatchObject({ code: "timeout" }),
    expect(queued).rejects.toMatchObject({ code: "timeout" }),
  ]);
  expect(killed).toHaveBeenCalledWith("SIGKILL");
  expect(staleId).toBeDefined();
  expect(ignoredRetiredReply).toBe(true);
  expect(client.getState()).toMatchObject({
    running: false,
    generation: initialGeneration + 1,
    consecutiveCrashes: 1,
    lastErrorCode: "timeout",
  });
  expect(receivedCalls().map(({ label }) => label)).toEqual([
    "warm",
    "blocked",
  ]);

  const restored = await read(client, "restored", "read", {}, staleId);
  expect(restored).toEqual({
    label: "restored",
    price: 42,
    pid: childAt(1).pid,
  });
  expect(restored.pid).not.toBe(before.pid);
  expect(child.signalCode).toBe("SIGKILL");
  expect(trace()).toContainEqual({
    event: "replay",
    pid: restored.pid,
    id: staleId,
  });
  expect(client.getState()).toMatchObject({
    running: true,
    generation: initialGeneration + 2,
    consecutiveCrashes: 0,
    lastErrorCode: null,
  });
});

it("opens the circuit after consecutive crashes and permits a fresh worker at the cooldown boundary", async () => {
  const client = startClient({
    maxConsecutiveCrashes: 2,
    circuitCooldownMs: 1_000,
  });
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);

  await expect(read(client, "first crash", "crash")).rejects.toMatchObject({
    code: "worker_crashed",
  });
  expect(client.getState()).toMatchObject({
    consecutiveCrashes: 1,
    circuitOpenUntil: null,
  });
  await expect(read(client, "second crash", "crash")).rejects.toMatchObject({
    code: "worker_crashed",
  });
  expect(client.getState()).toMatchObject({
    running: false,
    consecutiveCrashes: 2,
    circuitOpenUntil: now + 1_000,
  });
  clock.mockReturnValue(now + 999);
  await expect(read(client, "during cooldown")).rejects.toMatchObject({
    code: "circuit_open",
    retryAfterMs: 1,
  });
  expect(forks).toHaveBeenCalledTimes(2);
  expect(receivedCalls().map(({ label }) => label)).toEqual([
    "first crash",
    "second crash",
  ]);
  clock.mockReturnValue(now + 1_000);
  await expect(read(client, "after cooldown")).resolves.toMatchObject({
    label: "after cooldown",
  });
  expect(forks).toHaveBeenCalledTimes(3);
  expect(client.getState()).toMatchObject({
    consecutiveCrashes: 0,
    circuitOpenUntil: null,
  });
});

it("shuts down cleanly and releases the kernel lease for another client", async () => {
  const client = startClient();
  const { pid } = await read(client, "first owner");
  expect(JSON.parse(readFileSync(lockPath(), "utf8"))).toMatchObject({
    pid,
    ownerPid: process.pid,
  });
  const next = startClient();
  await expect(read(next, "while locked")).rejects.toMatchObject({
    code: "session_locked",
  });
  expect(forks).toHaveBeenCalledTimes(1);

  await client.shutdown(2_500);
  expect(childAt(0).exitCode).toBe(0);
  expect(childAt(0).signalCode).toBeNull();
  expect(trace().slice(-2)).toEqual([
    expect.objectContaining({ event: "shutdown", pid }),
    { event: "closed", pid },
  ]);
  expect(existsSync(lockPath())).toBe(false);
  expect(client.getState().running).toBe(false);
  await expect(read(client, "after shutdown")).rejects.toMatchObject({
    code: "unavailable",
  });
  const acquired = await read(next, "new owner");
  expect(acquired.pid).toBe(childAt(1).pid);
  expect(acquired.pid).not.toBe(pid);
});

it("persists THSDK settings without migrating the existing database or launching IPC", async () => {
  const path = join(root, "quant.sqlite");
  const observer = new Database(path);
  const version = () => observer.pragma("user_version", { simple: true });
  const schema = () => observer.pragma("schema_version", { simple: true });
  let appConnection: Database.Database | undefined;
  try {
    migrate(observer);
    const originalVersion = version();
    const originalSchema = schema();
    const { sqlite } = await import("~/server/db");
    const {
      readThsdkConfig,
      saveThsdkConfig,
      getThsdkStatus,
      thsdkLoginGuest,
    } = await import("~/server/data-sources/thsdk/thsdk-auth");
    expect(readThsdkConfig()).toMatchObject({
      version: 1,
      enabled: false,
      guestModeEnabled: false,
    });
    appConnection = sqlite();
    const config = saveThsdkConfig({
      enabled: true,
      authMode: "guest",
    });
    expect(config).toEqual({
      version: 1,
      enabled: true,
      authMode: "guest",
      allowAutoFallback: false,
      guestModeEnabled: false,
      updatedAt: expect.any(Number),
    });
    expect(readThsdkConfig()).toEqual(config);
    expect(
      observer
        .prepare("SELECT kind, payload FROM records WHERE id = ?")
        .get("thsdk-config"),
    ).toEqual({ kind: "thsdk-config", payload: JSON.stringify(config) });
    expect(version()).toBe(originalVersion);
    expect(schema()).toBe(originalSchema);

    const credentialsDir = join(root, "credentials");
    mkdirSync(credentialsDir);
    writeFileSync(
      join(credentialsDir, "thsdk-credentials.bin"),
      "unreadable fixture",
    );
    const files = readdirSync(root, { recursive: true }).map(String).sort();
    const dataVersion = observer.pragma("data_version", { simple: true });
    const status = getThsdkStatus();
    expect(status).toMatchObject({
      enabled: true,
      configured: true,
      state: "logged_out",
      activeMode: null,
      hasSavedCredentials: true,
      authMode: "guest",
      guestModeEnabled: false,
    });
    await expect(thsdkLoginGuest()).rejects.toMatchObject({
      code: "disabled",
      message: "游客模式未启用",
    });
    expect(getThsdkStatus()).toEqual(status);
    expect(forks).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    expect(readdirSync(root, { recursive: true }).map(String).sort()).toEqual(
      files,
    );
    expect(observer.pragma("data_version", { simple: true })).toBe(dataVersion);
    expect(version()).toBe(originalVersion);
    expect(schema()).toBe(originalSchema);
  } finally {
    appConnection?.close();
    observer.close();
  }
});
