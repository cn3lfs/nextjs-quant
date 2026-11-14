import { afterEach, expect, test } from "vitest";
import { useMarketSession } from "../../src/lib/stores/market-session";
import type { Snapshot } from "../../src/lib/domain";

const initial = useMarketSession.getState();
afterEach(() => useMarketSession.setState(initial, true));

const candidate: Snapshot = {
  id: "local-formula-candidate",
  symbol: "sh600001",
  period: "day",
  source: "tdx-local",
  bars: [],
  createdAt: 1,
  adjustment: "none",
  hash: "synthetic-candidate",
};

test("a local candidate pins local browsing before default settings arrive", () => {
  useMarketSession.getState().acceptSnapshot(candidate);
  expect(useMarketSession.getState()).toMatchObject({
    loaded: candidate,
    marketSource: "local",
    snapshotSource: "local",
  });
});

test("an explicit request source owns a saved snapshot's continuation", () => {
  useMarketSession
    .getState()
    .acceptSnapshot({ ...candidate, requestedSource: "auto" });
  expect(useMarketSession.getState()).toMatchObject({
    marketSource: "auto",
    snapshotSource: "auto",
  });
});

test("unknown snapshot provenance preserves the existing source choice", () => {
  useMarketSession.getState().setMarketSource("tencent");
  useMarketSession
    .getState()
    .acceptSnapshot({ ...candidate, source: "unknown" });
  expect(useMarketSession.getState()).toMatchObject({
    marketSource: "tencent",
    snapshotSource: null,
  });
});
