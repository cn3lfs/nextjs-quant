import { beforeEach, expect, it, vi } from "vitest";
import { canslimStageIds } from "../src/server/canslim-report-schema";
const state = vi.hoisted(() => ({
  cache: new Map<string, unknown>(),
  calls: 0,
}));
vi.mock("node:fs/promises", () => ({ readFile: async () => "method fixture" }));
vi.mock("../src/server/db", () => ({
  get: (id: string) => state.cache.get(id),
  put: (_kind: string, id: string, value: unknown) =>
    state.cache.set(id, value),
}));
vi.mock("../src/server/research", () => ({
  researchModel: () => "codex:default",
  structured: async (_prompt: string, schema: any) => {
    state.calls++;
    const policy = canslimPolicy(dossier);
    return {
      data: schema.parse({
        title: "研究",
        summary: "资料不足",
        stages: canslimStageIds.map((id) => ({
          id,
          status: "missing",
          summary: "存在缺口",
          citations: ["e1"],
          missing: policy[id].missing,
        })),
        risks: ["缺口"],
        nextSteps: ["核验"],
        citations: ["e1"],
      }),
      tokens: 1,
    };
  },
}));
import {
  analyzeCanslimDossier,
  canslimPolicy,
} from "../src/server/canslim-report";
import type { buildCanslimDossier } from "../src/server/canslim-dossier";
const dossier = {
  id: "d1",
  evidence: [{ id: "e1", text: "资料" }],
  scorecard: { missingIds: ["N1"], conflictIds: [] },
  technical: { missing: ["市场证据"] },
  marketAligned: false,
} as unknown as ReturnType<typeof buildCanslimDossier>;
beforeEach(() => {
  state.cache.clear();
  state.calls = 0;
});
it("makes source failures mandatory coverage gaps without treating old archives as failures", () => {
  const warning = "独立行业成分名单未取得，价格列表覆盖范围尚未对照。";
  const withAudit = {
    ...dossier,
    sectorRank: { warnings: [warning] },
  } as unknown as Parameters<typeof canslimPolicy>[0];
  expect(canslimPolicy(withAudit)["data-coverage"].missing).toContain(warning);
  expect(
    canslimPolicy({
      ...dossier,
      sourceFailures: ["float", "float", "quarter-eps"],
    })["data-coverage"].missing,
  ).toEqual([
    "财务披露时点与股本可比性未独立核验",
    "流通市值取数未成功",
    "季度每股收益取数未成功",
  ]);
  expect(canslimPolicy(dossier)["data-coverage"].missing).toEqual([
    "财务披露时点与股本可比性未独立核验",
  ]);
});
it("uses selected Codex, persists six stages and reuses the same evidence/method report", async () => {
  const a = await analyzeCanslimDossier(dossier);
  const b = await analyzeCanslimDossier(dossier);
  expect(a.model).toBe("codex:default");
  expect(a.method.files).toHaveLength(5);
  expect(a.result.stages.map((s) => s.id)).toEqual(canslimStageIds);
  expect(b.id).toBe(a.id);
  expect(state.calls).toBe(1);
});
it("rejects damaged cached evidence, method, policy and stage results without a paid retry", async () => {
  const report = await analyzeCanslimDossier(dossier);
  const mutations = [
    { ...report, model: "deepseek-chat" },
    { ...report, dossier: { ...dossier, id: "other" } },
    { ...report, method: { ...report.method, version: "other" } },
    { ...report, policy: {} },
    { ...report, tokens: -1 },
    { ...report, result: { ...report.result, citations: ["invented"] } },
    {
      ...report,
      result: { ...report.result, stages: report.result.stages.slice(1) },
    },
    {
      ...report,
      result: {
        ...report.result,
        stages: report.result.stages.map((s) => ({ ...s, missing: [] })),
      },
    },
  ];
  for (const value of mutations) {
    state.cache.set(report.id, value);
    await expect(analyzeCanslimDossier(dossier)).rejects.toThrow(
      "缓存报告校验失败",
    );
    expect(state.cache.get(report.id)).toBe(value);
  }
  expect(state.calls).toBe(1);
});
