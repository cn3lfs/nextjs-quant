import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = await mkdtemp(join(tmpdir(), "quant-mcp-token-")),
  tokenFile = join(home, "tdx-token.json"),
  url = "https://txmcp.tdx.com.cn:3001/imamcp";
const secrets = new Map<string, unknown>();
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home,
}));
vi.mock("../../src/server/vault", () => ({
  saveSecret: async (id: string, value: unknown) => void secrets.set(id, value),
  readSecret: async (id: string) => secrets.get(id),
}));
vi.mock("../../src/server/mcp-health", () => ({ recordMcpHealth: vi.fn() }));
const { importLocalMcp, mcpTools, closeMcp } =
  await import("../../src/server/mcp");

/** Records every Authorization header the transport actually sends. */
const sent: (string | null)[] = [];
function serve(): typeof fetch {
  return async (_input, init) => {
    if (init?.method === "GET") return new Response(null, { status: 405 });
    sent.push(new Headers(init?.headers).get("authorization"));
    const request = JSON.parse(String(init?.body)) as {
      id?: number;
      method: string;
    };
    if (request.method === "notifications/initialized")
      return new Response(null, { status: 202 });
    const result =
      request.method === "initialize"
        ? {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          }
        : { tools: [{ name: "tdx_quotes", inputSchema: { type: "object" } }] };
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
      {
        headers: {
          "Content-Type": "application/json",
          "mcp-session-id": "session",
        },
      },
    );
  };
}

async function writeToken(accessToken: string) {
  await writeFile(
    tokenFile,
    JSON.stringify({ access_token: accessToken, expires_in: 804800 }),
  );
}

beforeEach(async () => {
  secrets.clear();
  sent.length = 0;
  vi.stubGlobal("fetch", serve());
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(
    join(home, ".codex", "config.toml"),
    [
      "[mcp_servers.tdx-finance]",
      'command = "python"',
      `args = ["proxy.py", "--url", "${url}", "--token-file", ${JSON.stringify(tokenFile)}]`,
    ].join("\n"),
  );
  await writeToken("first-token");
});
afterEach(async () => {
  await closeMcp();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

it("stores the token file path instead of copying the token value", async () => {
  expect(await importLocalMcp()).toEqual({ configured: true });
  expect(secrets.get("mcp")).toEqual({ url, tokenFile });
});

it("rejects an import whose token file cannot be read", async () => {
  await rm(tokenFile);
  await expect(importLocalMcp()).rejects.toThrow();
  expect(secrets.has("mcp")).toBe(false);
});

it("reads the token file on every connection, so a local refresh needs no re-import", async () => {
  await importLocalMcp();
  expect(await mcpTools()).toHaveLength(1);
  expect(sent).toContain("Bearer first-token");

  // The local refresh script rotates the token; the stored credential is untouched.
  await writeToken("rotated-token");
  await closeMcp();
  sent.length = 0;
  expect(await mcpTools()).toHaveLength(1);
  expect(sent.every((header) => header === "Bearer rotated-token")).toBe(true);
  expect(secrets.get("mcp")).toEqual({ url, tokenFile });
});

it("keeps using a legacy credential that holds the token value itself", async () => {
  secrets.set("mcp", { url, token: "legacy-token" });
  expect(await mcpTools()).toHaveLength(1);
  expect(sent.every((header) => header === "Bearer legacy-token")).toBe(true);
});
