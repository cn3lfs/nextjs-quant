import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { expect, it, vi } from "vitest";

// Execute only the changed presentation function with controlled hooks/queries.
// This keeps real JSX and callbacks under test without a browser or strategy runtime.
function loadFunction(
  file: string,
  name: string,
  bindings: Record<string, unknown> = {},
) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const fn = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  )!;
  const emitted = ts.transpileModule(
    fn.getText(source).replace(/^export /, ""),
    {
      compilerOptions: {
        jsx: ts.JsxEmit.React,
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.None,
      },
    },
  ).outputText;
  return new Function(...Object.keys(bindings), `${emitted}; return ${name};`)(
    ...Object.values(bindings),
  );
}

it("T3 labels local calendar days explicitly without treating yesterday as today", () => {
  const age = loadFunction("src/lib/task-history.ts", "taskAge");
  const now = new Date(2026, 8, 10, 0, 1).getTime();
  expect(age(now, now)).toBe("今天");
  expect(age(new Date(2026, 8, 9, 23, 59).getTime(), now)).toBe("昨天");
  expect(age(new Date(2026, 8, 8).getTime(), now)).toBe("2 天前");
  expect(age(new Date(2026, 8, 11).getTime(), now)).toBe("未来日期");
  const source = readFileSync("src/components/task-history.tsx", "utf8");
  expect(source).toContain("taskAge(job.createdAt)");
  expect(source).toContain("stamp(job.createdAt)");
});

it("T3 mounts the same usable chart before annotation requests and fills results after paint", () => {
  let painted = "";
  const frames = new Map<number, () => void>();
  let nextFrame = 0;
  let effect: (() => () => void) | undefined;
  const czsc = vi.fn((_input: unknown, _options: unknown) => ({
    isPending: true,
    data: undefined as unknown,
  }));
  const breakout = vi.fn((_input: unknown, _options: unknown) => ({
    isPending: true,
    data: undefined as unknown,
  }));
  const MarketChart = () => null;
  const Component = loadFunction(
    "src/components/chart.tsx",
    "CzscMarketChart",
    {
      React: { createElement },
      MarketChart,
      useState: () => [
        painted,
        (value: string) => {
          painted = value;
        },
      ],
      useEffect: (callback: () => () => void) => {
        effect = callback;
      },
      requestAnimationFrame: (callback: () => void) => {
        frames.set(++nextFrame, callback);
        return nextFrame;
      },
      cancelAnimationFrame: (id: number) => frames.delete(id),
      api: { czsc: { useQuery: czsc }, breakout: { useQuery: breakout } },
    },
  );
  const props = {
    bars: [{ close: 10 }],
    period: "day",
    snapshotId: "snapshot-a",
  };
  const first = Component(props);
  expect(first.type).toBe(MarketChart);
  expect(first.props.bars).toBe(props.bars);
  expect(czsc).toHaveBeenLastCalledWith(
    { snapshotId: "snapshot-a", chartSnapshot: false },
    { enabled: false, staleTime: Infinity, retry: false },
  );
  expect(breakout).toHaveBeenLastCalledWith(
    { snapshotId: "snapshot-a", chartSnapshot: false },
    { enabled: false, staleTime: Infinity, retry: false },
  );
  const cleanup = effect!();
  frames.get(1)!();
  expect(painted).toBe("");
  frames.get(2)!();
  expect(painted).toBe("snapshot-a");
  const pending = Component(props);
  expect(pending.type).toBe(first.type);
  expect(pending.props.czscMessage).toBe("缠论标注后台加载中，K 线可正常浏览");
  expect(pending.props.breakoutMessage).toBe(
    "双突破标注后台加载中，K 线可正常浏览",
  );
  expect(czsc).toHaveBeenLastCalledWith(
    { snapshotId: "snapshot-a", chartSnapshot: false },
    { enabled: true, staleTime: Infinity, retry: false },
  );
  const structure = { status: "ok" },
    points = { points: [] };
  czsc.mockReturnValue({ isPending: false, data: structure });
  breakout.mockReturnValue({ isPending: false, data: points });
  const ready = Component(props);
  expect(ready.type).toBe(first.type);
  expect(ready.props.czsc).toBe(structure);
  expect(ready.props.breakout).toBe(points);
  expect(ready.props.czscMessage).toBeUndefined();
  expect(ready.props.breakoutMessage).toBeUndefined();
  Component({ ...props, snapshotId: "snapshot-b" });
  expect(czsc.mock.calls.at(-1)?.[1]).toMatchObject({ enabled: false });
  Component({ ...props, period: "5m" });
  expect(czsc.mock.calls.at(-1)?.[1]).toMatchObject({ enabled: true });
  expect(breakout.mock.calls.at(-1)?.[1]).toMatchObject({ enabled: true });
  Component({ ...props, period: "week", chartSnapshot: true });
  expect(czsc.mock.calls.at(-1)?.[1]).toMatchObject({ enabled: true });
  expect(breakout.mock.calls.at(-1)?.[0]).toMatchObject({
    chartSnapshot: true,
  });
  cleanup();
  expect(frames.size).toBe(0);
});
