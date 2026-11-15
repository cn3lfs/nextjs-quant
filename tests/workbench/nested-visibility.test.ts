import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import {
  PanelCache,
  PanelVisibility,
  usePanelVisible,
} from "~/components/workbench/keep-alive";
function Probe() {
  return createElement("p", null, usePanelVisible() ? "visible" : "hidden");
}
it("a selected Scan tab cannot reactivate queries or hotkeys when its parent workspace is hidden", () => {
  const nested = createElement(PanelCache, {
    active: "chart",
    panels: { chart: createElement(Probe) },
  });
  expect(
    renderToStaticMarkup(
      createElement(PanelVisibility, { visible: false, children: nested }),
    ),
  ).toContain("<p>hidden</p>");
  expect(
    renderToStaticMarkup(
      createElement(PanelVisibility, { visible: true, children: nested }),
    ),
  ).toContain("<p>visible</p>");
});
