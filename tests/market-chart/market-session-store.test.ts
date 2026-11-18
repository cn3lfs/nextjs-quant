import { afterEach, expect, test } from "vitest";
import {
  marketSelectionHref,
  planMarketRead,
  useMarketSession,
} from "../../src/lib/stores/market-session";
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

test("frozen restore is marked in client memory and an ordinary read clears it", () => {
  const before = useMarketSession.getState().revision;
  useMarketSession.getState().acceptFrozenSnapshot(candidate);
  expect(useMarketSession.getState().loaded).toMatchObject({
    id: candidate.id,
    frozenCandidate: true,
  });
  // The revision bump rejects an ordinary response still in flight.
  expect(useMarketSession.getState().revision).toBe(before + 1);
  // The same content id from an ordinary read is no longer frozen evidence.
  useMarketSession.getState().acceptSnapshot({ ...candidate });
  expect(useMarketSession.getState().loaded?.frozenCandidate).toBeUndefined();
});

const requested = {
  symbol: "sh600001",
  period: "day",
  source: "local",
} as const;
const ordinaryRead = {
  loaded: candidate,
  snapshotSource: "local" as const,
  request: null,
  revision: 2,
  requested,
};
const sameKey = {
  key: JSON.stringify([requested.symbol, requested.period, requested.source]),
  revision: 2,
};

test("leaving frozen evidence reads fresh even for the same security", () => {
  expect(
    planMarketRead({
      ...ordinaryRead,
      loaded: { ...candidate, frozenCandidate: true },
    }),
  ).toEqual({ read: true, fresh: true });
});

test("an ordinary same-security route keeps its loaded snapshot", () => {
  expect(planMarketRead(ordinaryRead)).toEqual({ read: false });
});

test("a changed security or source stays on the ordinary read branch", () => {
  expect(
    planMarketRead({
      ...ordinaryRead,
      requested: { ...requested, symbol: "sh600002" },
    }),
  ).toEqual({ read: true, fresh: false });
  expect(
    planMarketRead({
      ...ordinaryRead,
      requested: { ...requested, source: "tencent" },
    }),
  ).toEqual({ read: true, fresh: false });
});

test("an in-flight request for the same key is never duplicated", () => {
  expect(planMarketRead({ ...ordinaryRead, request: sameKey })).toEqual({
    read: false,
  });
  // A fresh exit already running must not restart when the route re-renders.
  expect(
    planMarketRead({
      ...ordinaryRead,
      loaded: { ...candidate, frozenCandidate: true },
      request: sameKey,
    }),
  ).toEqual({ read: false });
});

test("a pending request for another key still supersedes the chart", () => {
  expect(
    planMarketRead({
      ...ordinaryRead,
      request: {
        ...sameKey,
        key: JSON.stringify(["sh600002", "day", "local"]),
      },
    }),
  ).toEqual({ read: true, fresh: false });
});

test("switching to the ordinary chart drops frozen-route parameters", () => {
  const href = marketSelectionHref({
    symbol: "sh600001",
    chartPeriod: "5m",
    marketSource: "local",
    adjustment: "forward",
    marketView: "chart",
    period: "5m",
  });
  const params = new URL(href, "http://fixture").searchParams;
  expect(params.get("symbol")).toBe("sh600001");
  expect(params.get("period")).toBe("5m");
  expect(params.get("base")).toBe("5m");
  expect(params.get("source")).toBe("local");
  expect(params.get("adjustment")).toBe("forward");
  expect(params.has("screenSnapshot")).toBe(false);
  expect(params.has("screenJob")).toBe(false);
  expect(params.has("job")).toBe(false);
  expect(params.has("tab")).toBe(false);
});
