import { closeMcp } from "../src/server/mcp";
import { readSnapshot, scan } from "../src/server/data-sources/tdx/tdx";
import { metrics } from "~/lib/screening-metrics";
import { defaultStrategy } from "../src/lib/domain";
import { importLocalMcp, mcpTools } from "../src/server/mcp";
import { structured, researchModel } from "../src/server/research/research";
import { z } from "zod";
const root = "E:\\new_tdx64";
const coverage = await scan(root);
console.log(
  "Coverage",
  coverage.counts,
  "A-stock records",
  coverage.securities.length,
);
for (const [symbol, period] of [
  ["sh600519", "day"],
  ["sz000001", "day"],
  ["sh600519", "5m"],
] as const) {
  try {
    const snapshot = await readSnapshot(root, symbol, period);
    console.log(
      "Local data",
      symbol,
      period,
      snapshot.bars.length,
      snapshot.bars[0]?.date,
      snapshot.bars.at(-1)?.date,
      metrics(snapshot.bars, defaultStrategy),
    );
  } catch (e) {
    console.log(
      "Local data error",
      symbol,
      period,
      e instanceof Error ? e.message : "error",
    );
  }
}
if (process.argv.includes("--mcp")) {
  try {
    await importLocalMcp();
    const tools = await mcpTools();
    console.log(
      "MCP connected",
      tools.map((t) => t.name),
    );
  } catch {
    console.log("MCP validation failed (credentials not logged)");
  }
}
if (process.argv.includes("--llm")) {
  try {
    const result = await structured(
      '仅返回 json: {"ok":true}，用于 API 连通性检查。',
      z.object({ ok: z.boolean() }),
      researchModel(false),
    );
    console.log(researchModel(false), result.data, "tokens", result.tokens);
  } catch (e) {
    console.log(
      researchModel(false),
      e instanceof Error ? e.message : "request failed",
    );
  }
}

await closeMcp();
