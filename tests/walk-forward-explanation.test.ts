import { beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const state = vi.hoisted(() => ({ local: vi.fn(), paid: vi.fn() }));
vi.mock("../src/server/local-llm", () => ({ localCompletion: state.local }));
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: state.paid } };
  },
}));
import {
  perBarReturn,
  walkForwardEvidence,
  explainWalkForwardJob,
} from "../src/server/walk-forward-explanation";
import { walkForward } from "../src/server/walk-forward";
import {
  defaultStrategy,
  type Snapshot,
  type Job,
  type Report,
} from "../src/lib/domain";
import { defaultBacktestCosts } from "../src/lib/backtest-costs";
import { get, put, sqlite, list } from "../src/server/db";
import { cancelJob } from "../src/server/jobs";
process.env.QUANT_DATA_DIR = mkdtempSync(join(tmpdir(), "quant-wf-explain-"));
const source: Snapshot = {
  id: "snapshot-fixture",
  symbol: "sh600000",
  period: "day",
  source: "fixture",
  adjustment: "none",
  hash: "f".repeat(64),
  createdAt: 1,
  bars: Array.from({ length: 180 }, (_, i) => ({
    date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
    open: 100 + i,
    close: 101 + i,
    high: 102 + i,
    low: 99 + i,
    volume: 100000,
    amount: 10000000,
  })),
};
const record = {
  ...walkForward(source, defaultStrategy, 1000, defaultBacktestCosts, {
    trainBars: 60,
    testBars: 20,
  }),
  id: "walk-forward-00000000-0000-4000-8000-000000000001",
  createdAt: Date.now(),
};
const reply = () => ({
  text: JSON.stringify({
    title: "样本外解读",
    summary: "无成交不能当作稳健",
    supporting: [],
    opposing: [],
    risks: ["研究模拟"],
    missing: ["独立验证"],
    nextSteps: ["检查资金约束"],
    citations: [walkForwardEvidence(record).id],
  }),
  tokens: 10,
});
beforeEach(() => {
  sqlite().prepare("DELETE FROM records").run();
  put("settings", "settings", { llmProvider: "codex" });
  put("walk-forward", record.id, record);
  state.local.mockReset();
  state.paid.mockReset();
});
it("按根数归一化而非直接比较不同长度总收益，并明确零成交与资金不足", () => {
  expect(perBarReturn(10, 10)).toBeCloseTo(perBarReturn(21, 20)!, 10);
  expect(perBarReturn(-100, 20)).toBeNull();
  expect(perBarReturn(5, 0)).toBeNull();
  const evidence = walkForwardEvidence(record),
    payload = JSON.parse(evidence.text);
  expect(payload.diagnostics.zeroTradeFolds).toBe(record.folds.length);
  expect(payload.diagnostics.insufficientCashFolds).toBe(record.folds.length);
  expect(
    Object.values(payload.diagnostics.parameterFrequency).reduce(
      (sum: number, n) => sum + Number(n),
      0,
    ),
  ).toBe(record.folds.length);
  expect(payload.folds[0].trainPerBarReturn).toBe(0);
  expect(evidence.envelope?.warnings.join(" ")).toContain("不能直接");
  expect(() => walkForwardEvidence({ ...record, folds: [] })).toThrow("不完整");
});
it("并发点击合并，完成后复用报告且不调用DeepSeek", async () => {
  state.local.mockResolvedValue(reply());
  const first = explainWalkForwardJob(record.id),
    second = explainWalkForwardJob(record.id);
  expect(first.id).toBe(second.id);
  await vi.waitFor(() => expect(get<Job>(first.id)?.status).toBe("completed"));
  const original = (get<Job>(first.id)!.result as Report).id;
  const again = explainWalkForwardJob(record.id);
  await vi.waitFor(() => expect(get<Job>(again.id)?.status).toBe("completed"));
  expect((get<Job>(again.id)!.result as Report).id).toBe(original);
  expect(state.local).toHaveBeenCalledTimes(1);
  expect(state.paid).not.toHaveBeenCalled();
});
it("keeps gross price return distinct from net cash benchmark and does not manufacture missing legacy results", () => {
  const before = JSON.stringify(record);
  const payload = JSON.parse(walkForwardEvidence(record).text);
  expect(payload.version).toBe("walk-forward-explanation-2");
  expect(payload.folds[0].benchmarkGrossReturn).toBeGreaterThan(0);
  expect(payload.folds[0].buyHoldNet).toMatchObject({
    totalReturn: 0,
    excessReturnPoints: 0,
    entry: null,
    cash: 1000,
    shares: 0,
  });
  const legacy = structuredClone(record);
  for (const fold of legacy.folds) delete fold.test.benchmark;
  const oldPayload = JSON.parse(walkForwardEvidence(legacy).text);
  expect(
    oldPayload.folds.every(
      (f: { buyHoldNet: unknown }) => f.buyHoldNet === null,
    ),
  ).toBe(true);
  expect(oldPayload.folds[0].benchmarkGrossReturn).toBe(
    payload.folds[0].benchmarkGrossReturn,
  );
  expect(walkForwardEvidence(legacy).id).not.toBe(
    walkForwardEvidence(record).id,
  );
  expect(JSON.stringify(record)).toBe(before);
});
it("固定创建时的模型，取消后迟到的结果不写报告", async () => {
  let release!: (value: ReturnType<typeof reply>) => void;
  state.local.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const job = explainWalkForwardJob(record.id);
  put("settings", "settings", { llmProvider: "claude" });
  await vi.waitFor(() => expect(state.local).toHaveBeenCalledTimes(1));
  expect(state.local.mock.calls[0]![0]).toBe("codex");
  cancelJob(job.id);
  release(reply());
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(get<Job>(job.id)?.status).toBe("cancelled");
  expect(list("report")).toHaveLength(0);
  expect(state.paid).not.toHaveBeenCalled();
});
