import Database from "better-sqlite3";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StrategyObjectInput } from "trading-strategies";
import { settingsSchema } from "~/lib/domain";
import {
  alertKey,
  alertsSchema,
  effectiveMarketCapital,
  universalMarketSleeve,
  type AlertEvent,
} from "~/lib/strategy-facts/alerts";
import {
  extractCandidateTriggerReason,
  strategyMethodInfo,
} from "~/lib/strategy-facts/strategy-display";
import { put } from "~/server/db";
import { migrate } from "~/server/db/migrations";
import { AlertRepository } from "~/server/db/alert-repository";
import { previewAlertPlan } from "~/server/alerts/plans";
import {
  workspaceCandidate,
  workspaceCandidates,
} from "~/server/alerts/workspace";
import { CandidateTable } from "~/components/overview/candidate-table";
import { AlertSettings } from "~/components/signals/alert-settings";

vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ href, children }: { href: string; children: ReactNode }) =>
      createElement("a", { href }, children),
  };
});

const now = Date.parse("2026-11-13T08:00:00Z");

const lowZoneStrategy: StrategyObjectInput = {
  id: "r2a-cn-equity-historical-low-day-trailing-sizing-equal-neighbor-110",
  version: 1,
  market: "cn-equity",
  period: "day",
  universe: { kind: "symbols", symbols: ["sh600000"] },
  entry: { kind: "constant", value: true },
  exit: { stop: { kind: "fixed", fraction: 0.1 }, takeProfit: 0.3 },
  sizing: { kind: "weight", weight: 1 },
  sleeve: "low-zone",
};

const doubleBreakoutStrategy: StrategyObjectInput = {
  id: "r2a-cn-equity-double-breakout-day-atr",
  version: 1,
  market: "cn-equity",
  period: "day",
  universe: { kind: "symbols", symbols: ["sh600001"] },
  entry: { kind: "constant", value: true },
  exit: { stop: { kind: "fixed", fraction: 0.1 }, takeProfit: 0.3 },
  sizing: { kind: "weight", weight: 1 },
  sleeve: "swing",
};

function makeEvent(
  strategy: StrategyObjectInput,
  symbol: string,
  reason = "收盘扫描：明日计划候选；入场条件通过；价格分位 0.08 / 回撤 0.35",
): AlertEvent {
  const identity = {
    strategyId: strategy.id,
    version: strategy.version,
    market: strategy.market,
    symbol,
    bar: "2026-11-13",
  };
  return {
    ...identity,
    key: alertKey(identity),
    type: "entry",
    price: 10,
    stop: 9,
    target: 13,
    sleeve: strategy.sleeve,
    observedAt: now,
    mode: "shadow",
    status: "shadow",
    reason,
    source: "fixed synthetic input",
    wouldSend: false,
    outcomes: [],
  };
}

let db: Database.Database;
let repo: AlertRepository;

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  repo = new AlertRepository(db);
  repo.saveState("exposure", [
    { market: "cn-equity", sleeve: "__checked__", value: 0, at: now },
  ]);
});

afterEach(() => db.close());

describe("universal risk control", () => {
  it("falls back to default capital and market risk for unallocated sleeves without throwing", () => {
    const defaultConfig = settingsSchema.parse({});
    expect(defaultConfig.alerts.capital["cn-equity"]).toBe(0);
    expect(effectiveMarketCapital(defaultConfig.alerts, "cn-equity")).toBe(
      1_000_000,
    );
    expect(
      universalMarketSleeve(defaultConfig.alerts, "cn-equity", "low-zone"),
    ).toEqual({
      id: "low-zone",
      market: "cn-equity",
      share: 1,
      risk: 0.01,
    });

    put("settings", "settings", defaultConfig);
    repo.saveState(
      `candidate-scan:cn-equity:${lowZoneStrategy.id}:${lowZoneStrategy.version}`,
      { bar: "2026-11-13", period: "day", observedAt: now },
    );
    const e = makeEvent(lowZoneStrategy, "sh600000");
    repo.record(lowZoneStrategy, e);

    let plan: ReturnType<typeof previewAlertPlan> | undefined;
    expect(() => {
      plan = previewAlertPlan(
        {
          eventKey: e.key,
          stages: [10],
          stop: 9,
          target: 13,
          expiresAt: new Date(now + 86400000).toISOString(),
        },
        defaultConfig,
        now,
        repo,
      );
    }).not.toThrow("请先配置该分仓资金和目标份额");
    expect(plan!.quantity).toBeGreaterThan(0);

    const candidate = workspaceCandidate(e, repo, now);
    expect(candidate.quantity).toBe(plan!.quantity);
    expect(candidate.quantity).toBeGreaterThan(0);
    expect(candidate.quantityReason).toBeNull();
  });

  it("preserves explicit positive capital and positive sleeve share", () => {
    const custom = alertsSchema.parse({
      capital: { "cn-equity": 250_000, crypto: 25_000 },
      sleeves: [
        { id: "swing", market: "cn-equity", share: 0.6, risk: 0.015 },
        { id: "low-zone", market: "cn-equity", share: 0.4, risk: 0.02 },
      ],
    });

    expect(effectiveMarketCapital(custom, "cn-equity")).toBe(250_000);
    expect(effectiveMarketCapital(custom, "crypto")).toBe(25_000);
    expect(universalMarketSleeve(custom, "cn-equity", "low-zone")).toEqual({
      id: "low-zone",
      market: "cn-equity",
      share: 0.4,
      risk: 0.02,
    });
    expect(universalMarketSleeve(custom, "cn-equity", "swing")).toEqual({
      id: "swing",
      market: "cn-equity",
      share: 0.6,
      risk: 0.015,
    });
  });
});

describe("candidate selection method & trigger summary", () => {
  it("maps structured strategy IDs to method labels and extracts concise trigger reasons", () => {
    expect(
      strategyMethodInfo(
        "r2a-cn-equity-historical-low-day-trailing-sizing-equal-neighbor-110",
      ),
    ).toMatchObject({ family: "historical-low", label: "历史低位" });
    expect(
      strategyMethodInfo("r2a-cn-equity-double-breakout-day-atr"),
    ).toMatchObject({ family: "double-breakout", label: "双突破" });
    expect(
      strategyMethodInfo("r2a-cn-equity-chan-third-buy-day-atr"),
    ).toMatchObject({ family: "chan-third-buy", label: "缠论三买" });
    expect(
      strategyMethodInfo("r2a-cn-equity-formula-range-day-trailing"),
    ).toMatchObject({ family: "formula-range", label: "区间突破公式" });

    const detailed = extractCandidateTriggerReason({
      strategyId:
        "r2a-cn-equity-historical-low-day-trailing-sizing-equal-neighbor-110",
      bar: "2026-11-13",
      price: 10,
      stop: 9,
      target: 13,
      reason: "收盘扫描：明日计划候选；入场条件通过；价格分位 0.08 / 回撤 0.35",
    });
    expect(detailed).toBe(
      "长周期价格处于历史低分位且深度回撤后企稳修复（价格分位 0.08 · 回撤 0.35）",
    );

    const summaryOnly = extractCandidateTriggerReason({
      strategyId: "r2a-cn-equity-double-breakout-day-atr",
      bar: "2026-11-13",
      price: 10,
      stop: 9,
      target: 13,
      reason: "收盘扫描：明日计划候选；入场条件通过",
    });
    expect(summaryOnly).toBe("价格突破近期高点且均线/量能同步突破共振");
  });

  it("renders method badges, trigger summaries, and chart links in CandidateTable", () => {
    const defaultConfig = settingsSchema.parse({});
    put("settings", "settings", defaultConfig);
    for (const s of [lowZoneStrategy, doubleBreakoutStrategy]) {
      repo.saveState(`candidate-scan:cn-equity:${s.id}:${s.version}`, {
        bar: "2026-11-13",
        period: "day",
        observedAt: now,
      });
    }
    repo.record(lowZoneStrategy, makeEvent(lowZoneStrategy, "sh600000"));
    repo.record(
      doubleBreakoutStrategy,
      makeEvent(
        doubleBreakoutStrategy,
        "sh600001",
        "收盘扫描：明日计划候选；入场条件通过；突破20日高点",
      ),
    );

    const rows = workspaceCandidates({ page: 0 }, repo, now);
    const html = renderToStaticMarkup(
      createElement(CandidateTable, {
        data: rows.items,
        total: rows.total,
      }),
    );

    expect(html).toContain("【历史低位】");
    expect(html).toContain("【双突破】");
    expect(html).toContain("入选依据：");
    expect(html).toContain("价格分位 0.08 · 回撤 0.35");
    expect(html).toContain("突破20日高点");
    expect(html).toMatch(
      /<a\s+href="\/scan\?[^"]*symbol=sh600000[^"]*">sh600000 · 打开图表<\/a>/,
    );
    expect(html).toMatch(
      /<a\s+href="\/scan\?[^"]*symbol=sh600001[^"]*">sh600001 · 打开图表<\/a>/,
    );
  });
});

describe("universal risk settings UI", () => {
  it("renders universal capital and risk inputs without per-sleeve share inputs", () => {
    const html = renderToStaticMarkup(
      createElement(AlertSettings, {
        value: alertsSchema.parse({}),
        onChange: () => {},
      }),
    );

    expect(html).toContain("统一提醒与通用风控");
    expect(html).toContain("通用单笔最大风险（%）");
    expect(html).toContain("1000000");
    expect(html).not.toContain("cn-equity low-zone 目标份额%");
    expect(html).not.toContain("目标份额%");
  });
});
