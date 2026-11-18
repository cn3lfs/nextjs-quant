import { expect, it, vi } from "vitest";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const mockState = vi.hoisted(() => {
  const identity = "a".repeat(64);
  return {
    identity,
    list: {
      data: [
        {
          identity,
          version: "theory-study-ten-3" as const,
          account: { maxPositions: 10 as const, targetWeight: 0.1 as const },
          markets: ["crypto" as const],
          windows: [
            { label: "development", start: "2020-01-01", end: "2023-12-31" },
          ],
          scenarios: ["base"],
          includeBaseline: false,
          candidateCount: 1,
          expectedCheckpoints: 1,
          importedAt: Date.UTC(2026, 10, 18, 4),
          filename: `registration-${identity}.json`,
          byteLength: 100,
          checkpoints: { total: 1, completed: 0, blocked: 1, missing: 0 },
          status: "blocked" as const,
        },
      ],
      isLoading: false,
      error: null,
      refetch: () => {},
    },
    detail: {
      data: undefined,
      error: null,
      isFetching: false,
      refetch: () => {},
    },
  };
});
vi.mock("~/components/workbench/keep-alive", () => ({
  usePanelVisible: () => true,
}));
vi.mock("~/trpc/react", () => ({
  api: {
    strategyLabPortfolioEvidenceList: { useQuery: () => mockState.list },
    strategyLabPortfolioEvidenceDetail: {
      useQuery: (_input: unknown, options?: { enabled?: boolean }) =>
        options?.enabled
          ? mockState.detail
          : { ...mockState.detail, data: undefined },
    },
    strategyLabPortfolioEvidenceImport: {
      useMutation: () => ({
        mutate: () => {},
        reset: () => {},
        isPending: false,
        data: undefined,
        error: null,
      }),
    },
  },
}));
import {
  PortfolioEvidencePanel,
  RegistrationPanel,
} from "../../src/components/research/portfolio-evidence-panel";

it("offers explicit multi-file import and read-only evidence copy", () => {
  const html = renderToStaticMarkup(createElement(PortfolioEvidencePanel));
  expect(html).toContain('aria-label="十持仓研究证据"');
  expect(html).toContain('aria-label="选择十持仓登记或检查点文件"');
  expect(html).toMatch(/type="file"[^>]*multiple=""/);
  expect(html).toContain("不登记或晋级策略、不改变影子与 live");
  expect(html).toContain("按哈希查看");
  expect(html).toContain("v3（完整执行依赖）");
  expect(html).not.toContain("theory-study-ten-3");
  expect(html).toContain("不表示收益资格、独立留出或真实成交");
});

it("shows the registration version and binding roles instead of guessing by id", () => {
  const identity = "b".repeat(64);
  const key = {
    market: "cn-equity" as const,
    strategyId: "source-sw-macd-red",
    window: "development",
    scenario: "base" as const,
  };
  const detail = {
    type: "registration" as const,
    identity,
    importedAt: Date.UTC(2026, 10, 18, 4),
    filename: `registration-${identity}.json`,
    byteLength: 100,
    registration: {
      version: "theory-study-ten-3" as const,
      strategyBuildHash: "1".repeat(64),
      engineBuildHash: "source-development",
      execution: {
        runner: { path: "scripts/theory-study.ts", hash: "2".repeat(64) },
        definitions: [],
        artifacts: { roots: ["src"], hash: "3".repeat(64) },
        lockfile: { path: "pnpm-lock.yaml", hash: "4".repeat(64) },
      },
      account: { maxPositions: 10 as const, targetWeight: 0.1 as const },
      markets: ["cn-equity" as const],
      windows: [
        { label: "development", start: "2020-01-01", end: "2023-12-31" },
      ],
      scenarios: ["base" as const],
      includeBaseline: false,
      candidates: ["entry5-sw-macd-red", "source-sw-macd-red", "rsi2"],
    },
    candidateRoles: [
      {
        strategyId: "entry5-sw-macd-red",
        role: "entry-experiment" as const,
        preset: "sw-macd-red",
        note: null,
      },
      {
        strategyId: "source-sw-macd-red",
        role: "source-exit" as const,
        preset: "sw-macd-red",
        note: null,
      },
      {
        strategyId: "rsi2",
        role: "unbound" as const,
        preset: null,
        note: null,
      },
    ],
    expectedCheckpoints: 3,
    checkpoints: [
      {
        identity,
        key,
        keyHash: "5".repeat(64),
        contentHash: "6".repeat(64),
        status: "completed" as const,
        reason: null,
        importedAt: Date.UTC(2026, 10, 18, 4),
        filename: "checkpoint.json",
        byteLength: 10,
        evidenceId: "research-portfolio:checkpoint:fixture",
        role: "source-exit" as const,
      },
    ],
    counts: { total: 1, completed: 1, blocked: 0, missing: 2 },
    status: "partial" as const,
  } satisfies ComponentProps<typeof RegistrationPanel>["detail"];
  const html = renderToStaticMarkup(
    createElement(RegistrationPanel, { detail, onOpen: () => {} }),
  );
  expect(html).toContain("v3（完整执行依赖）");
  expect(html).toContain("theory-study-ten-3");
  expect(html).toContain("候选策略（按集中绑定区分角色）");
  expect(html).toContain("entry5-sw-macd-red · 入场实验 · sw-macd-red");
  expect(html).toContain("source-sw-macd-red · 原始出场 · sw-macd-red");
  expect(html).toContain("rsi2 · 未绑定");
  expect(html).toContain("原始出场");
});

it("labels the frozen v2 registration version for older evidence", () => {
  const identity = "c".repeat(64);
  const detail = {
    type: "registration" as const,
    identity,
    importedAt: Date.UTC(2026, 10, 18, 4),
    filename: `registration-${identity}.json`,
    byteLength: 100,
    registration: {
      version: "theory-study-ten-2" as const,
      account: { maxPositions: 10 as const, targetWeight: 0.1 as const },
      markets: ["cn-equity" as const],
      windows: [
        { label: "development", start: "2020-01-01", end: "2023-12-31" },
      ],
      scenarios: ["base" as const],
      includeBaseline: false,
      candidates: ["source-sw-macd-negative"],
    },
    candidateRoles: [
      {
        strategyId: "source-sw-macd-negative",
        role: "source-exit" as const,
        preset: "sw-macd-negative",
        note: null,
      },
    ],
    expectedCheckpoints: 1,
    checkpoints: [],
    counts: { total: 0, completed: 0, blocked: 0, missing: 1 },
    status: "pending" as const,
  } satisfies ComponentProps<typeof RegistrationPanel>["detail"];
  const html = renderToStaticMarkup(
    createElement(RegistrationPanel, { detail, onOpen: () => {} }),
  );
  expect(html).toContain("v2（冻结身份）");
  expect(html).toContain("theory-study-ten-2");
  expect(html).not.toContain("v3（完整执行依赖）");
});

it("shows imported blocked evidence without treating it as completed", () => {
  const html = renderToStaticMarkup(createElement(PortfolioEvidencePanel));
  expect(html).toContain("预期 / 已导入");
  expect(html).toContain("blocked（不构成成功证据）");
  expect(html).not.toContain("证据行已导入");
});
