import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { queryMcp, closeMcp, importLocalMcp } from "../src/server/mcp";
import { normalizeMcpBars } from "~/server/data-sources/tdx/mcp-market-data";
import { readSecret } from "../src/server/vault";

// Copy only the encrypted configuration into the isolated test directory.
// The source credentials and production database remain untouched.
it.skipIf(!process.env.QUANT_MCP_AUDIT_ROOT)(
  "uses the application's configured MCP for index daily bars",
  async () => {
    const directory = join(process.env.QUANT_DATA_DIR!, "credentials");
    await mkdir(directory, { recursive: true });
    await copyFile(
      join(process.env.QUANT_MCP_AUDIT_ROOT!, "credentials", "mcp.bin"),
      join(directory, "mcp.bin"),
    );
    if (process.env.QUANT_MCP_REIMPORT) await importLocalMcp();
    const config = await readSecret<{ tokenFile?: string; token?: string }>(
      "mcp",
    );
    console.info({
      tokenFile: config?.tokenFile,
      hasEmbeddedToken: Boolean(config?.token),
    });
    const originalFetch = globalThis.fetch;
    const calls: { host: string; status: number }[] = [];
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
      const response = await originalFetch(...args);
      calls.push({
        host: new URL(response.url).hostname,
        status: response.status,
      });
      return response;
    });
    try {
      const started = Date.now();
      const data = await queryMcp("tdx_kline", {
        code: "000001",
        setcode: "1",
        period: "4",
        tqFlag: "0",
        wantNum: "1000",
      });
      console.info({
        elapsedMs: Date.now() - started,
        shape: Array.isArray(data) ? "array" : Object.keys(data as object),
      });
      const bars = normalizeMcpBars(data, "day");
      expect(bars.length).toBeGreaterThan(100);
      console.info({ bars: bars.length, latest: bars.at(-1)?.date });
    } finally {
      console.info({ calls });
      vi.unstubAllGlobals();
      await closeMcp();
    }
  },
  60000,
);
