import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  result: undefined as unknown,
  activity: undefined as unknown,
  tasks: [] as unknown[],
  history: [] as unknown[],
  cancelError: null as Error | null,
}));
vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({
      financialReplayHistory: { invalidate: vi.fn() },
      financialReplayTasks: { invalidate: vi.fn() },
      financialReplayExport: { fetch: vi.fn() },
    }),
    financialReplayHistory: {
      useQuery: () => ({ data: state.history, error: null }),
    },
    financialReplayTasks: {
      useQuery: () => ({ data: state.tasks, error: null }),
    },
    financialReplayStart: {
      useMutation: () => ({ mutate: vi.fn(), isPending: false, error: null }),
    },
    financialReplayResult: {
      useQuery: () => ({ data: state.result, error: null }),
    },
    financialReplayActivity: {
      useQuery: () => ({ data: state.activity, error: null }),
    },
    job: { useQuery: () => ({ data: undefined, error: null }) },
    cancel: {
      useMutation: () => ({
        mutate: vi.fn(),
        error: state.cancelError,
      }),
    },
  },
}));
vi.mock("~/components/workbench/keep-alive", () => ({
  usePanelVisible: () => true,
}));
import { FinancialReplayPanel } from "~/components/financial/financial-replay-panel";

const hash = (letter: string) => letter.repeat(64);
const readiness = {
  asOf: "2026-11-02",
  evaluatedAt: "2026-11-17T10:00:00Z",
  instrument: "sh600000",
  market: "cn-equity",
  axes: [
    "engineering",
    "ruleCheck",
    "dataQualification",
    "independentValidation",
    "forwardObservation",
  ],
  engineering: { status: "runnable", reason: null },
  ruleCheck: {
    status: "checked",
    evaluated: true,
    evidenceRef: "financial-replay:test",
    checkedAt: "2026-11-17T10:00:00Z",
    completeSlots: 3,
    incompleteSlots: 0,
    reason: null,
  },
  dataQualification: {
    status: "partial",
    series: [],
    source: {
      adjustmentId: hash("a"),
      calendarHash: hash("b"),
      consistent: true,
    },
    window: { start: "2025-12-31", end: "2026-11-02" },
    warmup: { decisionStart: "2026-01-05", series: [], status: "met" },
    financial: { status: "complete", requiredFacts: 1, missingFacts: [] },
    pointInTime: { status: "limited", reason: "当前成分与修订版财报" },
    reasons: ["时点受限"],
  },
  independentValidation: {
    status: "unknown",
    holdoutStart: null,
    holdoutEnd: null,
    touchedRanges: [],
    checks: {
      total: 0,
      independent: 0,
      evidenced: 0,
      passed: 0,
      failed: 0,
      unknown: 0,
    },
    reason: "未提供留出",
  },
  forwardObservation: {
    status: "unknown",
    source: null,
    evidenceRef: null,
    observedDays: null,
    declaredDays: null,
    firstDate: null,
    lastDate: null,
    minimumDays: null,
    reason: "未提供前向观察",
  },
  disclaimer: "各轴独立",
};
const blockedResult = {
  version: "financial-replay-v1",
  id: `financial-replay-${hash("c")}`,
  identity: hash("c"),
  annualIdentity: hash("d"),
  hash: hash("e"),
  createdAt: Date.now(),
  status: "blocked",
  input: {
    symbols: ["sh600000", "sz000001"],
    firstYear: 2026,
    lastYear: 2026,
    endDate: "2026-11-02",
    initial: 1000000,
    costScenario: "base",
    preset: "magic-formula",
  },
  config: {
    version: "financial-replay-v1",
    root: "E:/tdx",
    calendarHash: hash("b"),
    poolHash: hash("f"),
    researchCodeHash: hash("1"),
    financialSourceHash: hash("2"),
    strategyId: "financial-replay-magic-annual",
  },
  years: [
    {
      year: 2026,
      asOf: "2025-12-31",
      executeAt: "2026-01-05",
      hash: hash("3"),
      status: "blocked",
      reason: "该年度没有可见的年度财报，不能生成年度目标",
      counts: {
        total: 2,
        annualReport: 0,
        fScoreComplete: 0,
        magicEligible: 0,
      },
      complete: { annualReport: 0, fScore: 0, magic: 0 },
      positions: 0,
      cashWeight: null,
      selected: [],
      issues: [],
    },
  ],
  blockedReason:
    "年度证据不足：2026年（该年度没有可见的年度财报）。未执行组合回放。",
  boundary: "规则自检；当前成分与修订版财报未认证",
  warnings: ["2025-12-31 完整事实 F-score 0/2、魔法 0/2；其余为缺失或排除"],
  readinessByInstrument: [{ symbol: "sh600000", readiness }],
  diagnostics: {
    actualCalls: 1,
    restoredCheckpoints: 0,
    checkedAt: "2026-11-17T10:00:00Z",
  },
};
const completedResult = {
  ...blockedResult,
  status: "completed",
  blockedReason: null,
  summary: {
    performance: {
      totalReturn: { value: 0.12 },
      annualReturn: { value: 0.12 },
      maxDrawdown: { value: 0.05 },
      sharpe: { value: 1.2 },
    },
    buys: 1,
    sells: 0,
    fees: 5,
    rejections: 0,
    observations: 3,
    openPositions: 1,
  },
};
const activity = {
  id: completedResult.id,
  status: "completed",
  initial: 1000000,
  equity: [
    { date: "2026-01-05", value: 1000000 },
    { date: "2026-01-06", value: 1120000 },
  ],
  summary: completedResult.summary,
  fills: {
    rows: [
      {
        orderId: 1,
        symbol: "sh600000",
        side: "buy",
        date: "2026-01-05",
        price: 10,
        quantity: 50000,
        fee: 5,
        cashAfter: 500000,
      },
    ],
    total: 1,
    pageIndex: 0,
    pageSize: 20,
  },
  rejections: { rows: [], total: 0, pageIndex: 0, pageSize: 20 },
};
function render(initialReportId?: string) {
  return renderToStaticMarkup(
    createElement(FinancialReplayPanel, {
      symbol: "sh600519",
      defaultSymbols: ["sh600000", "sz000001"],
      initialReportId,
    }),
  );
}
beforeEach(() => {
  state.result = undefined;
  state.activity = undefined;
  state.tasks = [];
  state.history = [];
  state.cancelError = null;
});

describe("financial replay UI", () => {
  it("shows Chinese readiness labels, evidence details, tasks and surfaced errors", () => {
    state.result = blockedResult;
    state.cancelError = new Error("取消回放失败");
    state.tasks = [
      {
        id: "job-financial-1",
        status: "cancelled",
        progress: 3,
        phase: "准备财务来源身份",
        error: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        input: blockedResult.input,
        reportId: null,
      },
    ];
    const html = render(blockedResult.id);
    expect(html).toContain("多年财务组合回放");
    expect(html).toContain("带入当前筛选 2 只");
    expect(html).toContain("可运行");
    expect(html).toContain("已检查");
    expect(html).toContain("部分合格");
    expect(html).not.toMatch(/\brunnable\b/);
    expect(html).not.toMatch(/\bpartial\b/);
    expect(html).toContain("时点受限");
    expect(html).toContain("冻结身份与运行诊断");
    expect(html).toContain("取消回放失败");
    expect(html).toContain('aria-label="财务回放任务"');
    expect(html).toContain("完整事实 F-score 0/2");
    expect(html).toContain(blockedResult.blockedReason);
  });

  it("renders the shared equity and fill/rejection result view for completed runs", () => {
    state.result = completedResult;
    state.activity = activity;
    const html = render(completedResult.id);
    expect(html).toContain("规则自检完成（非可信业绩）");
    expect(html).toContain("累计收益");
    expect(html).toContain("成交 1");
    expect(html).toContain("拒绝 0");
    expect(html).toContain("sh600000");
    expect(html).not.toContain("已恢复该任务");
  });

  it("does not re-display a previous completed report when reportId is empty", () => {
    // A stale result query can still hold the previous report. With no
    // reportId, the render guard must hide that completed result.
    state.result = completedResult;
    state.activity = activity;
    const html = render();
    expect(html).not.toContain("规则自检完成（非可信业绩）");
    expect(html).not.toContain("导出完整冻结回放");
    expect(html).not.toContain("已恢复该任务");
    expect(html).toContain("运行多年财务回放");
  });
});
