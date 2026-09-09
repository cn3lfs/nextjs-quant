import { expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ConnectionPool } from "../src/server/connection-pool";
import { readMcpSession } from "../src/server/mcp-session";

it("real SDK sends a fresh initialize without the expired session header", async () => {
  let initializations = 0;
  const calls: string[] = [];
  const transportFetch: typeof fetch = async (_url, init) => {
    if (init?.method === "GET") return new Response(null, { status: 405 });
    const request = JSON.parse(String(init?.body)) as {
      id?: number;
      method: string;
    };
    const session = new Headers(init?.headers).get("mcp-session-id");
    if (request.method === "initialize") {
      expect(session).toBeNull();
      initializations++;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          },
        }),
        {
          headers: {
            "Content-Type": "application/json",
            "mcp-session-id": `session-${initializations}`,
          },
        },
      );
    }
    if (request.method === "notifications/initialized")
      return new Response(null, { status: 202 });
    expect(request.method).toBe("tools/call");
    calls.push(session!);
    if (session === "session-1")
      return new Response("Session expired", { status: 404 });
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: { content: [{ type: "text", text: "verified" }] },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  };
  const pool = new ConnectionPool(async () => {
    const connection = new Client({ name: "test", version: "1" });
    await connection.connect(
      new StreamableHTTPClientTransport(
        new URL("https://example.invalid/mcp"),
        { fetch: transportFetch },
      ),
    );
    return connection;
  });
  try {
    const result = await readMcpSession(pool, (connection) =>
      connection.callTool({ name: "tdx_quotes", arguments: {} }),
    );
    expect(result.content).toEqual([{ type: "text", text: "verified" }]);
    expect(initializations).toBe(2);
    expect(calls).toEqual(["session-1", "session-2"]);
  } finally {
    await pool.close();
  }
});

function client(sessionId?: string) {
  return {
    transport: new StreamableHTTPClientTransport(
      new URL("https://example.invalid/mcp"),
      { sessionId },
    ),
    close: vi.fn(async () => {}),
  } as unknown as Client;
}
it("reinitializes an expired stateful session once, sharing concurrent replacement", async () => {
  const first = client("old"),
    second = client("new");
  const connect = vi
    .fn()
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(second);
  const pool = new ConnectionPool<Client>(connect);
  const request = vi.fn(async (value: Client) => {
    if (value === first) throw new StreamableHTTPError(404, "expired");
    return "ok";
  });
  try {
    expect(
      await Promise.all([
        readMcpSession(pool, request),
        readMcpSession(pool, request),
      ]),
    ).toEqual(["ok", "ok"]);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(4);
    expect(first.close).toHaveBeenCalledTimes(1);
  } finally {
    await pool.close();
  }
});
it.each([400, 401, 403, 429, 500, -32602])(
  "does not retry error %s",
  async (code) => {
    const connect = vi.fn(async () => client("session"));
    const pool = new ConnectionPool(connect);
    const request = vi.fn(async () => {
      throw new StreamableHTTPError(code, "failure");
    });
    try {
      await expect(readMcpSession(pool, request)).rejects.toThrow("failure");
      expect(request).toHaveBeenCalledTimes(1);
      expect(connect).toHaveBeenCalledTimes(1);
    } finally {
      await pool.close();
    }
  },
);
it("does not confuse endpoint 404 or tool error output with session expiration", async () => {
  const pool = new ConnectionPool(async () => client());
  const request = vi.fn(async () => {
    throw new StreamableHTTPError(404, "endpoint missing");
  });
  try {
    await expect(readMcpSession(pool, request)).rejects.toThrow(
      "endpoint missing",
    );
    expect(request).toHaveBeenCalledTimes(1);
    const result = { isError: true, content: [] };
    const failedTool = vi.fn(async () => result);
    expect(await readMcpSession(pool, failedTool)).toBe(result);
    expect(failedTool).toHaveBeenCalledTimes(1);
  } finally {
    await pool.close();
  }
});
it("stops after the second expired session and does not reconnect after cancellation", async () => {
  const connect = vi.fn(async () => client("session"));
  const pool = new ConnectionPool(connect);
  const request = vi.fn(async () => {
    throw new StreamableHTTPError(404, "expired");
  });
  try {
    await expect(readMcpSession(pool, request)).rejects.toThrow("expired");
    expect(connect).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(2);
    const abort = new AbortController();
    const cancelled = vi.fn(async () => {
      abort.abort();
      throw new StreamableHTTPError(404, "expired");
    });
    await expect(
      readMcpSession(pool, cancelled, abort.signal),
    ).rejects.toThrow();
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(3);
  } finally {
    await pool.close();
  }
});
