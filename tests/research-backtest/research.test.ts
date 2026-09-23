import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
const { create, localCompletion } = vi.hoisted(() => ({
  create: vi.fn(),
  localCompletion: vi.fn(),
}));
vi.mock("~/server/infra/local-llm", () => ({ localCompletion }));
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create } };
  },
}));
import { structured, analyze, researchModel } from "~/server/research/research";
import { get, list, sqlite, put } from "~/server/db";
process.env.QUANT_DATA_DIR = mkdtempSync(
  join(tmpdir(), "quant-research-tests-"),
);
process.env.DEEPSEEK_API_KEY = "test-placeholder";
const response = (content: string, finish_reason = "stop") => ({
  choices: [{ message: { content }, finish_reason }],
  usage: { total_tokens: 10 },
});
beforeEach(() => {
  create.mockReset();
  localCompletion.mockReset();
  sqlite().prepare("DELETE FROM records").run();
  put("settings", "settings", { llmProvider: "deepseek" });
});
describe("LLM 边界与故障", () => {
  it("SEPA requires all six stages, validates citations and archives method files", async () => {
    const root = mkdtempSync(join(tmpdir(), "quant-sepa-method-"));
    const dir = join(root, "sepa-strategy-analyst");
    mkdirSync(join(dir, "references"), { recursive: true });
    for (const file of [
      "SKILL.md",
      "references/screening-criteria.md",
      "references/vcp-pattern.md",
      "references/entry-exit-rules.md",
    ])
      writeFileSync(join(dir, file), "fixture method");
    vi.stubEnv("QUANT_SKILLS_DIR", root);
    put("settings", "settings", { llmProvider: "codex" });
    const report = {
      title: "fixture",
      summary: "missing evidence",
      supporting: [],
      opposing: [],
      risks: [],
      missing: ["RS"],
      nextSteps: [],
      citations: ["E"],
      stages: [
        "market",
        "fundamentals",
        "trend",
        "vcp",
        "entry-risk",
        "conclusion",
      ].map((id) => ({
        id,
        status: "missing",
        summary: "资料不足",
        citations: ["E"],
        missing: ["资料"],
      })),
    };
    try {
      localCompletion
        .mockResolvedValueOnce({
          text: JSON.stringify({
            ...report,
            stages: report.stages.slice(0, 5),
          }),
          tokens: 1,
        })
        .mockResolvedValue({ text: JSON.stringify(report), tokens: 2 });
      const evidence = [
        { id: "E", source: "fixture", asOf: "2026-01-01", text: "fixture" },
      ];
      const result = await analyze(
        "context",
        "question",
        evidence,
        undefined,
        "sepa",
      );
      expect(result.stages).toHaveLength(6);
      expect(result.skills?.[0]?.files).toHaveLength(4);
      expect(localCompletion).toHaveBeenCalledTimes(2);
      expect(create).not.toHaveBeenCalled();
      await analyze("context", "question", evidence, undefined, "sepa");
      expect(localCompletion).toHaveBeenCalledTimes(2);
      localCompletion.mockResolvedValue({
        text: JSON.stringify({
          ...report,
          stages: report.stages.map((s) => ({ ...s, citations: ["invented"] })),
        }),
        tokens: 1,
      });
      await expect(
        analyze("different", "question", evidence, undefined, "sepa"),
      ).rejects.toThrow("连续两次");
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("并发模型调用最多两个，取消排队请求不启动模型", async () => {
    put("settings", "settings", { llmProvider: "codex" });
    let active = 0,
      peak = 0;
    localCompletion.mockImplementation(async () => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active--;
      return { text: '{"ok":true}', tokens: 1 };
    });
    const tasks = Array.from({ length: 6 }, () =>
      structured("json", z.object({ ok: z.boolean() }), researchModel()),
    );
    const controller = new AbortController();
    const cancelled = structured(
      "json",
      z.object({ ok: z.boolean() }),
      researchModel(),
      controller.signal,
    );
    const check = expect(cancelled).rejects.toThrow("取消");
    controller.abort();
    await Promise.all(tasks);
    await check;
    expect(peak).toBe(2);
    expect(localCompletion).toHaveBeenCalledTimes(6);
    expect(create).not.toHaveBeenCalled();
  });
  it("升级默认 Codex，失败不回退 DeepSeek", async () => {
    put("settings", "settings", {});
    expect(researchModel()).toBe("codex:default");
    localCompletion.mockRejectedValue(new Error("套餐额度不足"));
    await expect(
      structured("json", z.object({ ok: z.boolean() }), researchModel()),
    ).rejects.toThrow("套餐额度不足");
    expect(create).not.toHaveBeenCalled();
  });
  it("Claude 结构修复仍使用同一提供方", async () => {
    put("settings", "settings", { llmProvider: "claude" });
    localCompletion
      .mockResolvedValueOnce({ text: '{"ok":"invalid"}', tokens: 3 })
      .mockResolvedValueOnce({ text: '{"ok":true}', tokens: 4 });
    expect(
      await structured("json", z.object({ ok: z.boolean() }), researchModel()),
    ).toEqual({ data: { ok: true }, tokens: 7 });
    expect(
      localCompletion.mock.calls.every((call) => call[0] === "claude"),
    ).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });
  it("合法结构返回并记录用量", async () => {
    create.mockResolvedValue(response('{"ok":true}'));
    expect(
      await structured(
        "json",
        z.object({ ok: z.boolean() }),
        "deepseek-v4-flash",
      ),
    ).toEqual({ data: { ok: true }, tokens: 10 });
  });
  it("非法结构仅修复一次，明确反馈字段错误", async () => {
    create
      .mockResolvedValueOnce(response('{"ok":"wrong"}'))
      .mockResolvedValueOnce(response('{"ok":true}'));
    expect(
      (
        await structured(
          "json",
          z.object({ ok: z.boolean() }),
          "deepseek-v4-flash",
        )
      ).data.ok,
    ).toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(create.mock.calls[1]?.[0])).toContain("ok:");
  });
  it("两次空结果失败，不持久化伪报告", async () => {
    create.mockResolvedValue(response(""));
    await expect(
      structured("json", z.object({ ok: z.boolean() }), "model"),
    ).rejects.toThrow("连续两次");
    expect(create).toHaveBeenCalledTimes(2);
    expect(list("report")).toHaveLength(0);
  });
  it("模型虚构证据 ID 不能入库（负向控制）", async () => {
    create.mockResolvedValue(
      response(
        JSON.stringify({
          title: "test",
          summary: "test",
          supporting: [],
          opposing: [],
          risks: [],
          missing: [],
          nextSteps: [],
          citations: ["fabricated"],
        }),
      ),
    );
    await expect(
      analyze("ctx", "question", [
        { id: "actual", source: "test", asOf: "2026-09-08", text: "data" },
      ]),
    ).rejects.toThrow("引用");
    expect(list("report")).toHaveLength(0);
  });
  it("同证据、参数与模型命中缓存，不重复推理", async () => {
    create.mockResolvedValue(
      response(
        JSON.stringify({
          title: "test",
          summary: "test",
          supporting: [],
          opposing: [],
          risks: [],
          missing: [],
          nextSteps: [],
          citations: ["actual"],
        }),
      ),
    );
    const evidence = [
      { id: "actual", source: "test", asOf: "2026-09-08", text: "data" },
    ];
    const first = await analyze("ctx", "question", evidence),
      second = await analyze("ctx", "question", evidence);
    expect(first.id).toBe(second.id);
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("取消的任务不发起付费调用", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      structured(
        "json",
        z.object({ ok: z.boolean() }),
        "model",
        controller.signal,
      ),
    ).rejects.toThrow("取消");
    expect(create).not.toHaveBeenCalled();
  });
});
