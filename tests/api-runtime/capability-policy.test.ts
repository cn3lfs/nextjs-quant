import { expect, it, vi } from "vitest";
import { createTRPCRouter, capabilityProcedure } from "~/server/api/trpc";

it.each(["intraday", "signalMonitor", "signalLedger"] as const)(
  "blocks paused %s by explicit capability before executing a handler",
  async (capability) => {
    const effect = vi.fn();
    const router = createTRPCRouter({
      renamedExecution: capabilityProcedure(capability, "compute").mutation(
        effect,
      ),
    });
    await expect(
      router.createCaller({ headers: new Headers() }).renamedExecution(),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("统一"),
    });
    expect(effect).not.toHaveBeenCalled();
  },
);

it("does not gate another capability by a coincidentally identical route name", async () => {
  const router = createTRPCRouter({
    intradayRun: capabilityProcedure("formulaScreen", "compute").mutation(
      () => "computed",
    ),
    history: capabilityProcedure("intraday", "read").query(() => "readable"),
  });
  const caller = router.createCaller({ headers: new Headers() });
  expect(await caller.intradayRun()).toBe("computed");
  expect(await caller.history()).toBe("readable");
});

it.each(["intraday", "signalMonitor", "signalLedger"] as const)(
  "blocks query computations and scheduling for paused %s but allows configuration",
  async (capability) => {
    const effect = vi.fn();
    const router = createTRPCRouter({
      chart: capabilityProcedure(capability, "compute").query(effect),
      schedule: capabilityProcedure(capability, "schedule").mutation(effect),
      configure: capabilityProcedure(capability, "configure").mutation(
        () => "saved",
      ),
    });
    const caller = router.createCaller({ headers: new Headers() });
    await expect(caller.chart()).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    await expect(caller.schedule()).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(effect).not.toHaveBeenCalled();
    expect(await caller.configure()).toBe("saved");
  },
);

it.each([
  // Deliberately bypass TypeScript to check the runtime fail-closed boundary too.
  // @ts-expect-error New routes cannot omit the binding.
  () => capabilityProcedure(),
  // @ts-expect-error Unknown capability identifiers cannot create new APIs.
  () => capabilityProcedure("missing-capability", "compute"),
  // @ts-expect-error Prototype properties are not capability identifiers.
  () => capabilityProcedure("__proto__", "compute"),
  // @ts-expect-error Unknown operations are not accepted.
  () => capabilityProcedure("formulaScreen", "execute"),
])("rejects an invalid binding before invoking a handler", async (build) => {
  const effect = vi.fn();
  const router = createTRPCRouter({ execution: build().mutation(effect) });
  await expect(
    router.createCaller({ headers: new Headers() }).execution(),
  ).rejects.toMatchObject({
    code: "INTERNAL_SERVER_ERROR",
    message: "接口未声明有效能力",
  });
  expect(effect).not.toHaveBeenCalled();
});

it("does not grant an undeclared operation to an otherwise active capability", async () => {
  const effect = vi.fn();
  const router = createTRPCRouter({
    schedule: capabilityProcedure("formulaScreen", "schedule").mutation(effect),
  });
  await expect(
    router.createCaller({ headers: new Headers() }).schedule(),
  ).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
  });
  expect(effect).not.toHaveBeenCalled();
});
