import type { ReactElement, ReactNode, SetStateAction } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Drawing } from "../../../src/lib/chart/chart-view";

// Exercise the workspace's actual tool/anchor event wiring without starting
// a browser, native chart, network client or persistence timer.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0 }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState<T>(initial: T | (() => T)) {
    const index = hooks.cursor++;
    if (!(index in hooks.slots))
      hooks.slots[index] =
        typeof initial === "function" ? (initial as () => T)() : initial;
    return [
      hooks.slots[index] as T,
      (next: SetStateAction<T>) => {
        hooks.slots[index] =
          typeof next === "function"
            ? (next as (previous: T) => T)(hooks.slots[index] as T)
            : next;
      },
    ];
  },
  useEffect() {},
  useMemo: (factory: () => unknown) => factory(),
  useCallback: (callback: unknown) => callback,
}));
vi.mock("~/components/workbench/use-task-visible", () => ({
  useScreenVisible: () => true,
}));
vi.mock("~/components/market/chart", () => ({
  CzscMarketChart: () => null,
  MarketChart: () => null,
}));
vi.mock("~/components/market/tdx-side-panel", () => ({
  tradableSymbol: () => false,
}));
vi.mock("~/components/market/czsc-settings-dialog", () => ({
  CzscSettingsDialog: () => null,
}));
vi.mock("~/components/news/intel-annotations", () => ({
  IntelAnnotations: () => null,
}));
vi.mock("~/components/market/security-select", () => ({
  SecuritySelect: () => null,
}));
vi.mock("~/trpc/react", () => ({
  api: new Proxy(
    {
      useUtils: () => ({}),
      useQueries: () => [],
      saveChartView: { useMutation: () => ({ error: null }) },
      chartView: { useQuery: vi.fn() },
      chartBars: { useQuery: vi.fn() },
    },
    {
      get: (target, name) =>
        Reflect.get(target, name) ?? { useQuery: () => ({ data: [] }) },
    },
  ),
}));
import { ChartWorkspace } from "../../../src/components/market/chart-workspace";
import { defaultChartView } from "../../../src/lib/chart/chart-view";
import { api } from "../../../src/trpc/react";

type Node = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Node[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Node;
  return [element, ...elements(element.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (node && typeof node === "object" && "props" in node)
    return text((node as ReactElement<{ children: ReactNode }>).props.children);
  return node == null ? "" : String(node);
}
let render: () => Node;
afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  hooks.slots = [];
  hooks.cursor = 0;
  const snapshot = {
    id: "drawing-fixture",
    symbol: "sh600000",
    bars: [],
    period: "day" as const,
    source: "tdx-local",
    adjustment: "none" as const,
    hash: "fixture",
    createdAt: 1,
  };
  vi.spyOn(api.chartView, "useQuery").mockReturnValue({
    data: defaultChartView,
  } as ReturnType<typeof api.chartView.useQuery>);
  vi.spyOn(api.chartBars, "useQuery").mockReturnValue({
    data: snapshot,
  } as ReturnType<typeof api.chartBars.useQuery>);
  const child = ChartWorkspace({
    snapshot,
    period: "day",
    adjustment: "none",
  }) as Node;
  hooks.slots = [];
  render = () => {
    hooks.cursor = 0;
    return (child.type as (props: typeof child.props) => Node)(child.props);
  };
});
function choose(ui: Node, tool: string) {
  const button = elements(ui).find(
    (node) =>
      text(node.props.children as ReactNode) === tool &&
      typeof node.props.onClick === "function",
  )!;
  (button.props.onClick as () => void)();
}
function chart(ui: Node) {
  const annotations = elements(ui).find(
    (node) => typeof node.props.render === "function",
  )!;
  return (
    annotations.props.render as (events: never[], select: () => void) => Node
  )([], () => {}).props;
}
it.each([
  { tool: "trend", label: "趋势线", count: 0 },
  { tool: "channel", label: "平行通道", count: 2 },
])(
  "Escape from the drawing popover cancels $tool and its $count anchors",
  ({ tool, label, count }) => {
    choose(render(), label);
    for (let i = 0; i < count; i++)
      (chart(render()).onAnchor as (point: Drawing["a"]) => void)({
        date: "2026-11-16",
        price: 10 + i,
      });
    const ui = render();
    expect(chart(ui).drawingTool).toBe(tool);
    expect(chart(ui).drawingPoints).toHaveLength(count);
    const popover = elements(ui).find(
      (node) => node.props["aria-label"] === "画线工具设置",
    )!;
    const event = { preventDefault: vi.fn() };
    expect(popover.props.onEscapeKeyDown).toBeTypeOf("function");
    (popover.props.onEscapeKeyDown as (keyboardEvent: typeof event) => void)(
      event,
    );
    const after = render();
    expect(text(after)).toContain("画线：浏览");
    expect(chart(after).drawingPoints).toEqual([]);
    expect(chart(after).drawingTool).toBe("none");
    expect((chart(after).view as typeof defaultChartView).drawings).toEqual([]);
    expect(event.preventDefault).not.toHaveBeenCalled();
  },
);
