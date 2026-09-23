import { expect, it, vi } from "vitest";
import {
  cliArgs,
  parseCliReply,
  subscriptionEnv,
} from "~/server/infra/local-llm";
import { settingsSchema } from "~/lib/domain";
it("旧配置升级默认 Codex，显式提供方选择保留", () => {
  expect(settingsSchema.parse({ fastModel: "old" }).llmProvider).toBe("codex");
  expect(settingsSchema.parse({ llmProvider: "claude" }).llmProvider).toBe(
    "claude",
  );
});
it("CLI 调用禁用工具和第三方 MCP，不绕过权限", () => {
  const codex = cliArgs("codex", "test-model");
  expect(codex).toContain("--ignore-user-config");
  expect(codex).toContain('forced_login_method="chatgpt"');
  expect(codex).toContain("read-only");
  expect(codex).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  const claude = cliArgs("claude", "");
  expect(claude[claude.indexOf("--tools") + 1]).toBe("");
  expect(claude).toContain("--strict-mcp-config");
  expect(claude).not.toContain("--bare");
});
it("订阅调用剔除 API 计费环境变量且不改变宿主环境", () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "placeholder");
  vi.stubEnv("OPENAI_API_KEY", "placeholder");
  const env = subscriptionEnv();
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env.OPENAI_API_KEY).toBeUndefined();
  expect(process.env.OPENAI_API_KEY).toBe("placeholder");
  vi.unstubAllEnvs();
});
it("提取 Codex 最终消息和用量，拒绝未完成的结果", () => {
  const output = [
    {
      type: "item.completed",
      item: { type: "agent_message", text: '{"ok":true}' },
    },
    { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 4 } },
  ]
    .map((v) => JSON.stringify(v))
    .join("\n");
  expect(parseCliReply("codex", output)).toEqual({
    text: '{"ok":true}',
    tokens: 14,
  });
  expect(() => parseCliReply("codex", '{"type":"turn.failed"}')).toThrow();
  expect(() => parseCliReply("codex", '{"type":"thread.started"}')).toThrow();
});
it("Claude 退出成功但结果报错时不能生成报告", () => {
  expect(() =>
    parseCliReply("claude", '{"type":"result","is_error":true}'),
  ).toThrow();
  expect(
    parseCliReply(
      "claude",
      '{"type":"result","result":"{}","usage":{"input_tokens":2,"output_tokens":3}}',
    ),
  ).toEqual({ text: "{}", tokens: 5 });
});
