import { initTRPC } from "@trpc/server";
import { expect, it } from "vitest";
import {
  capabilities,
  capabilityAllows,
  isCapabilityBinding,
} from "~/lib/common/capabilities";
import { appRouter } from "~/server/api/root";

type Procedure = { _def: { meta?: unknown } };
function assertDeclaredCapabilities(procedures: Record<string, Procedure>) {
  for (const [name, procedure] of Object.entries(procedures)) {
    expect(procedure._def.meta, `${name} must declare its capability`).toEqual({
      capability: expect.stringMatching(
        new RegExp(`^(${Object.keys(capabilities).join("|")})$`),
      ),
      operation: expect.stringMatching(/^(read|configure|compute|schedule)$/),
    });
  }
}

it("every registered API explicitly declares a known capability and operation", () => {
  assertDeclaredCapabilities(appRouter._def.procedures);
});

it("only the explicitly paused intraday execution is denied in the current API", () => {
  const denied = Object.entries(appRouter._def.procedures)
    .filter(([, procedure]) => {
      const binding = procedure._def.meta;
      return (
        !isCapabilityBinding(binding) ||
        !capabilityAllows(binding.capability, binding.operation)
      );
    })
    .map(([name]) => name);
  expect(denied).toEqual(["intradayRun"]);
});

it.each([
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
