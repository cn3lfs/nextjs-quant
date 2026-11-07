import { expect, it } from "vitest";
import {
  createTRPCContext,
  createTRPCRouter,
  publicProcedure,
} from "~/server/api/trpc";
import {
  deprecatedStrategyOperations,
  legacyAutomaticStrategiesEnabled,
  maBaselineId,
  strategyLifecycle,
} from "~/lib/backtest/strategy-lifecycle";
import { researchStrategyIds } from "~/lib/research/specs/research-strategies";
import { researchCompositePresetIds } from "~/lib/research/specs/research-composite-presets";
import { listStrategyRepresentatives } from "trading-strategies";

it("all previous methods, presets, representatives and unknown IDs are deprecated", () => {
  for (const id of [
    ...researchStrategyIds,
    ...researchCompositePresetIds,
    ...listStrategyRepresentatives().map((r) => r.id),
    "old-unknown",
  ])
    expect(strategyLifecycle(id)).toBe("deprecated");
  expect(strategyLifecycle(maBaselineId)).toBe("active");
  expect(legacyAutomaticStrategiesEnabled).toBe(false);
});
it("rejects deprecated RPC execution before side effects, keeps historical reads", async () => {
  let runs = 0;
  for (const name of deprecatedStrategyOperations) {
    const guarded = createTRPCRouter({
      [name]: publicProcedure.mutation(() => {
        runs++;
        return true;
      }),
    });
    const guardedCaller = guarded.createCaller(
      await createTRPCContext({ headers: new Headers() }),
    );
    await expect(guardedCaller[name]!()).rejects.toThrow("已弃用");
  }
  const router = createTRPCRouter({
    history: publicProcedure.query(() => "preserved"),
    maBaseline: publicProcedure.mutation(() => "active"),
  });
  const caller = router.createCaller(
    await createTRPCContext({ headers: new Headers() }),
  );
  expect(runs).toBe(0);
  expect(await caller.history()).toBe("preserved");
  expect(await caller.maBaseline()).toBe("active");
});
