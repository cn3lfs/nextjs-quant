import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { defaultBacktestCosts } from "~/lib/backtest/backtest-costs";
import {
  draftFromInput,
  draftMatchesInput,
  initialMaDraft,
  parseMaDraft,
} from "~/lib/backtest/ma-workspace";
import {
  MaReportEvidence,
  MaReportOverview,
  type BaselineReport,
} from "~/components/backtest/ma-experiment-report";
import { MaExperimentHistory } from "~/components/backtest/ma-experiment-history";

const input = {
  symbol: "sz000001",
  start: "2026-10-08",
  end: "2026-10-30",
  initial: 100000,
  costs: defaultBacktestCosts,
};
const report: BaselineReport = {
  summary: {
    strategy: { fast: 5, slow: 20, period: "5m" },
    engineVersion: "ts-backtest-foundation-1",
    engineHash: "engine-fixture",
    strategyId: "ma-cross-baseline-v1",
    quality: "rule-check-only",
    input,
    cash: 90000,
    shares: 1000,
    evaluated: 48,
    totalReturn: -0.25,
    maxDrawdown: 1.5,
    equity: [{ date: "2026-10-08", value: 99750 }],
    assumptions: ["T+1，末尾不强制平仓"],
  },
  manifest: {
    version: "ma-baseline-input-1",
    symbol: input.symbol,
    period: "5m",
    adjustment: "none",
    sourceFileHash: "source-fixture",
    dataHash: "data-fixture",
    calendarHash: "calendar-fixture",
    actionHash: "actions-fixture",
    start: "2026-10-08T09:35:00+08:00",
    end: "2026-10-08T15:00:00+08:00",
    warmupBars: 20,
    sourceMs: 125,
    computeMs: 3,
  },
  fills: [],
  fillCount: 0,
  orderCount: 1,
  rejectedCount: 0,
  pending: [
    {
      id: 1,
      side: "sell",
      signalAt: "2026-10-08T15:00:00+08:00",
      status: "pending",
      attempts: 2,
      reason: "T+1：当日买入不可卖出",
    },
  ],
};
describe("backtest experiment identity and readable input validation", () => {
  it("leaves an incomplete draft invalid, accepts explicit zero costs and never treats blanks as zero", () => {
    expect(
      parseMaDraft(initialMaDraft(input.symbol, input.end)).error,
    ).toContain("填写开始和结束日期");
    const draft = draftFromInput(input);
    expect(parseMaDraft(draft).input).toEqual(input);
    expect(
      parseMaDraft({
        ...draft,
        costs: { ...draft.costs, minimumCommission: "" },
      }).input,
    ).toBeNull();
    expect(
      parseMaDraft({
        ...draft,
        costs: { ...draft.costs, minimumCommission: "0" },
      }).input?.costs.minimumCommission,
    ).toBe(0);
    expect(parseMaDraft({ ...draft, initial: "" }).error).toContain("初始资金");
    expect(parseMaDraft({ ...draft, symbol: "sh688001" }).input).toBeNull();
    expect(parseMaDraft({ ...draft, start: "2026-02-30" }).error).toContain(
      "日期无效",
    );
    expect(parseMaDraft({ ...draft, start: "2026-11-01" }).error).toContain(
      "不能晚于",
    );
  });
  it("compares the full experiment input and cloning neither mutates nor executes the original", () => {
    const draft = draftFromInput(input);
    expect(draftMatchesInput(draft, input)).toBe(true);
    expect(draftMatchesInput({ ...draft, initial: "200000" }, input)).toBe(
      false,
    );
    expect(
      draftMatchesInput(
        { ...draft, costs: { ...draft.costs, slippageBps: "8" } },
        input,
      ),
    ).toBe(false);
    draft.costs.commissionBps = "10";
    expect(input.costs.commissionBps).toBe(3);
  });
});
it("shows sourced account values, pending reason and zero-fill explanation without invented metrics", () => {
  const html = renderToStaticMarkup(
    createElement(MaReportOverview, { data: report }),
  );
  for (const text of [
    "-0.25%",
    "1.50%",
    "90,000.00",
    "99,750.00",
    "本次实验没有成交",
    "T+1：当日买入不可卖出",
    "日末净值",
    "窗口结束不强制平仓",
  ])
    expect(html).toContain(text);
  expect(html).not.toContain("夏普");
  expect(html).not.toContain("胜率");
});
it("reproduction evidence belongs to the report rather than the editable draft", () => {
  const html = renderToStaticMarkup(
    createElement(MaReportEvidence, { data: report, id: "experiment-fixture" }),
  );
  for (const text of [
    "experiment-fixture",
    "2026-10-08 至 2026-10-30",
    "100,000.00",
    "engine-fixture",
    "data-fixture",
    "预热",
    "规则自检",
  ])
    expect(html).toContain(text);
});
it("history retains actual Chinese state and selection, including failed and cancelled experiments", () => {
  const html = renderToStaticMarkup(
    createElement(MaExperimentHistory, {
      entries: [
        {
          id: "failed-fixture",
          symbol: input.symbol,
          createdAt: 1,
          status: "failed",
        },
        {
          id: "cancelled-fixture",
          symbol: input.symbol,
          createdAt: 2,
          status: "cancelled",
        },
      ],
      selectedId: "failed-fixture",
      disabled: true,
      loading: false,
      onSelect() {},
      onRefresh() {},
    }),
  );
  expect(html).toContain("失败");
  expect(html).toContain("已取消");
  expect(html).toContain('aria-pressed="true"');
  expect(html).toContain("显示最近 20 个");
});
