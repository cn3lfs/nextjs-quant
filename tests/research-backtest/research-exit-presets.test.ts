import { expect, it } from "vitest";
import type { Bar } from "../../src/lib/domain";
import { researchManagementSchema } from "../../src/lib/research/workflow/research-management";
import {
  clearStaleExitPreset,
  matchesResearchExitPreset,
  researchExitPresetIds,
  isCanslimExitPreset,
  isSepaExitPreset,
  researchExitPresetTemplate,
  type ResearchExitPreset,
} from "../../src/lib/research/specs/research-exit-presets";
import { researchRManagementTemplate } from "trading-strategies/research/risk/research-r-management";
import { swingExitTemplate } from "trading-strategies/research/swing/research-swing-exits";
import { researchSpecSchema } from "../../src/lib/research/strategy-research";
import { researchMethodSnapshot } from "../../src/server/research/research-method";
import { atr, rollingHigh } from "../../src/lib/indicators";

const dates = Array.from({ length: 35 }, (_, i) =>
  new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
);
const base = researchManagementSchema.parse({
  stop: { kind: "percent", fraction: 0.1 },
});
function bars(): Bar[] {
  return dates.map((date, i) => {
    const open = i < 27 ? 50 : i === 27 ? 55 : i === 28 ? 62 : 67;
    const close =
      i < 26 ? 50 : i === 26 ? 55 : i === 27 ? 60 : i === 28 ? 65 : 67;
    return {
      date,
      open,
      close,
      high: Math.max(open, close) + 1,
      low: Math.min(open, close) - 1,
      volume: 10000,
      amount: 1000000,
    };
  });
}
function spec(kind: ResearchExitPreset) {
  return researchSpecSchema.parse({
    strategy: "dual-breakout",
    start: dates[25],
    end: dates[34],
    validationStart: dates[34],
    initialCapital: 50000,
    holdingDays: 60,
    risk: { fraction: 0.1, maxWeight: 1 },
    management: researchExitPresetTemplate(base, kind),
    costs: {
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
  });
}
it("trailing-only preset has no fixed profit target", () => {
  const input = bars();
  const expected = rollingHigh(input, 22)[26]! - 3 * atr(input, 22)[26]!;
  expect(expected).toBeGreaterThan(45);
  expect(spec("trail-only").management).not.toHaveProperty("scaleOut");
});
it("persists explicit identities, removes stale labels and keeps untagged legacy configurations unchanged", () => {
  for (const kind of researchExitPresetIds) {
    const selected = researchExitPresetTemplate(
      researchManagementSchema.parse({
        ...base,
        liquidityCap: true,
        timeExit: { days: 10, minR: 0.5 },
      }),
      kind,
    );
    expect(researchManagementSchema.safeParse(selected).success).toBe(true);
    expect(matchesResearchExitPreset(selected)).toBe(true);
    if (isCanslimExitPreset(kind) || isSepaExitPreset(kind)) {
      expect(selected.liquidityCap).toBeUndefined();
      expect(selected.timeExit).toBeNull();
    } else {
      expect(selected.liquidityCap).toBe(true);
      expect(selected.timeExit).toEqual({ days: 10, minR: 0.5 });
    }
    const method = researchMethodSnapshot({
      ...spec(kind),
      management: selected,
    });
    expect(method).toHaveProperty("exitPreset.kind", kind);
    expect(
      method.sources.some(
        (s) =>
          s.path ===
          (isSepaExitPreset(kind)
            ? "sepa-strategy-analyst/references/entry-exit-rules.md"
            : isCanslimExitPreset(kind)
              ? "canslim-analyst/references/entry-exit-rules.md"
              : "stop-loss/references/management.md"),
      ),
    ).toBe(true);
    const { exitPreset: _id, ...old } = selected;
    expect(
      researchMethodSnapshot({ ...spec(kind), management: old }),
    ).not.toHaveProperty("exitPreset");
    expect(researchRManagementTemplate(selected)).not.toHaveProperty(
      "exitPreset",
    );
    expect(swingExitTemplate(selected, false)).not.toHaveProperty("exitPreset");
  }
  const stale = {
    ...researchExitPresetTemplate(base, "target-2r"),
    breakeven: { atR: 1 },
  };
  expect(researchManagementSchema.safeParse(stale).success).toBe(false);
  const cleared = clearStaleExitPreset(stale);
  expect(cleared).not.toHaveProperty("exitPreset");
  expect(cleared.breakeven).toEqual({ atR: 1 });
  expect(researchManagementSchema.safeParse(cleared).success).toBe(true);
});
