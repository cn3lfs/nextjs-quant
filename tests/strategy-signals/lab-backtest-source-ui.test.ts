import { beforeEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const location = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(location.search),
}));
vi.mock("~/components/workbench/keep-alive", () => ({
  usePanelVisible: () => true,
}));
vi.mock("~/trpc/react", () => ({
  api: {
    strategyLabDetail: { useQuery: () => ({ data: undefined }) },
    strategyLabBacktest: { useMutation: () => ({ isPending: false }) },
    strategyLabRegister: { useMutation: () => ({ isPending: false }) },
  },
}));
import { LabBacktest } from "../../src/components/research/lab-backtest";
beforeEach(() => {
  location.search = "";
});
it.each(["mode=object", "strategy=registered&version=2"])(
  "opens object form from an explicit %s entry",
  (search) => {
    location.search = search;
    expect(renderToStaticMarkup(createElement(LabBacktest))).toMatch(
      /<details[^>]* open=""/,
    );
  },
);
it("keeps the ordinary baseline entry collapsed", () => {
  expect(renderToStaticMarkup(createElement(LabBacktest))).not.toMatch(
    /<details[^>]* open=""/,
  );
});
it("offers explicit market and execution-period research presets", () => {
  const html = renderToStaticMarkup(createElement(LabBacktest));
  expect(html).toContain('aria-label="多周期研究预设"');
  expect(html).toContain('role="combobox"');
  expect(html).toContain("选择预设");
  expect(html).toContain("仅填入配置，不自动运行");
  expect(html).toContain("A股保持T+1");
});
