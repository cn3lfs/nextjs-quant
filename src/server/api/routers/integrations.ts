import { currentMcpHealth } from "../../mcp-health";
import { z } from "zod";
import {
  importLocalMcp,
  mcpTools,
  queryMcp,
} from "../../data-sources/tdx/tdx-mcp-disabled";
import { createTRPCRouter, capabilityProcedure as p } from "../trpc";
export const integrationsRouter = createTRPCRouter({
  mcpHealth: p("integrations", "read").query(() => currentMcpHealth()),
  importMcp: p("integrations", "configure").mutation(() => importLocalMcp()),
  mcpTools: p("integrations", "read").mutation(async () =>
    (await mcpTools()).map((t) => ({
      name: t.name,
      description: t.description,
      schema: t.inputSchema,
    })),
  ),
  mcpQuery: p("integrations", "compute")
    .input(z.object({ name: z.string(), args: z.record(z.unknown()) }))
    .mutation(({ input }) => queryMcp(input.name, input.args)),
});
