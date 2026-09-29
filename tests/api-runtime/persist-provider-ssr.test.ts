import { QueryClient, useIsRestoring } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, it } from "vitest";
import { PersistProvider } from "../../src/trpc/persist";

// The first render must match between server (no IndexedDB → no persister)
// and browser (persister): both start restoring, like the stock provider.
it("starts restoring on the server too, so hydration matches the browser", () => {
  const Probe = () => createElement("i", null, String(useIsRestoring()));
  const html = renderToString(
    createElement(PersistProvider, {
      client: new QueryClient(),
      persister: null,
      buster: "test",
      children: createElement(Probe),
    }),
  );
  expect(html).toBe("<i>true</i>");
});
