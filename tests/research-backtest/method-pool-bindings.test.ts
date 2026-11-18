import { describe, expect, it } from "vitest";
import {
  assertBindingMarket,
  assertMethodPoolBinding,
  bindingForStrategy,
  bindingSupportsMarket,
  entryStudyBindingsForPreset,
  entryStudyPresets,
  entryStudyStrategyIds,
  isEntryStudyStrategy,
  isMethodPoolRegistrationVersion,
  methodPoolBindingKinds,
  methodPoolBindings,
  methodPoolBindingsForPreset,
  methodPoolMarkets,
  methodPoolRegistrationVersions,
  methodPoolRoleForStrategy,
  portfolioBindingsForPreset,
  sourceExitPresets,
  technicalEntryStudyExclusions,
  technicalSourceExitExclusions,
  type MethodPoolBinding,
} from "~/lib/research/method-pool-bindings";
import {
  labPortfolioCandidateRoles,
  tenPositionRegistrationVersions,
} from "~/lib/research/lab-portfolio-evidence";
import { technicalMethodIds } from "trading-strategies/research/technical/research-technical-methods";

describe("method pool preset -> strategy -> market bindings", () => {
  it("binds every technical preset to at most one direct run role", () => {
    for (const preset of technicalMethodIds) {
      const entry = entryStudyBindingsForPreset(preset);
      const source = portfolioBindingsForPreset(preset).filter(
        (binding) => binding.kind === "source-exit",
      );
      expect(entry.length).toBeLessThanOrEqual(1);
      expect(source.length).toBeLessThanOrEqual(1);
      if (!entry.length)
        expect(
          technicalEntryStudyExclusions[preset],
          `${preset} has no entry study or recorded exclusion`,
        ).toBeTruthy();
      if (!source.length)
        expect(
          technicalSourceExitExclusions[preset],
          `${preset} has no source exit or recorded exclusion`,
        ).toBeTruthy();
    }
  });

  it("keeps entry experiments, original exits and proxies distinct", () => {
    expect(isEntryStudyStrategy("entry5-sw-macd-red")).toBe(true);
    expect(isEntryStudyStrategy("research-growth")).toBe(true);
    expect(isEntryStudyStrategy("source-sw-macd-red")).toBe(false);
    expect(isEntryStudyStrategy("research-volume-price")).toBe(false);

    expect(bindingForStrategy("source-sw-macd-red")).toMatchObject({
      preset: "sw-macd-red",
      kind: "source-exit",
    });
    expect(bindingForStrategy("research-breakout")).toMatchObject({
      preset: "sw-double-prior20",
      kind: "proxy",
    });
    expect(bindingForStrategy("research-volume-price-protected")).toMatchObject(
      {
        preset: "vp-up-expanded-confirm",
        kind: "protected",
      },
    );

    expect(portfolioBindingsForPreset("sw-macd-negative")).toContainEqual(
      expect.objectContaining({
        strategyId: "source-sw-macd-negative",
        kind: "source-exit",
      }),
    );
    expect(entryStudyBindingsForPreset("sw-macd-negative")).toEqual([]);
  });

  it("does not present a proxy as a direct run or an entry experiment as a portfolio", () => {
    const proxy = portfolioBindingsForPreset("sw-double-prior20");
    expect(proxy.map((binding) => binding.strategyId)).toEqual([
      "research-breakout",
    ]);
    expect(proxy[0]!.kind).toBe("proxy");
    expect(entryStudyBindingsForPreset("sw-double-prior20")).toEqual([]);

    const entryIds = entryStudyStrategyIds();
    expect(entryIds).toContain("entry5-sw-macd-red");
    expect(entryIds).toContain("entry5-wy-sos-jac-daily");
    expect(entryIds).toContain("entry5-canslim-high-98");
    expect(entryIds).toContain("research-growth");
    expect(entryIds).not.toContain("entry5-sw-macd-negative");
    expect(entryIds).not.toContain("entry5-wy-ut-exit-daily");
    expect(entryIds).not.toContain("source-sw-macd-red");
    expect(new Set(entryIds).size).toBe(entryIds.length);

    // research-growth and the CANSLIM entry5 rule share a source preset but
    // remain separate strategies in the evidence table.
    expect(
      entryStudyBindingsForPreset("canslim-high-98").map(
        (binding) => binding.strategyId,
      ),
    ).toEqual(expect.arrayContaining(["entry5-canslim-high-98"]));
    expect(bindingForStrategy("research-growth")!.preset).toBe(
      "canslim-high-98",
    );
  });

  it("rejects a market that the binding does not declare", () => {
    const cnOnly: MethodPoolBinding = {
      preset: "fixture",
      strategyId: "fixture-cn",
      kind: "proxy",
      markets: ["cn-equity"],
    };
    expect(bindingSupportsMarket(cnOnly, "cn-equity")).toBe(true);
    expect(bindingSupportsMarket(cnOnly, "crypto")).toBe(false);
    expect(() => assertBindingMarket(cnOnly, "crypto")).toThrow(
      /has no crypto market/,
    );
    expect(() => assertBindingMarket(cnOnly, "options" as "crypto")).toThrow(
      /has no options market/,
    );
  });

  it("rejects malformed bindings instead of silently widening scope", () => {
    expect(() =>
      assertMethodPoolBinding({
        preset: "",
        strategyId: "fixture",
        kind: "proxy",
        markets: ["cn-equity"],
      }),
    ).toThrow(/needs a preset/);
    expect(() =>
      assertMethodPoolBinding({
        preset: "fixture",
        strategyId: "fixture",
        kind: "unknown" as "proxy",
        markets: ["cn-equity"],
      }),
    ).toThrow(/Unknown method pool binding kind/);
    expect(() =>
      assertMethodPoolBinding({
        preset: "fixture",
        strategyId: "fixture",
        kind: "proxy",
        markets: [],
      }),
    ).toThrow(/has no market/);
    expect(() =>
      assertMethodPoolBinding({
        preset: "fixture",
        strategyId: "fixture",
        kind: "proxy",
        markets: ["cn-equity", "cn-equity"],
      }),
    ).toThrow(/repeats a market/);
  });

  it("keeps old and new registration versions readable", () => {
    expect(isMethodPoolRegistrationVersion("theory-study-ten-2")).toBe(true);
    expect(isMethodPoolRegistrationVersion("theory-study-ten-3")).toBe(true);
    expect(isMethodPoolRegistrationVersion("theory-study-ten-1")).toBe(false);
    expect(isMethodPoolRegistrationVersion("")).toBe(false);
  });

  it("keeps the lab import vocabulary aligned with the central bindings", () => {
    expect([...tenPositionRegistrationVersions]).toEqual([
      ...methodPoolRegistrationVersions,
    ]);
    expect([...labPortfolioCandidateRoles]).toEqual([
      ...methodPoolBindingKinds,
      "unbound",
    ]);
    expect(methodPoolRoleForStrategy("entry5-sw-macd-red")).toBe(
      "entry-experiment",
    );
    expect(methodPoolRoleForStrategy("source-sw-macd-red")).toBe("source-exit");
    expect(methodPoolRoleForStrategy("research-breakout")).toBe("proxy");
    expect(methodPoolRoleForStrategy("research-volume-price-protected")).toBe(
      "protected",
    );
    expect(methodPoolRoleForStrategy("rsi2")).toBe("unbound");
    // Old evidence keeps its role even when a preset is no longer bound.
    expect(methodPoolRoleForStrategy("entry5-removed-preset")).toBe(
      "entry-experiment",
    );
  });

  it("keeps the frozen enumeration entry points deduplicated", () => {
    // The documented batches are 32 entry studies per market and 28 source
    // exits. A new binding must update the batch evidence, not slip in silently.
    expect(entryStudyStrategyIds()).toHaveLength(32);
    expect(entryStudyPresets()).toHaveLength(31);
    expect(sourceExitPresets()).toHaveLength(28);
    expect(new Set(entryStudyPresets()).size).toBe(entryStudyPresets().length);
    expect(new Set(sourceExitPresets()).size).toBe(sourceExitPresets().length);
    expect(new Set(methodPoolBindings.map((row) => row.strategyId)).size).toBe(
      methodPoolBindings.length,
    );
    for (const binding of methodPoolBindings)
      for (const market of binding.markets)
        expect(methodPoolMarkets).toContain(market);
    expect(methodPoolBindingsForPreset("not-a-preset")).toEqual([]);
    expect(bindingForStrategy("not-a-strategy")).toBeUndefined();
  });
});
