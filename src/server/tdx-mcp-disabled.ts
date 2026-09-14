/** Quota suspension boundary. The original MCP implementation remains untouched. */
const disabled = async (): Promise<never> => {
  throw new Error(
    "tdx-finance MCP 积分额度已用完，功能暂时停用，请选择免费数据源",
  );
};
export const queryMcp: typeof import("./mcp").queryMcp = disabled;
export const mcpTools: typeof import("./mcp").mcpTools = disabled;
export const importLocalMcp: typeof import("./mcp").importLocalMcp = disabled;
export const mcpConfigured = async () => false;
export const closeMcp = async () => {};
