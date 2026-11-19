import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { strategyObjectSchema } from "trading-strategies";
import type { Job } from "~/lib/domain";
import type { ShadowRegistration } from "~/server/alerts/shadow";
import { strategyLabRouter } from "~/server/api/routers/strategy-lab";
import { AlertRepository } from "~/server/db/alert-repository";
import { ForwardReferenceRepository } from "~/server/db/forward-reference-repository";
import { saveJob } from "~/server/db/jobs";
import { migrate } from "~/server/db/migrations";
import { PaperRepository } from "~/server/db/paper-repository";
import {
  strategyLabCompareRuns,
  strategyLabDetail,
} from "~/server/db/strategy-lab";
import type { PaperAccount } from "~/server/paper/model";

const buildHash = vi.hoisted(() => "b".repeat(64));
// Control the worker identity independently of the persisted evidence and gates.
vi.mock("~/server/research/forward-identity", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("~/server/research/forward-identity")
  >()),
  forwardExecutionBuildHash: () => buildHash,
}));

const strategy = strategyObjectSchema.parse({
  id: "unified-lab",
  version: 2,
  market: "cn-equity",
  period: "day",
  sleeve: "swing",
  universe: { kind: "symbols", symbols: ["sh600000", "sz000001"] },
  entry: { kind: "constant", value: true },
  exit: {},
  sizing: { kind: "weight", weight: 0.2 },
});
const window = { start: "2026-10-01", end: "2026-11-13", initial: 1000 };
const portfolio = {
  request: {
    ...window,
    market: "cn-equity",
    strategies: [strategy],
    instruments: [
      { symbol: "sh600000", actions: [], execution: { step: 100 } },
      { symbol: "sz000001", actions: [], execution: { step: 100 } },
    ],
    calendar: ["2026-11-12", window.end],
    costs: { commission: 0.001 },
    sleeves: [{ id: "swing", share: 1 }],
  },
  marketPolicy: { execution: "raw" },
  costScenario: "base",
  strategyBuildHash: buildHash,
  executionBuildHash: buildHash,
  sources: [
    { symbol: "sh600000", hash: "source-a" },
    { symbol: "sz000001", hash: "source-b" },
  ],
};

function archivedJob(
  id: string,
  type: "lab-backtest" | "strategy-center",
  frozen: object,
  finalEquity: number,
) {
  return {
    id,
    type: "backtest",
    status: "completed",
    progress: 100,
    createdAt: 1,
    updatedAt: 2,
    input: { type },
    result: {
      frozen,
      inputHash: createHash("sha256")
        .update(JSON.stringify(frozen))
        .digest("hex"),
      result: { curve: [{ date: window.end, equity: finalEquity }], fills: [] },
      inputDiagnostics: [],
    },
  } satisfies Job;
}

it("shows the first lifecycle blocker at each stage and makes live authorization a separate version-specific switch", () => {
  const db = new Database(":memory:");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-14T00:00:00Z"));
  try {
    migrate(db);
    const repo = new AlertRepository(db);
    const paper = new PaperRepository(db);
    const references = new ForwardReferenceRepository(db);
    const inspect = () => strategyLabDetail(strategy.id, 2, repo);
    const keys = [
      "definition",
      "backtest",
      "comparison",
      "paper",
      "shadow",
      "promotion",
    ];
    const checkBlocker = (
      stage: number,
      status: "current" | "blocked",
      reason: string,
    ) => {
      const detail = inspect();
      expect(detail.lifecycleGates.map((gate) => gate.key)).toEqual(keys);
      expect(detail.lifecycleGates.map((gate) => gate.status)).toEqual(
        keys.map((_, index) =>
          index < stage - 1
            ? "passed"
            : index === stage - 1
              ? status
              : "pending",
        ),
      );
      expect(detail.primaryBlocker).toEqual({
        key: keys[stage - 1],
        stage,
        reason,
      });
      return detail;
    };
    const run = archivedJob("selected-run", "lab-backtest", portfolio, 1100);
    const inputHash = run.result.inputHash;
    repo.strategies.saveStrategy(strategy);
    repo.saveState("strategy:unified-lab:1", { live: true });
    expect(
      checkBlocker(1, "current", "策略已登记，缺少冻结输入哈希").liveSwitch,
    ).toMatchObject({ enabled: false, manual: true });
    repo.records.save(
      "validation-scoreboard",
      "validation-scoreboard-cn-equity",
      {
        rows: [
          {
            id: strategy.id,
            strategyVersion: 2,
            level: "strategy",
            evidence: { inputHash },
          },
        ],
      },
    );
    checkBlocker(2, "blocked", "缺少该版本已完成的权益、成交和诊断记录");
    repo.records.save("job", run.id, run);
    checkBlocker(3, "blocked", "尚未找到同口径的已完成对照任务");

    const baseline = {
      ...portfolio,
      request: {
        ...portfolio.request,
        strategies: [{ ...strategy, id: "peer-strategy" }],
      },
    };
    const differentCost = archivedJob(
      "different-cost",
      "lab-backtest",
      {
        ...baseline,
        request: { ...baseline.request, costs: { commission: 0.002 } },
      },
      1000,
    );
    repo.records.save("job", differentCost.id, differentCost);
    checkBlocker(3, "blocked", "尚未找到同口径的已完成对照任务");
    const peer = archivedJob("matched-peer", "lab-backtest", baseline, 1010);
    repo.records.save("job", peer.id, peer);
    const fourth = checkBlocker(4, "blocked", "未登记同版本纸面账户");
    expect(fourth.lifecycleGates[2]?.evidence).toEqual([run.id, peer.id]);
    expect(fourth.liveSwitch).toMatchObject({ enabled: false, manual: true });

    const reference = references.freeze({
      strategy,
      distribution: {
        days: [{ date: window.end, return: 0.1, signals: 1 }],
        tradeReturns: [],
        slippageBps: [],
      },
      inputHash,
      resultHash: "c".repeat(64),
      buildHash,
      initial: 1000,
      sizingPolicyHash: "d".repeat(64),
      backtestPassed: true,
      method: "lifecycle-2",
      purpose: "preregistered",
      slippageBasis: "paper-model",
      source: "controlled",
    });
    const shadow: ShadowRegistration = {
      startedAt: Date.parse("2026-11-15T00:00:00Z"),
      status: "shadow-candidate",
      active: false,
      trialSharpes: [],
      neighbors: [],
      sizing: "equal",
      completeMarketCycles: 0,
      lowZoneCorroborated: false,
    };
    const summary = {
      return: 0,
      drawdown: 0,
      trades: 0,
      winRate: null,
      benchmarkReturn: 0,
      signals: 29,
      days: 59,
      assessment: null,
    };
    const account: PaperAccount = {
      id: "forward-account",
      market: "cn-equity",
      currency: "CNY",
      sleeve: "swing",
      startedAt: shadow.startedAt,
      initial: 1000,
      candidates: [
        {
          strategy,
          row: {
            id: strategy.id,
            strategyVersion: 2,
            level: "strategy",
            market: "cn-equity",
            sleeve: "swing",
            rule: "controlled",
            status: "shadow-candidate",
            return: null,
            excess: null,
            drawdown: null,
            trades: 0,
            oosWindows: 0,
            positiveWindows: 0,
            bias: {
              universe: "fixture",
              adjustment: "fixture",
              financial: "fixture",
              execution: "fixture",
            },
            reasons: [],
          },
          registration: shadow,
          expectation: { windows: [], holdout: null },
        },
      ],
      mirror: { venue: "off" },
      mirrorRevision: "fixture",
      revision: 0,
      lastBar: null,
      lastRun: null,
      error: null,
      summary,
    };
    references.bindPaper(account.id, strategy, account.startedAt);
    paper.create(account);
    checkBlocker(4, "current", "纸面账户观察样本不足");
    paper.save({ ...account, summary: { ...summary, signals: 30 } }, 0);
    checkBlocker(5, "blocked", "尚未登记影子观察");
    repo.saveState("shadow:unified-lab:2", shadow);
    checkBlocker(5, "current", "影子观察已暂停");

    repo.saveState("shadow:unified-lab:2", { ...shadow, active: true });
    repo.saveState("strategy:unified-lab:2", { live: true });
    const sixth = checkBlocker(6, "blocked", "同版本前推一致性门槛未通过");
    expect(sixth.liveSwitch).toMatchObject({ enabled: true, manual: true });

    const observed = paper.account(account.id)!;
    paper.save(
      {
        ...observed,
        summary: {
          ...summary,
          signals: 30,
          assessment: {
            method: "forward-conformance-1",
            verdict: "conforming",
            eligible: true,
            referenceHash: reference.contentHash,
            recommendation: "合成观察通过",
            reasons: [],
          },
        },
      },
      observed.revision,
    );
    checkBlocker(6, "current", "可晋级，等待人工确认");
    repo.saveState("strategy:unified-lab:2", { live: false });
    repo.saveState("promotion:unified-lab:2", {
      at: shadow.startedAt,
      inputHash,
      reasons: [],
    });
    const promoted = inspect();
    expect(promoted.lifecycleGates.map((gate) => gate.status)).toEqual(
      Array(6).fill("passed"),
    );
    expect(promoted.primaryBlocker).toBeNull();
    expect(promoted.liveSwitch).toEqual({
      enabled: false,
      manual: true,
      summary: "此版本的 live 提醒未开启",
    });
  } finally {
    vi.useRealTimers();
    db.close();
  }
});

const portfolioRun = archivedJob(
  "portfolio-run",
  "lab-backtest",
  portfolio,
  1100,
);
const centerRun = archivedJob(
  "center-run",
  "strategy-center",
  {
    input: {
      ...window,
      start: "2026-11-01",
      symbol: "sh600000",
      strategyId: "center-strategy",
    },
    strategyObject: { id: "center-strategy", version: 3 },
    version: "strategy-center-input-1",
    strategyBuildHash: buildHash,
    engineVersion: buildHash,
    sourceHash: "center-source",
    options: { commission: 0.003 },
  },
  950,
);

it("compares archived strategy-center and portfolio runs in requested order with precise basis warnings", async () => {
  saveJob(portfolioRun);
  saveJob(centerRun);
  const caller = strategyLabRouter.createCaller({ headers: new Headers() });
  const rows = await caller.strategyLabCompareRuns({
    ids: [centerRun.id, portfolioRun.id],
  });
  expect(
    rows.map(
      ({
        id,
        kind,
        strategyId,
        strategyVersion,
        start,
        end,
        symbolCount,
        costScenario,
      }) => ({
        id,
        kind,
        strategyId,
        strategyVersion,
        start,
        end,
        symbolCount,
        costScenario,
      }),
    ),
  ).toEqual([
    {
      id: "center-run",
      kind: "strategy-center",
      strategyId: "center-strategy",
      strategyVersion: 3,
      start: "2026-11-01",
      end: window.end,
      symbolCount: 1,
      costScenario: null,
    },
    {
      id: "portfolio-run",
      kind: "lab-backtest",
      strategyId: "unified-lab",
      strategyVersion: 2,
      start: window.start,
      end: window.end,
      symbolCount: 2,
      costScenario: "base",
    },
  ]);
  // 同为初始资金 1000，收益分别为 950/1000−1 = −5% 与 1100/1000−1 = 10%。
  expect(rows[0]?.metrics.totalReturn.value).toBeCloseTo(-0.05, 12);
  expect(rows[1]?.metrics.totalReturn.value).toBeCloseTo(0.1, 12);
  const mismatches = [
    "任务类型不同",
    "起止日期不同",
    "证券池不同",
    "费用情景不同",
    "费用与成交假设不同",
    "行情来源与公司行动不同",
    "交易日历不同",
    "分仓风控不同",
  ];
  expect(rows[0]?.basisWarnings).toEqual(["费用情景名称未冻结", ...mismatches]);
  expect(rows[1]?.basisWarnings).toEqual(mismatches);
});

it("keeps comparable assumptions warning-free even when strategies and returns differ", () => {
  const peer = archivedJob(
    "same-basis",
    "lab-backtest",
    {
      ...portfolio,
      request: {
        ...portfolio.request,
        strategies: [{ ...strategy, id: "same-basis-peer" }],
      },
    },
    900,
  );
  const jobs = new Map([
    [portfolioRun.id, portfolioRun],
    [peer.id, peer],
  ]);
  const rows = strategyLabCompareRuns([portfolioRun.id, peer.id], (id) =>
    jobs.get(id),
  );
  expect(rows.map(({ basisWarnings }) => basisWarnings)).toEqual([[], []]);
});

it("rejects an unfinished selected run and fewer than two IDs at the comparison API boundary", async () => {
  saveJob(portfolioRun);
  saveJob({ ...centerRun, status: "running" });
  const caller = strategyLabRouter.createCaller({ headers: new Headers() });
  await expect(
    caller.strategyLabCompareRuns({ ids: [portfolioRun.id, centerRun.id] }),
  ).rejects.toThrow("仅支持已完成的策略中心或实验室回测任务：center-run");
  for (const ids of [[], [portfolioRun.id]]) {
    await expect(caller.strategyLabCompareRuns({ ids })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      cause: {
        issues: [
          expect.objectContaining({
            code: "too_small",
            minimum: 2,
            path: ["ids"],
          }),
        ],
      },
    });
  }
});
