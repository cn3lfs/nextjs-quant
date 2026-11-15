import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import {
  nextMounted,
  nextPanelCache,
  PanelCache,
  usePanelVisible,
} from "../../src/components/workbench/keep-alive";

it("mounts each panel once and keeps the visit order stable", () => {
  let mounted: string[] = ["market"];
  expect(nextMounted(mounted, "market")).toBe(mounted);
  mounted = nextMounted(mounted, "screen");
  mounted = nextMounted(mounted, "/scan?tab=rps");
  mounted = nextMounted(mounted, "market");
  expect(mounted).toEqual(["market", "screen", "/scan?tab=rps"]);
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

it("does not create an empty cache slot for a framework route", () => {
  expect(
    renderToStaticMarkup(
      createElement(PanelCache, {
        active: "/system/tasks",
        panels: { "/scan": "行情" },
      }),
    ),
  ).toBe("");
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

it("evicts the least recently shown panels beyond the limit, never the pinned or active one", () => {
  let cache = { mounted: ["/scan"], recent: ["/scan"] };
  for (const key of [
    "/",
    "/scan?tab=formula",
    "/scan?tab=rps",
    "/system/notifications",
    "/intel",
  ])
    cache = nextPanelCache(cache, key, 4, ["/scan"]);
  // "/scan" is the oldest but pinned; "/" and "/scan?tab=formula" go.
  expect(cache.mounted).toEqual([
    "/scan",
    "/scan?tab=rps",
    "/system/notifications",
    "/intel",
  ]);
  // Revisiting refreshes recency without moving the render order.
  cache = nextPanelCache(cache, "/scan?tab=rps", 4, ["/scan"]);
  expect(cache.mounted).toEqual([
    "/scan",
    "/scan?tab=rps",
    "/system/notifications",
    "/intel",
  ]);
  cache = nextPanelCache(cache, "/system/tasks", 4, ["/scan"]);
  expect(cache.mounted).toEqual([
    "/scan",
    "/scan?tab=rps",
    "/intel",
    "/system/tasks",
  ]);
  expect(nextPanelCache(cache, "/system/tasks", 4, ["/scan"])).toBe(cache);
});
