import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { POST } from "../../src/app/api/shutdown/route";
import { thsdkShutdown } from "~/server/data-sources/thsdk/thsdk-client";

vi.mock("~/server/data-sources/thsdk/thsdk-client", () => ({
  thsdkShutdown: vi.fn<() => Promise<void>>(),
}));

const shutdown = vi.mocked(thsdkShutdown);
const dataParent = process.env.QUANT_DATA_DIR!;
const token = "test-session";
const url = "http://127.0.0.1:3911/api/shutdown";
const budgetMs = 1_200;
let path: string;

beforeEach(() => {
  const root = mkdtempSync(join(dataParent, "shutdown-"));
  path = join(root, "quant.sqlite");
  vi.stubEnv("QUANT_DATA_DIR", root);
  vi.stubEnv("QUANT_SESSION_TOKEN", token);
  vi.useFakeTimers();
  shutdown.mockReset().mockResolvedValue(undefined);
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("test process exit");
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dirname(path), { recursive: true, force: true });
});

function request(headers: HeadersInit = { "x-quant-session": token }) {
  return new NextRequest(url, { method: "POST", headers });
}

function dirtyWal() {
  const db = new Database(path);
  db.pragma("journal_mode=WAL");
  db.exec("CREATE TABLE sample(value INTEGER); INSERT INTO sample VALUES (42)");
  return db;
}

const walSize = () => statSync(path + "-wal").size;

async function expectGracefulExit(response: Response) {
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "shutting-down" });
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(79);
  expect(process.exit).not.toHaveBeenCalled();
  expect(() => vi.advanceTimersByTime(1)).toThrow("test process exit");
  expect(process.exit).toHaveBeenCalledWith(0);
}

it.each([
  { configured: "", headers: { "x-quant-session": token } },
  { configured: token, headers: {} },
  { configured: token, headers: { cookie: "quant-session=wrong" } },
  { configured: token, headers: { "x-quant-session": "test-sessioN" } },
  {
    configured: token,
    headers: {
      cookie: "quant-session=test-session",
      origin: "http://other.local",
      host: "127.0.0.1:3911",
    },
  },
])(
  "refuses shutdown without matching local authentication %#",
  async ({ configured, headers }) => {
    vi.stubEnv("QUANT_SESSION_TOKEN", configured);
    const result = await POST(request(headers as HeadersInit));
    expect(result.status).toBe(403);
    expect(shutdown).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("accepts the session cookie and does not create a missing database", async () => {
  const response = await POST(request({ cookie: "quant-session=" + token }));
  expect(shutdown).toHaveBeenCalledExactlyOnceWith(budgetMs);
  expect(existsSync(path)).toBe(false);
  await expectGracefulExit(response);
});

it("waits for THSDK shutdown before truncating the WAL", async () => {
  const db = dirtyWal();
  try {
    let release!: () => void;
    shutdown.mockReturnValue(
      new Promise<void>((resolve) => (release = resolve)),
    );
    const response = POST(request());
    expect(shutdown).toHaveBeenCalledExactlyOnceWith(budgetMs);
    await vi.advanceTimersByTimeAsync(100);
    expect(walSize()).toBeGreaterThan(0);
    expect(process.exit).not.toHaveBeenCalled();
    release();
    const result = await response;
    expect(walSize()).toBe(0);
    await expectGracefulExit(result);
  } finally {
    db.close();
  }
});

it("checkpoints and exits when THSDK rejects", async () => {
  const db = dirtyWal();
  try {
    expect(walSize()).toBeGreaterThan(0);
    shutdown.mockRejectedValue(new Error("fixture shutdown failure"));
    const response = await POST(request());
    expect(shutdown).toHaveBeenCalledExactlyOnceWith(budgetMs);
    expect(walSize()).toBe(0);
    await expectGracefulExit(response);
  } finally {
    db.close();
  }
});

it("checkpoints and exits at the deadline even if THSDK never settles", async () => {
  const db = dirtyWal();
  try {
    shutdown.mockReturnValue(new Promise<void>(() => {}));
    const responded = vi.fn((response: Response) => response);
    const response = POST(request()).then(responded);
    expect(shutdown).toHaveBeenCalledExactlyOnceWith(budgetMs);
    await vi.advanceTimersByTimeAsync(budgetMs - 1);
    expect(walSize()).toBeGreaterThan(0);
    expect(responded).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(responded).toHaveBeenCalledTimes(1);
    const result = await response;
    expect(walSize()).toBe(0);
    await expectGracefulExit(result);
  } finally {
    db.close();
  }
});
