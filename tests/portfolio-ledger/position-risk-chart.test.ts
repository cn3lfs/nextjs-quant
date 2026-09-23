import { expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  series: [] as { pane: number; data: { time: string; value?: number }[] }[],
  options: [] as {
    color?: string;
    visible?: boolean;
    pointMarkersVisible?: boolean;
  }[],
  cleanup: undefined as undefined | (() => void),
  remove: vi.fn(),
  fit: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: () => ({ current: {} }),
  useEffect: (effect: () => () => void) => {
    harness.cleanup = effect();
  },
}));
vi.mock("lightweight-charts", async (original) => ({
  ...(await original<typeof import("lightweight-charts")>()),
  createChart: () => ({
    addSeries: (
      _kind: unknown,
      options: {
        color?: string;
        visible?: boolean;
        pointMarkersVisible?: boolean;
      },
      pane: number,
    ) => {
      harness.options.push(options);
      const series = { pane, data: [] as { time: string; value?: number }[] };
      harness.series.push(series);
      return {
        setData: (data: typeof series.data) => {
          series.data = data;
        },
      };
    },
    timeScale: () => ({ fitContent: harness.fit }),
    remove: harness.remove,
  }),
}));
import { PositionRiskChart } from "../../src/components/market/chart";

it("the actual chart sends two panes with separate null segments and cleans up", () => {
  const points = [1, null, 0, 2].map((value, i) => ({
    date: `2026-01-0${i + 5}`,
    effectivePositions: value,
    maxSingleWeight: value,
  }));
  vi.stubGlobal("getComputedStyle", () => ({
    getPropertyValue: () => "rgb(10, 20, 30)",
  }));
  const view = PositionRiskChart({ points });
  expect(view.props["role"]).toBe("img");
  expect(harness.series).toHaveLength(6);
  expect(harness.options.filter((o) => o.visible === false)).toHaveLength(2);
  expect(
    harness.options.filter((o) => o.color !== undefined).map((o) => o.color),
  ).toEqual(Array(4).fill("rgb(10, 20, 30)"));
  expect(
    harness.options.filter((o) => o.pointMarkersVisible === true),
  ).toHaveLength(2);
  for (const pane of [0, 1]) {
    const series = harness.series.filter((s) => s.pane === pane);
    expect(series[0]!.data).toEqual(points.map((p) => ({ time: p.date })));
    expect(series[1]!.data).toEqual([{ time: "2026-01-05", value: 1 }]);
    expect(series[2]!.data).toEqual([
      { time: "2026-01-07", value: 0 },
      { time: "2026-01-08", value: 2 },
    ]);
  }
  expect(harness.fit).toHaveBeenCalledOnce();
  harness.cleanup!();
  expect(harness.remove).toHaveBeenCalledOnce();
  vi.unstubAllGlobals();
});
