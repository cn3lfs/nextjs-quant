import { closeMcp } from "../src/server/mcp";
import { withMcp, cleanMcpResult } from "../src/server/mcp";
const started = Date.now();
try {
  await withMcp(async (client) => {
    const tools = (await client.listTools()).tools;
    console.log(
      JSON.stringify({
        stage: "tools",
        ms: Date.now() - started,
        tools: tools.map((tool) => ({
          name: tool.name,
          required: tool.inputSchema.required,
          fields: Object.keys(tool.inputSchema.properties ?? {}),
        })),
      }),
    );
    const before = Date.now();
    const result = await client.callTool(
      {
        name: "tdx_lookup_stock",
        arguments: { query: "德邦股份", range: "AG" },
      },
      undefined,
      { timeout: 25000 },
    );
    console.log(
      JSON.stringify({
        stage: "lookup",
        ms: Date.now() - before,
        isError: result.isError ?? false,
        result: cleanMcpResult(result.structuredContent ?? result.content),
      }).slice(0, 4500),
    );
  });
} catch (error) {
  console.log(
    JSON.stringify({
      stage: "failed",
      ms: Date.now() - started,
      message: error instanceof Error ? error.message : "failed",
    }),
  );
  process.exitCode = 1;
}

await closeMcp();
