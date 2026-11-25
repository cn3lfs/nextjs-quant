import { Children, createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { ThsdkWencaiRow } from "../../../src/lib/market/thsdk-extensions";

const hooks = vi.hoisted(() => ({
  browserFallback: false,
  wencai: null as { state: unknown[]; cursor: number } | null,
}));
const requestOverviewQuotes = vi.hoisted(() =>
  vi.fn((_symbols: string[]) => ({
    quotes: [{ symbol: "sh600519", price: 105, preClose: 100 }],
  })),
);

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useState<T>(initial: T | (() => T)) {
      const fixture = hooks.wencai;
      if (!fixture) {
        // Reflect the browser capability check, whose effect does not run in SSR.
        return react.useState(
          hooks.browserFallback && initial === null ? (false as T) : initial,
        );
      }
      const { state } = fixture;
      const index = fixture.cursor++;
      if (!(index in state)) {
        state[index] =
          typeof initial === "function" ? (initial as () => T)() : initial;
      }
      return [
        state[index],
        (value: T) => {
          state[index] = value;
        },
      ];
    },
  };
});

const wencaiRows: ThsdkWencaiRow[] = [
  {
    symbol: "sh600519",
    code: "600519",
    market: "USHA",
    name: null,
    values: {},
  },
  {
    symbol: "sz002548",
    code: "002548",
    market: "USZA",
    name: null,
    values: {},
  },
];

vi.mock("~/components/workbench/use-task-visible", () => ({
  useScreenVisible: () => true,
  useTaskVisible: () => true,
}));
vi.mock("~/trpc/react", () => ({
  api: {
    securityNames: {
      useQuery: () => ({ data: { sh600519: "贵州茅台", sz002548: "金新农" } }),
    },
    thsdkWencaiQuery: {
      useQuery: (
        { query }: { query: string },
        { enabled }: { enabled: boolean },
      ) => ({
        data: query && enabled ? { rows: wencaiRows, fields: [] } : undefined,
      }),
    },
    thsdkWencaiHotBlocks: { useQuery: () => ({}) },
    thsdkBlockConstituents: { useQuery: () => ({}) },
    overviewQuotes: {
      useQuery: (symbols: string[], options?: { enabled?: boolean }) => ({
        data:
          options?.enabled === false
            ? undefined
            : requestOverviewQuotes(symbols),
      }),
    },
  },
}));

import { ThsdkWencaiPanel } from "../../../src/components/market/thsdk-wencai-panel";
import { IntelAnnotations } from "../../../src/components/news/intel-annotations";
import {
  buildClsSearchUrl,
  defaultClsSearchKeyword,
  isAllowedClsUrl,
} from "../../../src/lib/news/cls-search-url";

const searchUrl =
  "https://www.cls.cn/searchPage?keyword=%E8%B4%B5%E5%B7%9E%E8%8C%85%E5%8F%B0&type=all";

it.each([
  ["sh600519", "贵州茅台", "贵州茅台"],
  ["sh600519", "", "600519"],
  ["sh600519", undefined, "600519"],
  ["sz002548", "sz002548", "002548"],
] as const)(
  "uses %s and %s to choose the CLS keyword %s",
  (symbol, name, keyword) => {
    expect(defaultClsSearchKeyword(symbol, name)).toBe(keyword);
  },
);

it("encodes the Chinese keyword in the official CLS search URL", () => {
  expect(buildClsSearchUrl("贵州茅台")).toBe(searchUrl);
});

it.each([
  "https://www.cls.cn/searchPage?keyword=test&type=all",
  "https://m.cls.cn/detail/123",
])("allows the CLS HTTPS URL %s", (url) => {
  expect(isAllowedClsUrl(url)).toBe(true);
});

it.each([
  "http://www.cls.cn/searchPage?keyword=test&type=all",
  "https://evil.com/?q=cls.cn",
  "https://notcls.cn/",
  "javascript:alert(1)",
  "file:///C:/Windows",
])("rejects the URL %s for CLS navigation", (url) => {
  expect(isAllowedClsUrl(url)).toBe(false);
});

function renderNewsPanel() {
  return renderToStaticMarkup(
    createElement(IntelAnnotations, {
      symbol: "sh600519",
      name: "贵州茅台",
      bars: [],
      render: () => null,
    }),
  );
}

it("renders the chart news section and the default keyword during SSR", () => {
  const html = renderNewsPanel();
  expect(html).toContain('<section aria-label="图表新闻事件"');
  expect(html).toMatch(
    /<input[^>]*aria-label="财联社搜索关键词"[^>]*value="贵州茅台"/,
  );
});

it("renders the CLS iframe and a new-tab fallback in browser mode", () => {
  hooks.browserFallback = true;
  let html: string;
  try {
    html = renderNewsPanel();
  } finally {
    hooks.browserFallback = false;
  }
  const escapedUrl = searchUrl.replace("&", "&amp;");
  expect(html).toContain('<section aria-label="图表新闻事件"');
  expect(html.match(/<iframe\b[^>]*>/)?.[0]).toContain(`src="${escapedUrl}"`);
  expect(html.match(/<a\b[^>]*>/)?.[0]).toContain(
    `href="${escapedUrl}" target="_blank" rel="noreferrer"`,
  );
  expect(html).toContain("在新标签页打开");
});

function renderWencai(state: unknown[]) {
  hooks.wencai = { state, cursor: 0 };
  try {
    return ThsdkWencaiPanel();
  } finally {
    hooks.wencai = null;
  }
}

function findPresetClick(node: ReactNode): (() => void) | undefined {
  if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node))
    return undefined;
  if (node.props.children === "连续3日上涨") return node.props.onClick;
  return Children.toArray(node.props.children)
    .map(findPresetClick)
    .find(Boolean);
}

it("fetches quotes after a 问财 submission and fills the name, price and change columns", () => {
  const state: unknown[] = [];
  const initial = renderWencai(state);
  expect(renderToStaticMarkup(initial)).toContain("查询问财");
  expect(requestOverviewQuotes).not.toHaveBeenCalled();

  const submitPreset = findPresetClick(initial);
  expect(submitPreset).toBeTypeOf("function");
  submitPreset!();
  const html = renderToStaticMarkup(renderWencai(state));
  expect(requestOverviewQuotes).toHaveBeenCalledExactlyOnceWith([
    "sh600519",
    "sz002548",
  ]);
  expect(html).toContain('aria-label="问财选股结果"');
  expect(html).toMatch(/role="columnheader"[^>]*>最新价</);
  expect(html).toMatch(/role="columnheader"[^>]*>涨跌幅</);
  const cells = Array.from(
    html.matchAll(/<div role="cell"[^>]*>(.*?)<\/div>/g),
    ([, content]) => content!.replace(/<[^>]+>/g, ""),
  );
  expect(cells).toEqual([
    "贵州茅台 · SH600519",
    "105.00",
    "+5.00%",
    "金新农 · SZ002548",
    "—",
    "—",
  ]);
});
