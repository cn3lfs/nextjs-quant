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

it("evicts the least recently shown panels beyond the limit, never the pinned or active one", () => {
  let cache = { mounted: ["/market"], recent: ["/market"] };
  for (const key of ["/", "/screen", "/rps", "/signals", "/news"])
    cache = nextPanelCache(cache, key, 4, ["/market"]);
  // "/market" is the oldest but pinned; "/" and "/screen" go.
  expect(cache.mounted).toEqual(["/market", "/rps", "/signals", "/news"]);
  // Revisiting refreshes recency without moving the render order.
  cache = nextPanelCache(cache, "/rps", 4, ["/market"]);
  expect(cache.mounted).toEqual(["/market", "/rps", "/signals", "/news"]);
  cache = nextPanelCache(cache, "/tasks", 4, ["/market"]);
  expect(cache.mounted).toEqual(["/market", "/rps", "/news", "/tasks"]);
  expect(nextPanelCache(cache, "/tasks", 4, ["/market"])).toBe(cache);
});
