import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  Children,
  createElement,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import {
  defaultStrategy,
  settingsSchema,
  type Report,
  type Settings,
} from "~/lib/domain";
import type { FormulaScreen } from "~/components/screening/formula-screen";
import { ScreenView } from "~/components/workbench/screen-view";
import { ReportCard } from "~/components/workbench/reports";
import {
  CalendarEvidence,
  Empty,
  Field,
  ResultPager,
} from "~/components/workbench/shared";
import { StrategyFields } from "~/components/workbench/strategy-fields";
import { NotificationsSection } from "~/components/workbench/connections/notifications-section";
import { NewsSection } from "~/components/workbench/connections/news-section";
import { connectionSourcePaths } from "../helpers/r2-contracts";

type FormulaProps = Parameters<typeof FormulaScreen>[0];
type PolicyProps = {
  value: Settings["notificationPolicy"];
  onChange: (value: Settings["notificationPolicy"]) => void;
};
const wiring = vi.hoisted(() => ({
  formula: vi.fn<(props: FormulaProps) => void>(),
  policy: vi.fn<(props: PolicyProps) => void>(),
  archive:
    vi.fn<
      (content: () => string, filename: string, mediaType: string) => void
    >(),
  expandEvidence: false,
  expandMethodology: false,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("~/components/screening/formula-screen", () => ({
  FormulaScreen: (props: FormulaProps) => {
    wiring.formula(props);
    return createElement("button", { type: "button" }, "运行公式");
  },
}));
vi.mock("~/components/research/factor-evaluation-panel", () => ({
  FactorEvaluationPanel: () => null,
}));
vi.mock("~/components/screening/screen-task-progress", () => ({
  ScreenTaskProgress: () => null,
}));
vi.mock("~/components/research/research-usage-container", () => ({
  ResearchUsageContainer: () => createElement("aside", null, "研究用量探针"),
}));
vi.mock("~/components/signals/notification-policy-fields", () => ({
  NotificationPolicyFields: (props: PolicyProps) => {
    wiring.policy(props);
    return null;
  },
}));
vi.mock("~/components/workbench/news-source-diagnostics", () => ({
  NewsSourceDiagnostics: () => null,
}));
vi.mock("~/components/research/use-archive-download", () => ({
  useArchiveDownload: () => ({ error: "", save: wiring.archive }),
}));
vi.mock("~/components/ui/popover", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/components/ui/popover")>();
  return {
    ...actual,
    PopoverContent: (props: ComponentProps<typeof actual.PopoverContent>) =>
      wiring.expandMethodology
        ? createElement("section", null, props.children)
        : createElement(actual.PopoverContent, props),
  };
});
vi.mock("~/components/research/archive-evidence", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("~/components/research/archive-evidence")
    >();
  return {
    ...actual,
    ArchiveEvidence: (props: Parameters<typeof actual.ArchiveEvidence>[0]) =>
      wiring.expandEvidence
        ? createElement(
            "section",
            { "aria-label": props.title },
            props.children(),
          )
        : createElement(actual.ArchiveEvidence, props),
  };
});

beforeEach(() => {
  wiring.formula.mockClear();
  wiring.policy.mockClear();
  wiring.archive.mockClear();
  wiring.expandEvidence = false;
  wiring.expandMethodology = false;
});

const render = (node: ReactElement) => renderToStaticMarkup(node);

function screenResult(formula?: {
  name: string;
  source: string;
  parameters: Record<string, number>;
}) {
  return {
    formula,
    asOf: "2026-11-19",
    candidates: [],
    count: 0,
    candidateTotal: 0,
    total: 0,
    excludedTotal: 0,
    errorTotal: 0,
    researchWarnings: [],
  };
}

function renderScreen(result?: ReturnType<typeof screenResult>) {
  const selectFormulaJob = vi.fn();
  const state = {
    names: {},
    screened: {},
    screenPage: 0,
    excludedPage: 0,
    errorPage: 0,
    screenQuery: "",
    screenSort: "original",
    screenDirection: "desc",
    screenJob: { id: "formula-job", status: "completed" },
    screenResult: result,
    selectFormulaJob,
  } as unknown as Parameters<typeof ScreenView>[0]["state"];
  return {
    html: render(createElement(ScreenView, { state })),
    selectFormulaJob,
  };
}

it("routes FormulaScreen starts to job selection and discloses the selected formula snapshot and its parameters", () => {
  const result = screenResult({
    name: "历史参数测试",
    parameters: { fast: 5 },
    source: "XG:C<MA(C,5);",
  });
  const { html, selectFormulaJob } = renderScreen(result);
  expect(html).toContain("运行公式");
  expect(wiring.formula).toHaveBeenCalledExactlyOnceWith({
    onStarted: selectFormulaJob,
  });
  wiring.formula.mock.calls[0]![0].onStarted("next-formula-job");
  expect(selectFormulaJob).toHaveBeenCalledExactlyOnceWith("next-formula-job");
  expect(html).toContain("已执行公式");
  expect(html).toContain("历史参数测试");
  expect(html).toContain("短周期：5");
  expect(html).toContain("口径说明");
  expect(html).not.toContain("XG:C&lt;MA(C,5);");
  expect(html).toContain("研究用量探针");

  wiring.expandMethodology = true;
  const { html: methodology } = renderScreen(result);
  expect(methodology).toContain("本次执行公式源码快照");
  expect(methodology).toContain("XG:C&lt;MA(C,5);");
  expect(methodology).toContain(
    "下表均线差与量比仅作描述，不参与公式选中判定。",
  );
  expect(methodology).toContain("2026-11-19 为本次选股基准日");
  expect(methodology).toContain("行情来源为本地已完成日线");
});

it.each([
  { label: "results have not loaded", result: undefined },
  { label: "results contain no formula", result: screenResult() },
])("hides the snapshot and research usage when $label", ({ result }) => {
  wiring.expandMethodology = true;
  const { html } = renderScreen(result);
  expect(html).toContain("候选结果");
  expect(html).not.toContain("本次执行公式源码快照");
  expect(html).not.toContain("研究用量探针");
});

it("keys formula research usage by the selected job so a new job replaces the previous panel", () => {
  // React's key is not emitted in HTML. Only this prop needs a source assertion.
  const source = readFileSync(
    "src/components/workbench/screen-view.tsx",
    "utf8",
  );
  expect(source).toMatch(
    /<ResearchUsageContainer\b[^>]*\bkey\s*=\s*\{\s*screenJob\?\.id\s*\}/,
  );
});

it("renders structured report evidence, caveats and version details when the archive is expanded", () => {
  const report: Report = {
    id: "report",
    contextId: "context",
    title: "研究标题",
    summary: "研究摘要",
    supporting: ["价格与成交同向"],
    opposing: ["趋势仍待确认"],
    risks: ["成交稀疏"],
    missing: ["缺少季度数据"],
    nextSteps: ["留待复核"],
    citations: ["E-1"],
    model: "fixture-model",
    promptVersion: "fixture-version",
    tokens: 81,
    createdAt: 1000,
    stages: [
      {
        id: "trend",
        status: "supported",
        summary: "分阶段结论",
        citations: ["E-1"],
        missing: ["交易日缺口"],
      },
    ],
    evidence: [
      {
        id: "E-1",
        source: "本地行情",
        asOf: "2026-11-19",
        text: "本地源原文",
        envelope: {
          version: "evidence-1",
          type: "bars",
          source: "本地日线",
          symbol: "sh600000",
          asOf: "2026-11-19",
          publishedAt: null,
          fetchedAt: 1000,
          currency: "CNY",
          unit: { price: "元" },
          adjustment: "none",
          reportPeriod: null,
          payloadHash: "a".repeat(64),
          quality: "validated",
          warnings: ["需人工复核"],
        },
      },
    ],
  };
  const props = {
    report,
    securityContext: { symbol: "sh600000" },
    names: { sh600000: "浦发银行" },
  };
  const card = createElement(ReportCard, props);
  const collapsed = render(card);
  for (const text of [
    "浦发银行",
    "导出报告",
    "研究标题",
    "研究摘要",
    "价格与成交同向",
    "趋势仍待确认",
    "成交稀疏",
    "缺少季度数据",
    "留待复核",
    "分阶段结论",
    "交易日缺口",
    "引用：E-1",
    "fixture-model",
    "fixture-version",
    "查看证据与版本",
  ]) {
    expect(collapsed).toContain(text);
  }
  expect(collapsed).not.toContain("本地源原文");
  wiring.expandEvidence = true;
  const expanded = render(card);
  for (const text of [
    "来源与口径",
    "数据时点：2026-11-19",
    "需人工复核",
    "本地源原文",
    "来源：本地日线",
    "品种：sh600000",
    "价格：元",
    "81 tokens",
  ]) {
    expect(expanded).toContain(text);
  }
  expect(expanded).not.toContain("&quot;payloadHash&quot;");

  const exportButton = descendants(ReportCard(props)).find(({ props }) =>
    Children.toArray(props.children).includes("导出报告"),
  );
  const onExport = exportButton?.props as { onClick: () => void } | undefined;
  expect(wiring.archive).toHaveBeenCalledTimes(0);
  onExport?.onClick();
  expect(wiring.archive).toHaveBeenCalledExactlyOnceWith(
    expect.any(Function),
    "研究报告-1000.md",
    "text/markdown;charset=utf-8",
  );
  const markdown = wiring.archive.mock.calls[0]![0]();
  for (const evidence of [
    "## 支持证据",
    "## 反向证据",
    "## 趋势与相对强度",
    "引用：E-1",
    "本地源原文",
    '"payloadHash":"' + "a".repeat(64) + '"',
  ]) {
    expect(markdown).toContain(evidence);
  }
});

it("updates only notificationPolicy through the controlled form and performs no test send", () => {
  const config = settingsSchema.parse({ tdxRoot: resolve("fixture-tdx") });
  const setConfig = vi.fn();
  const onTestChannel = vi.fn();
  const fetch = vi.fn(() => {
    throw new Error("Unexpected external request");
  });
  vi.stubGlobal("fetch", fetch);
  try {
    const html = render(
      createElement(NotificationsSection, {
        config,
        setConfig,
        fieldError: () => null,
        channels: [],
        channel: {
          name: "",
          type: "wecom",
          secret: "",
          signingSecret: "",
          target: "",
          thread: "",
          enabled: false,
        },
        onChannelChange: vi.fn(),
        editId: undefined,
        onEdit: vi.fn(),
        onCancelEdit: vi.fn(),
        onSaveChannel: vi.fn(),
        saveChannelPending: false,
        onTestChannel,
      }),
    );
    expect(html).toContain("通知策略");
    expect(wiring.policy).toHaveBeenCalledTimes(1);
    const props = wiring.policy.mock.calls[0]![0];
    expect(props.value).toEqual(config.notificationPolicy);
    const nextPolicy = {
      ...props.value,
      dailyLimit: props.value.dailyLimit + 1,
    };
    props.onChange(nextPolicy);
    expect(setConfig).toHaveBeenCalledExactlyOnceWith({
      ...config,
      notificationPolicy: nextPolicy,
    });
    expect(config.notificationPolicy.dailyLimit).toBe(5);
    expect(onTestChannel).toHaveBeenCalledTimes(0);
    expect(fetch).toHaveBeenCalledTimes(0);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("keeps connections read-only and removes the retired five-minute CSV importer", () => {
  const config = settingsSchema.parse({});
  const html = render(
    createElement(NewsSection, {
      config,
      value: config,
      setConfig: vi.fn(),
      fieldError: () => null,
      fieldProps: (id) => ({
        id,
        "aria-invalid": false,
        "aria-describedby": undefined,
      }),
      dirty: false,
      savePending: false,
      budget: { error: null },
    }),
  );
  expect(html).toContain("行情读取与外部 Blocks 目录只读");
  for (const file of connectionSourcePaths()) {
    expect(readFileSync(file, "utf8"), file).not.toMatch(
      /FiveMinuteImport|五分钟 CSV 导入|五分钟导入按下方流程操作/,
    );
  }
});

function descendants(
  node: ReactNode,
): ReactElement<{ children?: ReactNode }>[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<{ children?: ReactNode }>(child)
      ? [child, ...descendants(child.props.children)]
      : [],
  );
}

it("keeps shared form labels, empty state and archived calendar evidence visible", () => {
  const field = render(
    createElement(Field, {
      label: "交易金额",
      children: createElement("input", { defaultValue: "100" }),
    }),
  );
  expect(field).toMatch(
    /<label\b[^>]*>[\s\S]*交易金额[\s\S]*<input\b[^>]*value="100"[\s\S]*<\/label>/,
  );
  expect(render(createElement(Empty, { children: "没有候选" }))).toContain(
    "没有候选",
  );
  expect(
    render(createElement(CalendarEvidence, { evidence: undefined })),
  ).toContain("尚无已归档的日历核验信息");
  const evidence = render(
    createElement(CalendarEvidence, {
      evidence: { source: "已核验交易日历", hash: null, assessedAt: 123 },
    }),
  );
  expect(evidence).toContain("日历核验来源");
  expect(evidence).toContain("已核验交易日历");
  expect(evidence).toContain("来源指纹：未记录");
});

it("preserves the 50-result paging boundary and loads the next batch continuously", () => {
  const onChange = vi.fn();
  const firstHtml = render(
    createElement(ResultPager, { page: 0, count: 51, onChange }),
  );
  const lastHtml = render(
    createElement(ResultPager, { page: 1, count: 51, onChange }),
  );
  const exactHtml = render(
    createElement(ResultPager, { page: 0, count: 50, onChange }),
  );
  expect(firstHtml).toContain("已加载 50 / 共 51 条");
  expect(firstHtml).toContain("加载更多");
  expect(lastHtml).toContain("已加载 51 / 共 51 条");
  expect(lastHtml).not.toContain("加载更多");
  expect(exactHtml).toContain("已加载 50 / 共 50 条");
  expect(exactHtml).not.toContain("加载更多");
});

it("keeps historical strategy parameters editable with the deprecation disclosure", () => {
  const strategy = {
    ...defaultStrategy,
    type: "dual-breakout" as const,
    params: {},
  };
  const setStrategy = vi.fn();
  const view = StrategyFields({ strategy, setStrategy });
  expect(render(view)).toContain("历史策略已弃用，仅供核对旧配置");
  type NumericInput = ReactElement<{
    onChange: (event: { target: { value: string } }) => void;
    value: number;
  }>;
  const fields = descendants(view).filter(({ type }) => type === Field);
  for (const [label, field, value] of [
    ["短均线", "fast", 7],
    ["长均线", "slow", 25],
    ["最低涨幅 %", "minChange", -3],
    ["最高涨幅 %", "maxChange", 6],
    ["最低量比", "minVolumeRatio", 1.2],
  ] as const) {
    const input = fields.find(
      ({ props }) => (props as { label?: string }).label === label,
    )?.props.children as NumericInput;
    expect(input.props.value).toBe(strategy[field]);
    input.props.onChange({ target: { value: String(value) } });
    expect(setStrategy).toHaveBeenLastCalledWith({
      ...strategy,
      type: undefined,
      [field]: value,
    });
  }
});
