import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createCaller } from "../src/server/api/root";
import { get, put } from "../src/server/db";
import { defaultStrategy, type Job } from "../src/lib/domain";
import {
  type WalkForwardResult,
  walkForwardPage,
} from "../src/lib/walk-forward";
import { multipleTesting } from "../src/lib/multiple-testing";
import { combinatoriallySymmetricCv } from "../src/lib/backtest-overfit";

it("历史和任务响应剥离 λ，按需导出与数据库完整保留；旧档案与其他任务不变", async () => {
  const id = `walk-forward-${randomUUID()}`;
  const returns = [0.02, 0.001].map((m) =>
    Array.from({ length: 200 }, (_, i) => m + (i % 2 ? 0.01 : -0.01)),
  );
  const result: WalkForwardResult = {
    id,
    version: "walk-forward-1",
    symbol: "sh600000",
    snapshotId: "fixture",
    sourceHash: "fixture",
    initial: 100000,
    baseStrategy: defaultStrategy,
    options: { trainBars: 60, testBars: 20 },
    candidates: [],
    warmupBars: 0,
    unusedTailBars: 0,
    folds: [],
    assumptions: [],
    summary: {
      folds: 0,
      positiveFolds: 0,
      averageReturn: 0,
      medianReturn: 0,
      worstReturn: 0,
      worstDrawdown: 0,
      averageBenchmarkReturn: 0,
    },
    multipleTesting: {
      ...multipleTesting(returns[0]!, [
        { value: 1, reason: null },
        { value: 2, reason: null },
      ]),
      overfit: {
        bySelectionRule: combinatoriallySymmetricCv({
          returns,
          candidates: [defaultStrategy, { ...defaultStrategy, fast: 3 }],
        }),
        bySharpe: combinatoriallySymmetricCv({ returns, metric: "sharpe" }),
      },
    },
  };
  put("walk-forward", id, result);
  const job: Job = {
    id: `job-${randomUUID()}`,
    type: "walk-forward",
    status: "completed",
    progress: 100,
    createdAt: 0,
    updatedAt: 0,
    input: {},
    result,
  };
  put("job", job.id, job);
  const caller = createCaller({ headers: new Headers() });
  const page = await caller.walkForwardResult(id);
  expect(page).toEqual(walkForwardPage(result));
  expect(page!.multipleTesting!.overfit).not.toHaveProperty("lambdas");
  expect((await caller.job({ id: job.id }))!.result).toEqual(page);
  const exported = (await caller.walkForwardExport(id))!.multipleTesting!
    .overfit!;
  if (!("bySelectionRule" in exported)) throw new Error("缺少双口径");
  for (const key of ["bySelectionRule", "bySharpe"] as const) {
    expect(exported[key].lambdas).toHaveLength(252);
    expect(page!.multipleTesting!.overfit).not.toHaveProperty(`${key}.lambdas`);
  }
  expect(await caller.walkForwardExport(id)).toEqual(result);
  expect(get<WalkForwardResult>(id)).toEqual(result);
  // V2 老档案保留夏普含义，普通响应仍剥离旧顶层 λ。
  put("walk-forward", id, {
    ...result,
    multipleTesting: { ...result.multipleTesting!, overfit: exported.bySharpe },
  });
  expect(
    (await caller.walkForwardResult(id))!.multipleTesting!.overfit,
  ).not.toHaveProperty("lambdas");
  expect(
    (await caller.walkForwardExport(id))!.multipleTesting!.overfit,
  ).toEqual(exported.bySharpe);
  const { overfit: _overfit, ...v1 } = result.multipleTesting!;
  put("walk-forward", id, { ...result, multipleTesting: v1 });
  expect(await caller.walkForwardResult(id)).toEqual({
    ...result,
    multipleTesting: v1,
  });
  put("job", job.id, { ...job, type: "backtest", result: { lambdas: [1] } });
  expect((await caller.job({ id: job.id }))!.result).toEqual({ lambdas: [1] });
  expect(
    await caller.walkForwardResult(`walk-forward-${randomUUID()}`),
  ).toBeNull();
});
