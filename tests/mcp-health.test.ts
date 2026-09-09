import { beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordMcpHealth,
  currentMcpHealth,
  schemaFingerprint,
} from "../src/server/mcp-health";
import { sqlite } from "../src/server/db";
process.env.QUANT_DATA_DIR = mkdtempSync(join(tmpdir(), "quant-mcp-health-"));
beforeEach(() => sqlite().prepare("DELETE FROM records").run());
it("fingerprints schemas independent of object property order and detects contract changes", () => {
  expect(schemaFingerprint({ type: "object", required: ["code"] })).toBe(
    schemaFingerprint({ required: ["code"], type: "object" }),
  );
  const initial = [
    { name: "quote", inputSchema: { type: "object" } },
    { name: "old", inputSchema: {} },
  ];
  recordMcpHealth(1000, initial);
  const next = recordMcpHealth(2000, [
    { name: "quote", inputSchema: { type: "string" } },
    { name: "new", inputSchema: {} },
  ]);
  expect(next.changes).toEqual({
    added: ["new"],
    removed: ["old"],
    changed: ["quote"],
  });
  expect(next.status).toBe("available");
});
it("failed discovery retains last successful schema and older probes cannot overwrite new results", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1100);
  try {
    expect(currentMcpHealth()).toBeNull();
    const healthy = recordMcpHealth(1000, [{ name: "quote", inputSchema: {} }]);
    clock.mockReturnValue(2500);
    const failed = recordMcpHealth(2000);
    expect(failed).toMatchObject({
      status: "failed",
      lastSuccessAt: 1100,
      latencyMs: 500,
      tools: healthy.tools,
      schemaHash: healthy.schemaHash,
    });
    recordMcpHealth(1500, []);
    expect(currentMcpHealth()).toEqual(failed);
  } finally {
    clock.mockRestore();
  }
});
