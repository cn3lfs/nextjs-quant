import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import {
  nextMounted,
  PanelCache,
  usePanelVisible,
} from "../src/components/workbench/keep-alive";

it("mounts each panel once and keeps the visit order stable", () => {
  let mounted: string[] = ["market"];
  expect(nextMounted(mounted, "market")).toBe(mounted);
  mounted = nextMounted(mounted, "screen");
  mounted = nextMounted(mounted, "/rps");
  mounted = nextMounted(mounted, "market");
  expect(mounted).toEqual(["market", "screen", "/rps"]);
});

it("renders only the active panel of a cached slot", () => {
  const html = renderToStaticMarkup(
    createElement(PanelCache, {
      active: "screen",
      panels: { market: "行情", screen: "选股" },
    }),
  );
  expect(html).toBe("<div>选股</div>");
});

it("reports hidden panels as not visible", () => {
  function Probe({ label }: { label: string }) {
    return createElement("span", null, `${label}:${usePanelVisible()}`);
  }
  const html = renderToStaticMarkup(
    createElement(PanelCache, {
      active: "a",
      panels: {
        a: createElement(Probe, { label: "shown" }),
        b: createElement(Probe, { label: "hidden" }),
      },
    }),
  );
  // Only the active panel is mounted at first, and it is visible.
  expect(html).toBe("<div><span>shown:true</span></div>");
  expect(renderToStaticMarkup(createElement(Probe, { label: "outside" }))).toBe(
    "<span>outside:true</span>",
  );
});
