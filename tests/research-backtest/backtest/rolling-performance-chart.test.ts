import { expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  series: [] as { pane: number; data: { time: string; value?: number }[] }[],
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
    addSeries: (_kind: unknown, _options: unknown, pane: number) => {
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
import { RollingPerformanceChart } from "../../../src/components/market/chart";

it("the actual chart sends three panes with separate null segments and cleans up", () => {
  const points = [1, null, 0, 2].map((value, i) => ({
    endDate: `2026-01-0${i + 5}`,
    sharpeWbt: value,
    maxDrawdown: value,
    annualReturn: value,
    insufficientCoverage: i === 0,
  }));
  const view = RollingPerformanceChart({ points, simple: false });
  expect(view.props["role"]).toBe("img");
  expect(harness.series).toHaveLength(9);
  for (const pane of [0, 1, 2]) {
    const series = harness.series.filter((s) => s.pane === pane);
    expect(series[0]!.data).toEqual(points.map((p) => ({ time: p.endDate })));
    expect(series[1]!.data).toEqual([{ time: "2026-01-05", value: 1 }]);
    expect(series[2]!.data).toEqual([
      { time: "2026-01-07", value: 0 },
      { time: "2026-01-08", value: 2 },
    ]);
  }
  expect(harness.fit).toHaveBeenCalledOnce();
  harness.cleanup!();
  expect(harness.remove).toHaveBeenCalledOnce();
});
