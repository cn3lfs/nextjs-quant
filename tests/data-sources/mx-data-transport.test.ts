import { afterEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { executeMx } from "../../src/server/data-sources/mx/mx-data";
vi.mock("node:fs/promises", () => ({
  readFile: vi
    .fn()
    .mockResolvedValue(
      '[mcp_servers.mx-ds-mcp]\nurl="https://mxapi.eastmoney.com/mxds/mcp"\nhttp_headers={em_api_key="test-only-secret"}',
    ),
}));
afterEach(() => vi.restoreAllMocks());
it("sends query only and closes the connection after success", async () => {
  vi.spyOn(Client.prototype, "connect").mockResolvedValue();
  const call = vi
    .spyOn(Client.prototype, "callTool")
    .mockResolvedValue({ content: [] });
  const close = vi.spyOn(Client.prototype, "close").mockResolvedValue();
  await executeMx("mx_ashare_finance_data", "宁德时代2026-09-14收盘价");
  expect(call.mock.calls[0]?.[0]).toEqual({
    name: "mx_ashare_finance_data",
    arguments: { query: "宁德时代2026-09-14收盘价" },
  });
  expect(close).toHaveBeenCalledTimes(1);
});
it("never retries a 401 or exposes credentials in the error", async () => {
  const connect = vi
    .spyOn(Client.prototype, "connect")
    .mockRejectedValue(new StreamableHTTPError(401, "test-only-secret"));
  const call = vi.spyOn(Client.prototype, "callTool");
  vi.spyOn(Client.prototype, "close").mockResolvedValue();
  await expect(
    executeMx("mx_ashare_finance_data", "宁德时代2026-09-14收盘价"),
  ).rejects.toThrow("授权失效");
  expect(connect).toHaveBeenCalledTimes(1);
  expect(call).not.toHaveBeenCalled();
});
it("sanitizes transport failures and rejects nonallowlisted tools before connecting", async () => {
  const connect = vi
    .spyOn(Client.prototype, "connect")
    .mockRejectedValue(new Error("test-only-secret"));
  vi.spyOn(Client.prototype, "close").mockResolvedValue();
  await expect(executeMx("mx_macro_data", "中国2026年8月CPI")).rejects.toThrow(
    "连接或请求失败",
  );
  await expect(executeMx("trade", "buy")).rejects.toThrow("支持范围");
  expect(connect).toHaveBeenCalledTimes(1);
});
