import {
  createElement,
  type ComponentProps,
  type FormEvent,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  deploymentProvenanceSchema,
  strategyObjectSchema,
} from "trading-strategies";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SimTradeRow } from "~/lib/portfolio/sim-accounts";
import type { IntradayAlertStatus } from "~/lib/strategy-facts/intraday-alerts";
import type { RouterOutputs } from "~/trpc/react";

const fixture = vi.hoisted(() => ({
  search: new URLSearchParams(),
  props: [] as { name: string; props: Record<string, unknown> }[],
  report: undefined as unknown,
  deployment: undefined as unknown,
  linkedDeployment: undefined as unknown,
  run: undefined as unknown,
  alert: undefined as unknown,
  runNow: vi.fn(),
  saveConfig: vi.fn(),
  saveRule: vi.fn(),
  deleteRule: vi.fn(),
  shortfall: vi.fn(),
  preview: vi.fn(),
  confirm: vi.fn(),
  deploy: vi.fn(),
  refreshAlerts: vi.fn(),
  refreshChartPosition: vi.fn(),
  refreshChartReview: vi.fn(),
  refreshLedger: vi.fn(),
}));

// Capture the handlers behind the SSR markup so Vitest's Node project can
// exercise submitted values and RPC calls without a browser or real account.
vi.mock("react/jsx-runtime", async (load) => {
  const actual = await load<typeof import("react/jsx-runtime")>();
  const capture =
    (render: typeof actual.jsx): typeof actual.jsx =>
    (type, props, key) => {
      const name = typeof type === "function" ? type.name : String(type);
      fixture.props.push({ name, props: props as Record<string, unknown> });
      return render(type, props, key);
    };
  return { ...actual, jsx: capture(actual.jsx), jsxs: capture(actual.jsxs) };
});
vi.mock("react/jsx-dev-runtime", async (load) => {
  const actual = await load<typeof import("react/jsx-dev-runtime")>();
  const jsxDEV: typeof actual.jsxDEV = (type, props, ...rest) => {
    const name = typeof type === "function" ? type.name : String(type);
    fixture.props.push({ name, props: props as Record<string, unknown> });
    return actual.jsxDEV(type, props, ...rest);
  };
  return { ...actual, jsxDEV };
});

vi.mock("next/navigation", () => ({
  useSearchParams: () => fixture.search,
}));

vi.mock("~/components/ui/dialog", async (load) => {
  const actual = await load<typeof import("~/components/ui/dialog")>();
  return {
    ...actual,
    Dialog: ({ children }: { children: ReactNode }) => children,
    DialogTrigger: ({ children }: { children: ReactNode }) => children,
    DialogContent: ({ children }: { children: ReactNode }) => children,
    DialogTitle: ({ children }: { children: ReactNode }) =>
      createElement("h2", null, children),
    DialogDescription: ({ children }: { children: ReactNode }) =>
      createElement("div", null, children),
  };
});

vi.mock("~/trpc/react", () => {
  const query = (data?: unknown) => ({ data, isPending: false });
  const mutation = (mutate = vi.fn()) => ({
    mutate,
    isPending: false,
    reset: vi.fn(),
  });
  return {
    api: {
      useUtils: () => ({
        intradayAlertOverview: { invalidate: fixture.refreshAlerts },
        chartPosition: { invalidate: fixture.refreshChartPosition },
        chartTradeReview: { invalidate: fixture.refreshChartReview },
        accountPositions: { invalidate: fixture.refreshLedger },
        accountTrades: { invalidate: fixture.refreshLedger },
      }),
      intradayAlertOverview: { useQuery: () => query(fixture.alert) },
      alertStatus: { useQuery: () => query({ mode: "shadow" }) },
      intradayAlertConfigSave: {
        useMutation: () => mutation(fixture.saveConfig),
      },
      intradayAlertRunNow: { useMutation: () => mutation(fixture.runNow) },
      intradayWatchRuleSave: { useMutation: () => mutation(fixture.saveRule) },
      intradayWatchRuleDelete: {
        useMutation: () => mutation(fixture.deleteRule),
      },
      simAccountsList: {
        useQuery: () =>
          query([
            {
              id: "sim-1",
              name: "A股默认模拟账户",
              status: "active",
              market: "cn-equity",
              currency: "CNY",
            },
          ]),
      },
      simAccountDetail: { useQuery: () => query() },
      simAccountCreate: { useMutation: () => mutation() },
      simOrderPreview: { useMutation: () => mutation(fixture.preview) },
      simOrderConfirm: { useMutation: () => mutation(fixture.confirm) },
      pipelineGlobalConfig: {
        useQuery: () =>
          query({ autoSimEnabled: false, autoLiveEnabled: false }),
      },
      deploymentList: {
        useInfiniteQuery: () =>
          query({
            pages: [{ items: fixture.deployment ? [fixture.deployment] : [] }],
          }),
      },
      deploymentGet: { useQuery: () => query(fixture.linkedDeployment) },
      useQueries: (
        select: (queries: { pipelineRunDetail: () => unknown }) => unknown,
      ) => select({ pipelineRunDetail: () => query(fixture.run) }),
      deploymentUpdateMode: { useMutation: () => mutation() },
      deploymentCreate: { useMutation: () => mutation(fixture.deploy) },
      pipelineRunStep: { useMutation: () => mutation() },
      pipelineRunDetail: { useQuery: () => query(fixture.run) },
      pipelineIntentApprove: { useMutation: () => mutation() },
      pipelineIntentCancel: { useMutation: () => mutation() },
      pipelineSetGlobalAutoSim: { useMutation: () => mutation() },
      pipelineSetGlobalAutoLive: { useMutation: () => mutation() },
      implementationShortfall: {
        useMutation: () => ({
          ...mutation(fixture.shortfall),
          variables: fixture.report ? { account: "sim-1" } : undefined,
          data: fixture.report,
          isSuccess: fixture.report !== undefined,
        }),
      },
    },
  };
});

import { ChartSimOrderDialog } from "~/components/market/chart-sim-order-dialog";
import { RebalanceTicketDetails } from "~/components/overview/rebalance-ticket-panel";
import {
  DeployStrategyDialog,
  type StrategySpecInput,
} from "~/components/pipeline/deploy-strategy-dialog";
import { PipelineConsole } from "~/components/pipeline/pipeline-console";
import { ImplementationShortfallPanel } from "~/components/portfolio/implementation-shortfall-panel";
import { labDeployPreset } from "~/components/research/strategy-lab";
import { IntradayAlertWorkspace } from "~/components/signals/intraday-alert-workspace";
import { useMarketSession } from "~/lib/stores/market-session";

function renderedProps(
  predicate: (entry: (typeof fixture.props)[number]) => boolean,
) {
  const entry = fixture.props.find(predicate);
  expect(entry).toBeDefined();
  return entry!.props;
}

function submitForm(fields: Record<string, string>, label?: string) {
  const form = renderedProps(
    ({ name, props }) => name === "form" && props["aria-label"] === label,
  );
  const submitted = new FormData();
  for (const [name, value] of Object.entries(fields))
    submitted.set(name, value);
  const RealFormData = FormData;
  vi.stubGlobal(
    "FormData",
    class extends RealFormData {
      constructor() {
        super();
        for (const [name, value] of submitted) this.append(name, value);
      }
    },
  );
  try {
    (form.onSubmit as (event: Partial<FormEvent<HTMLFormElement>>) => void)({
      preventDefault: vi.fn(),
    });
  } finally {
    vi.unstubAllGlobals();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.props = [];
  fixture.search = new URLSearchParams();
  fixture.report = undefined;
  fixture.deployment = undefined;
  fixture.linkedDeployment = undefined;
  fixture.run = undefined;
});

describe("Wave 2 工作台闭环", () => {
  it("显示实际预警配置，从自选带入代码，并向相应接口提交新增、停用、删除与立即检测", () => {
    fixture.search = new URLSearchParams("symbol=sh600000");
    const config: IntradayAlertStatus["config"] = {
      enabled: true,
      pollIntervalSec: 30,
      monitorHoldingsStops: true,
      monitorPlannedEntries: true,
      monitorWatchlistRules: true,
      intradayScanEnabled: false,
    };
    const rule = {
      id: "watch-1",
      symbol: "sz000001",
      direction: "below",
      thresholdPrice: 12.5,
      note: "止跌前留意",
      enabled: true,
    } as const;
    fixture.alert = {
      config,
      rules: [{ ...rule, createdAt: 1, updatedAt: 1, lastTriggeredDate: null }],
      session: "trading",
      lastCheckedAt: null,
      lastQuoteSource: null,
      lastResult: null,
      monitoredSymbolCount: 1,
      recentEvents: [],
      holdings: [],
    } satisfies IntradayAlertStatus;
    const html = renderToStaticMarkup(createElement(IntradayAlertWorkspace));

    for (const label of [
      "开启盘中预警",
      "交易中",
      "空跑观察",
      "新增规则",
      "今日未触发",
    ])
      expect(html).toContain(label);
    expect(html).toContain('value="sh600000"');
    const run = renderedProps(
      ({ props }) =>
        Array.isArray(props.children) &&
        props.children.includes("立即检测一次"),
    );
    expect(run.disabled).toBe(false);
    (run.onClick as () => void)();
    expect(fixture.runNow).toHaveBeenCalledOnce();
    const save = renderedProps(
      ({ props }) => props.children === "保存预警设置",
    );
    (save.onClick as () => void)();
    expect(fixture.saveConfig).toHaveBeenCalledWith(config);

    submitForm(
      { symbol: "sh600000", thresholdPrice: "10.25", note: "看放量" },
      "价格阈值规则",
    );
    expect(fixture.saveRule).toHaveBeenCalledWith(
      {
        symbol: "sh600000",
        direction: "above",
        thresholdPrice: 10.25,
        enabled: true,
        note: "看放量",
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
    const toggle = renderedProps(
      ({ props }) => props["aria-label"] === "停用 sz000001 规则",
    );
    (toggle.onCheckedChange as () => void)();
    expect(fixture.saveRule).toHaveBeenLastCalledWith({
      ...rule,
      enabled: false,
    });
    const remove = renderedProps(
      ({ props }) => props["aria-label"] === "删除 sz000001 价格阈值规则",
    );
    (remove.onClick as () => void)();
    expect(fixture.deleteRule).toHaveBeenCalledWith(
      { id: rule.id },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("调仓单行带入卖出标的、股数和参考价，打开后必须先预览才可确认", () => {
    const createdAt = Date.parse("2026-11-24T16:00:00+08:00");
    const ticket: ComponentProps<typeof RebalanceTicketDetails>["ticket"] = {
      id: "ticket-1",
      accountScope: "paper",
      accountId: "paper-1",
      status: "confirmed",
      asOfDate: "2026-11-24",
      executeDate: "2026-11-25",
      executeDateBasis: "market-calendar",
      executeDateNote: null,
      expiresAt: Date.parse("2026-11-25T09:30:00+08:00"),
      sourceKind: "manual",
      sourceRefId: "rebalance",
      providerLimits: "复检前请核对行情",
      allocation: null,
      orders: [
        {
          symbol: "sh600000",
          side: "sell",
          conditional: false,
          quantity: 300,
          estimate: {
            estimatePrice: 10.3,
            close: 10.28,
            estimatedNotionalCny: 3090,
            estimatedFeesCny: 5,
            cashRequiredCny: 0,
            netSaleProceedsCny: 3085,
            atr14: null,
            settlementCycle: "T+1",
            sizingReasons: [],
          },
          riskChecks: [],
        },
      ],
      riskSummary: { status: "normal", checks: [] },
      createdAt,
      updatedAt: createdAt,
      confirmedAt: createdAt,
      recheckResult: null,
      recheckedAt: null,
    };
    const html = renderToStaticMarkup(
      createElement(RebalanceTicketDetails, {
        ticket,
        busy: false,
        disabled: false,
        onCancel: vi.fn(),
        onRecheck: vi.fn(),
        onConfirm: vi.fn(),
      }),
    );
    expect(html).toContain(">模拟下单</button>");
    expect(html).not.toContain(">确认模拟成交</button>");
    const props = renderedProps(({ name }) => name === "ChartSimOrderDialog");
    expect(props).toMatchObject({
      open: false,
      initialSide: "sell",
      initialQuantity: "300",
      referencePrice: 10.3,
    });
    const opened = renderToStaticMarkup(
      createElement(ChartSimOrderDialog, {
        ...(props as ComponentProps<typeof ChartSimOrderDialog>),
        open: true,
      }),
    );
    expect(opened).toContain("模拟下单 · SH600000");
    expect(opened).toContain('value="300"');
    expect(opened).toContain('value="10.30"');
    expect(opened).toContain("预览模拟成交");
    const confirm = renderedProps(
      ({ props }) => props.children === "确认模拟成交",
    );
    expect(confirm.disabled).toBe(true);
    expect(fixture.preview).not.toHaveBeenCalled();
    expect(fixture.confirm).not.toHaveBeenCalled();
  });

  it("运行台默认显示审批和异常，并链接同一意图的图表和模拟账户", () => {
    const summary = {
      id: "run-1",
      stage: "blocked",
      decisionDate: "2026-11-25",
      startedAt: 1,
      errorSummary: "报价待核验",
    };
    fixture.deployment = {
      id: "deployment-1",
      name: "盘后选股",
      status: "active",
      latestRun: summary,
      market: "cn-equity",
      executionMode: "manual_confirm",
      strategySpec: { kind: "study-rule" },
      venueBinding: { kind: "ths_mock" },
      activePoolCount: 1,
    };
    fixture.run = {
      run: summary,
      intents: [
        {
          id: "order-1",
          symbol: "sh600000",
          venueKind: "ths_mock",
          status: "planned",
          side: "BUY",
          quantity: 100,
          referencePrice: 10,
          phase: 2,
        },
      ],
    };
    const html = renderToStaticMarkup(createElement(PipelineConsole));
    expect(html).toContain("今日待办");
    expect(html).toContain("待人工审批意图（1）");
    expect(html).toContain("异常 / 拦截运行（1）");
    expect(html).toContain("盘后选股 · 买入");
    expect(html).toMatch(/href="\/scan\?symbol=sh600000"[^>]*>看K线/);
    expect(html).toMatch(
      /href="\/accounts\?tab=paper&amp;channel=ths-mock"[^>]*>去模拟账户/,
    );
    expect(html).not.toContain("单步规划日期");
  });

  it("部署深链打开列表外的运行，并保留数字货币信号与次日调仓入口", () => {
    fixture.search = new URLSearchParams("tab=pipeline&deployment=crypto-1");
    const run = {
      id: "run-crypto",
      stage: "signals_done",
      decisionDate: "2026-11-25",
      startedAt: 1,
      signals: {
        mode: "delta-signals",
        asOf: "2026-11-25",
        targets: {},
        regimeScale: null,
        disclosure: "",
        panelSnapshotId: "panel-1",
        signals: [
          {
            symbol: "BTCUSDT",
            action: "BUY",
            score: null,
            stopPrice: null,
            targetPrice: null,
            reason: "均线交叉",
            signalId: "signal-1",
          },
        ],
      },
    };
    fixture.linkedDeployment = {
      deployment: {
        id: "crypto-1",
        name: "数字货币双均线",
        status: "active",
        market: "crypto",
        executionMode: "manual_confirm",
        strategySpec: { kind: "crypto-dual-ma" },
        venueBinding: { kind: "crypto_sim" },
      },
      activePool: [],
      runs: [run],
    };
    fixture.run = {
      run,
      intents: [
        {
          id: "order-crypto",
          symbol: "BTCUSDT",
          venueKind: "crypto_sim",
          status: "planned",
          side: "BUY",
          quantity: 0.01,
          referencePrice: 90_000,
          phase: 2,
        },
      ],
      auditEvents: [],
    };

    const html = renderToStaticMarkup(createElement(PipelineConsole));
    expect(html).toContain('id="deployment-crypto-1"');
    expect(html).toContain("信号明细（1）");
    expect(html).toContain("均线交叉");
    expect(html).not.toContain("信号尚未生成");
    expect(
      html.match(/href="\/scan\?tab=crypto&amp;symbol=BTCUSDT"/g),
    ).toHaveLength(3);
    expect(html).not.toContain('href="/#rebalance-tickets"');
  });

  it("从策略库提交冻结归档、回测出处和兼容的初始风控参数", () => {
    const strategy = strategyObjectSchema.parse({
      id: "reviewed",
      version: 2,
      market: "cn-equity",
      period: "day",
      universe: { kind: "symbols", symbols: ["sh600000"] },
      entry: {
        kind: "formula",
        source: "BUY:CLOSE>N;",
        parameters: { N: 10 },
      },
      exit: { stop: { kind: "fixed", fraction: 0.05 }, maxBars: 12 },
      sizing: { kind: "weight", weight: 0.15 },
      sleeve: "swing",
    });
    const preset = labDeployPreset(
      { strategy, row: null },
      strategy.id,
      strategy.version,
      {
        id: "job-1",
        result: {
          archiveId: "backtest-1",
          inputHash: "input-1",
          targetSnapshot: { snapshotHash: "snapshot-1", panelId: "panel-1" },
          frozen: {
            strategyBuildHash: "build-1",
            request: {
              accountMaxSymbolWeight: 0.12,
              riskPolicy: {
                maxSingleInstrumentWeight: 0.1,
                pauseThreshold: 0.06,
              },
            },
          },
        },
      },
    );
    expect(preset).not.toBeNull();
    const html = renderToStaticMarkup(
      createElement(DeployStrategyDialog, {
        open: true,
        onOpenChange: vi.fn(),
        defaultPreset: preset!,
      }),
    );
    expect(html).toContain("已带入当前版本的冻结回测出处");
    const create = renderedProps(
      ({ props }) =>
        Array.isArray(props.children) && props.children.includes("创建部署"),
    );
    (create.onClick as () => void)();
    expect(fixture.deploy).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        status: "draft",
        executionMode: "shadow",
        strategySpec: expect.objectContaining({
          kind: "formula",
          parameters: { N: 10 },
        }),
        universeSpec: { kind: "fixed-symbols", symbols: ["sh600000"] },
        riskPolicy: expect.objectContaining({
          maxSymbolWeight: 0.1,
          drawdownPausePct: 0.06,
        }),
      }),
    );
    const provenance = deploymentProvenanceSchema.parse(
      fixture.deploy.mock.calls[0]![0].provenance,
    );
    expect(provenance).toMatchObject({
      sourceKind: "lab-backtest",
      sourceRefId: "backtest-1",
      buildHash: "build-1",
      createdFromRoute: "/lab",
    });
    expect(JSON.parse(provenance.note)).toMatchObject({
      strategy: "reviewed@v2",
      jobId: "job-1",
      inputHash: "input-1",
      snapshotId: "snapshot-1",
      panelId: "panel-1",
      exit: strategy.exit,
    });
  });

  it.each<StrategySpecInput>([
    {
      kind: "formula",
      name: "收盘突破",
      source: "BUY:CLOSE>N;",
      parameters: { N: 10 },
    },
    {
      kind: "theory-screener",
      methodId: "liquidity-trend",
      holdBars: 12,
      minScore: 4,
      useScreenerStops: false,
    },
  ])(
    "部署确认保留当前策略的规则参数，并创建空跑草稿（$kind）",
    (strategySpec) => {
      renderToStaticMarkup(
        createElement(DeployStrategyDialog, {
          open: true,
          onOpenChange: vi.fn(),
          defaultPreset: { name: "策略待核对", strategySpec },
        }),
      );
      const create = renderedProps(
        ({ props }) =>
          Array.isArray(props.children) && props.children.includes("创建部署"),
      );
      expect(create.disabled).toBe(false);
      expect(fixture.deploy).not.toHaveBeenCalled();
      (create.onClick as () => void)();
      expect(fixture.deploy).toHaveBeenCalledWith(
        expect.objectContaining({
          strategySpec,
          status: "draft",
          executionMode: "shadow",
        }),
      );
    },
  );

  it("本地模拟成交确认后才刷新持仓和买卖点，并保留成交账本回链", () => {
    const chart = useMarketSession.getState();
    chart.clearTradeContext();
    try {
      renderToStaticMarkup(
        createElement(ChartSimOrderDialog, {
          open: true,
          onOpenChange: vi.fn(),
          market: "cn-equity",
          symbol: "sh600000",
          displayName: "浦发银行",
          referencePrice: 10,
          referencePriceSource: "unadjusted",
          syncChartReview: true,
        }),
      );
      expect(fixture.refreshChartPosition).not.toHaveBeenCalled();
      expect(fixture.refreshChartReview).not.toHaveBeenCalled();
      const form = renderedProps(({ props }) => props.lockSymbol === true);
      const trade: SimTradeRow = {
        accountId: "sim-1",
        market: "cn-equity",
        currency: "CNY",
        symbol: "sh600000",
        side: "buy",
        quantity: "100",
        price: "10.00",
        tradeDate: "2026-11-25",
        executionMode: "manual",
        planId: null,
        gross: "1000.00",
        commission: "5.00",
        transfer: "0.01",
        tax: "0.00",
        slippage: "0.00",
        netCashDelta: "-1005.01",
        orderId: "order-1",
        fillId: "fill-1",
        clientRequestId: "request-1",
        executedAt: 1,
      };
      (form.onDone as (fill: SimTradeRow) => void)(trade);
      expect(fixture.refreshChartPosition).toHaveBeenCalledWith("sh600000");
      expect(fixture.refreshChartReview).toHaveBeenCalledOnce();
      const review = useMarketSession.getState().tradeContext;
      expect(review).toMatchObject({
        symbol: "sh600000",
        at: "2026-11-25",
        visible: true,
        review: { accountId: "sim-1", refId: "local-sim:sim-1" },
      });
      const back = new URL(review!.review!.backHref, "http://fixture");
      expect(back.searchParams.get("kind")).toBe("local-sim");
      expect(back.searchParams.get("trade")).toBe("local-sim:sim-1:fill-1");
    } finally {
      chart.clearTradeContext();
    }
  });

  it("本地模拟账本按 local_sim 查询，并把缺失证据和策略归因显示为中文", () => {
    fixture.report = {
      status: "incomplete",
      currency: "CNY",
      terminalDate: "2026-11-25",
      source: {
        kind: "account",
        scope: "local_sim",
        account: "sim-1",
        from: "2026-11-01",
        to: "2026-11-25",
        trades: [],
      },
      missing: [{ field: "frozenPlan", reason: "缺少冻结指令证据" }],
      openingNav: null,
      disciplineAdherenceRate: null,
      missedTradeRate: null,
      unplannedFillCount: 0,
      reconciliation: null,
      rows: [],
    } satisfies RouterOutputs["implementationShortfall"];
    const html = renderToStaticMarkup(
      createElement(ImplementationShortfallPanel, {
        scope: "local_sim",
        accounts: ["sim-1"],
        asOf: "2026-11-25",
        accountsLoading: false,
      }),
    );
    expect(html).toContain("本地模拟");
    expect(html).toContain("交易复盘结论");
    expect(html).toContain("实施缺口数据不完整");
    expect(html).toContain('href="/lab"');
    expect(html).not.toMatch(/incomplete|哈希/i);
    submitForm({ from: "2026-11-01", to: "2026-11-25" });
    expect(fixture.shortfall).toHaveBeenCalledWith({
      scope: "local_sim",
      account: "sim-1",
      from: "2026-11-01",
      to: "2026-11-25",
    });
  });
});
