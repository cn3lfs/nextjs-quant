import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { afterEach, expect, it, vi } from "vitest";
import { POST } from "../../src/app/api/shutdown/route";

const path = join(process.env.QUANT_DATA_DIR!, "quant.sqlite");
const token = "test-session";
const url = "http://127.0.0.1:3911/api/shutdown";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

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
  ({ configured, headers }) => {
    vi.useFakeTimers();
    vi.stubEnv("QUANT_SESSION_TOKEN", configured);
    const result = POST(
      new NextRequest(url, { method: "POST", headers: headers as HeadersInit }),
    );
    expect(result.status).toBe(403);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each(["cookie", "header"])(
  "accepts the session %s and sends the response before exiting",
  async (kind) => {
    vi.useFakeTimers();
    vi.stubEnv("QUANT_SESSION_TOKEN", token);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("test process exit");
    });
    const headers = new Headers();
    if (kind === "cookie") headers.set("cookie", "quant-session=" + token);
    else headers.set("x-quant-session", token);
    const db = kind === "header" ? new Database(path) : undefined;
    try {
      if (db) {
        db.pragma("journal_mode=WAL");
        db.exec(
          "CREATE TABLE sample(value INTEGER); INSERT INTO sample VALUES (42)",
        );
        expect(statSync(path + "-wal").size).toBeGreaterThan(0);
      }
      const result = POST(new NextRequest(url, { method: "POST", headers }));
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({ status: "shutting-down" });
      if (db) expect(statSync(path + "-wal").size).toBe(0);
      else expect(existsSync(path)).toBe(false);
      vi.advanceTimersByTime(79);
      expect(exit).not.toHaveBeenCalled();
      expect(() => vi.advanceTimersByTime(1)).toThrow("test process exit");
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      db?.close();
    }
  },
);
