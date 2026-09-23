import { currentMcpHealth } from "../../mcp-health";
import { z } from "zod";
import {
  importLocalMcp,
  mcpTools,
  queryMcp,
} from "../../data-sources/tdx/tdx-mcp-disabled";
import { createTRPCRouter, publicProcedure as p } from "../trpc";
export const integrationsRouter = createTRPCRouter({
  mcpHealth: p.query(() => currentMcpHealth()),
  importMcp: p.mutation(() => importLocalMcp()),
  mcpTools: p.mutation(async () =>
    (await mcpTools()).map((t) => ({
      name: t.name,
      description: t.description,
      schema: t.inputSchema,
    })),
  ),
  mcpQuery: p
    .input(z.object({ name: z.string(), args: z.record(z.unknown()) }))
    .mutation(({ input }) => queryMcp(input.name, input.args)),
});
