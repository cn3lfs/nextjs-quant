import { initTRPC } from "@trpc/server";
import { expect, it, vi } from "vitest";
import {
  capabilityAllows,
  isCapabilityBinding,
} from "~/lib/common/capabilities";
import { appRouter } from "~/server/api/root";
import { capabilityProcedure, createTRPCRouter } from "~/server/api/trpc";

vi.mock("~/lib/common/capabilities", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/lib/common/capabilities")>();
  return { ...actual, capabilityAllows: vi.fn(actual.capabilityAllows) };
});

type Procedure = { _def: { meta?: unknown } };
function assertDeclaredCapabilities(procedures: Record<string, Procedure>) {
  for (const [name, procedure] of Object.entries(procedures)) {
    expect(
      isCapabilityBinding(procedure._def.meta),
      `${name} must declare its capability and operation`,
    ).toBe(true);
  }
}

it("every registered API explicitly declares a known capability and operation", () => {
  assertDeclaredCapabilities(appRouter._def.procedures);
});

it.each(["query", "mutation"] as const)(
  "checks policy before executing a %s handler",
  async (kind) => {
    const handler = vi.fn(() => "executed");
    const policy = vi.mocked(capabilityAllows);
    const caller = createTRPCRouter({
      run: capabilityProcedure("market", "compute")[kind](handler),
    }).createCaller({ headers: new Headers() });

    policy.mockClear();
    policy.mockReturnValueOnce(false);
    await expect(caller.run()).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(policy).toHaveBeenCalledExactlyOnceWith("market", "compute");
    expect(handler).not.toHaveBeenCalled();

    policy.mockClear();
    policy.mockReturnValueOnce(true);
    await expect(caller.run()).resolves.toBe("executed");
    expect(policy).toHaveBeenCalledExactlyOnceWith("market", "compute");
    expect(handler).toHaveBeenCalledTimes(1);
  },
);

it.each([
  { capability: "future-capability", operation: "read" },
  { capability: "market", operation: "future-operation" },
  { capability: "constructor", operation: "read" },
  { capability: "__proto__", operation: "read" },
])("rejects an invalid capability binding %o", (meta) => {
  expect(() =>
    assertDeclaredCapabilities({ invalidMetadata: { _def: { meta } } }),
  ).toThrow("invalidMetadata must declare its capability and operation");
});

it.each([
  ["workspacePreferences", "settings", "read"],
  ["saveWorkspacePreferences", "settings", "configure"],
  ["strategyLabCompareRuns", "backtest", "read"],
  ["alertPipelineDiagnostics", "notifications", "read"],
  ["quickSearchSecurities", "market", "read"],
  ["configureBinancePublicDataRoot", "settings", "configure"],
  ["binancePublicDataStatus", "settings", "read"],
  ["startBinancePublicDataBackfill", "dataImport", "compute"],
  ["czsc", "nativeChart", "compute"],
  ["czscSchema", "nativeChart", "read"],
  ["maBaseline", "backtest", "compute"],
  ["strategyCenterRun", "strategyCenter", "compute"],
  ["formulaScreen", "formulaScreen", "compute"],
  ["breakout", "breakout", "compute"],
  ["rpsStart", "rps", "compute"],
  ["controlCryptoBot", "cryptoSimulation", "schedule"],
  ["syncCryptoAccount", "cryptoSimulation", "compute"],
  ["monitorWorkspaceSave", "signalMonitor", "configure"],
  ["ledgerHistory", "signalLedger", "read"],
  ["testChannel", "notifications", "compute"],
  ["marketPoolExport", "market", "read"],
] as const)(
  "%s keeps its reviewed business operation",
  (name, capability, operation) => {
    expect(appRouter._def.procedures[name]._def.meta).toEqual({
      capability,
      operation,
    });
  },
);

it.each(["query", "mutation"] as const)(
  "rejects an undeclared new %s even when all existing routes pass",
  (kind) => {
    const t = initTRPC.create();
    const undeclared = t.procedure[kind](() => null);
    // Check the actual added entry, not just a frozen list of existing names.
    expect(() =>
      assertDeclaredCapabilities({ newlyAddedExecution: undeclared }),
    ).toThrow("newlyAddedExecution must declare its capability");
  },
);
