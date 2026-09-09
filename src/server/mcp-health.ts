import { createHash } from "node:crypto";
import { get, put, sqlite } from "./db";

type ToolShape = { name: string; inputSchema: unknown; outputSchema?: unknown };
export type McpHealth = {
  status: "available" | "failed";
  startedAt: number;
  checkedAt: number;
  latencyMs: number;
  lastSuccessAt: number | null;
  schemaHash: string | null;
  tools: { name: string; schemaHash: string }[];
  changes: { added: string[]; removed: string[]; changed: string[] };
  message: string;
};
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export const schemaFingerprint = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
export function currentMcpHealth() {
  return get<McpHealth>("mcp-health") ?? null;
}
export function recordMcpHealth(startedAt: number, tools?: ToolShape[]) {
  return sqlite()
    .transaction(() => {
      const previous = currentMcpHealth();
      // A slower, earlier probe must not replace the result of a newer probe.
      if (previous && previous.startedAt > startedAt) return previous;
      const now = Date.now();
      const entries = tools
        ?.map((tool) => ({
          name: tool.name,
          schemaHash: schemaFingerprint({
            input: tool.inputSchema,
            output: tool.outputSchema ?? null,
          }),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const old = new Map(
        previous?.tools.map((tool) => [tool.name, tool.schemaHash]),
      );
      const names = new Set(entries?.map((tool) => tool.name));
      return put<McpHealth>("mcp-health", "mcp-health", {
        status: entries ? "available" : "failed",
        startedAt,
        checkedAt: now,
        latencyMs: Math.max(0, now - startedAt),
        lastSuccessAt: entries ? now : (previous?.lastSuccessAt ?? null),
        schemaHash: entries
          ? schemaFingerprint(entries)
          : (previous?.schemaHash ?? null),
        tools: entries ?? previous?.tools ?? [],
        changes:
          entries && previous?.lastSuccessAt
            ? {
                added: entries
                  .filter((tool) => !old.has(tool.name))
                  .map((tool) => tool.name),
                removed: [...old.keys()].filter((name) => !names.has(name)),
                changed: entries
                  .filter(
                    (tool) =>
                      old.has(tool.name) &&
                      old.get(tool.name) !== tool.schemaHash,
                  )
                  .map((tool) => tool.name),
              }
            : { added: [], removed: [], changed: [] },
        message: entries
          ? "工具发现成功；不代表行情实时或所有查询均可用。"
          : "连接或工具发现失败，请检查认证和网络；保留上次成功结构供对照。",
      });
    })
    .immediate();
}
