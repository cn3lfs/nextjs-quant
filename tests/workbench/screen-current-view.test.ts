import { expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("~/components/screening/formula-screen", () => ({
  FormulaScreen: () => createElement("section", null, "current-formula-editor"),
}));
vi.mock("~/components/research/factor-evaluation-panel", () => ({
  FactorEvaluationPanel: () =>
    createElement("section", null, "current-factor-evaluation"),
}));
vi.mock("~/components/screening/screen-task-progress", () => ({
  ScreenTaskProgress: () => null,
}));
import { ScreenView } from "~/components/workbench/screen-view";

it("shows current formula/factor workflows without old condition editors or automatic-analysis promises", () => {
  const state = {
    names: {},
    jobs: { data: [] },
    screened: {},
    reviews: {},
    screenReport: {},
    screenPage: 0,
    excludedPage: 0,
    errorPage: 0,
    screenQuery: "",
    screenSort: "original",
    screenDirection: "desc",
  } as unknown as Parameters<typeof ScreenView>[0]["state"];
  const html = renderToStaticMarkup(createElement(ScreenView, { state }));
  expect(html).toContain("current-formula-editor");
  expect(html).toContain("单因子评估");
  expect(html).not.toContain("本地条件草案");
  expect(html).not.toContain("本地可复现条件");
  expect(html).not.toContain("生成条件草案");
  expect(html).not.toContain("默认自动进行 AI");
  expect(html).toContain("不会自动生成分析、通知或交易");
});
