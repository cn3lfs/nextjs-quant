import { expect, it } from "vitest";
import { growthDailyExitTemplate } from "trading-strategies/research/factors/research-growth-exits";
import {
  growthIntradayIds,
  growthIntradayTemplate,
} from "trading-strategies/research/factors/research-growth-intraday";
import { researchInitialStop } from "trading-strategies/research/risk/research-initial-stop";
import { researchManagementSchema } from "~/lib/research/workflow/research-management";

it.each([
  ["sepa-vcp-exits-elite", 90],
  ["sepa-vcp-exits-daily", 90],
  ["canslim-priority-exits-daily", 92],
] as const)(
  "%s preserves its rule-specific stop through management validation",
  (strategy, stop) => {
    const template = growthDailyExitTemplate({ strategy });
    if (!("management" in template))
      throw new Error("Missing growth management template");
    const management = researchManagementSchema.parse(template.management);
    expect(researchInitialStop(management, 100, {})).toBe(stop);
    expect(management.sepaElite ?? false).toBe(strategy.endsWith("elite"));
    expect(
      management.scaleOut?.reduce((sum, row) => sum + row.fraction, 0),
    ).toBeCloseTo(strategy.startsWith("sepa") ? 2 / 3 : 1);
  },
);

it.each(growthIntradayIds)(
  "%s retains its named rule and initial risk through validation",
  (id) => {
    const management = researchManagementSchema.parse(
      growthIntradayTemplate(id),
    );
    expect(management.growthIntraday).toBe(id);
    const stop = researchInitialStop(management, 100, {
      initialStop: 95,
      stopAtr: 2,
    });
    const expected =
      id === "RK-C-swing-system"
        ? 94.4
        : id === "SW02-last30" || id.startsWith("RK-") || id.startsWith("AR")
          ? 95
          : id.startsWith("SE-")
            ? 90
            : 92;
    expect(stop).toBeCloseTo(expected);
  },
);
