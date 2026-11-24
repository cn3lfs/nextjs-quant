import { z } from "zod";

const sessions = z.number().int().positive();
const topK = z.number().int().min(1).max(3);
const cadence = z.enum(["daily", "month-end"]);
const defense = z.enum(["treasury", "cash"]);
const fraction = z.number().finite().positive().max(1);
const sectorWindows = Object.freeze([20, 60] as const);
const positiveMomentum = Object.freeze({ kind: "positive-momentum" } as const);

const dualMomentum = z
  .object({
    strategyId: z.literal("etf-dual-momentum"),
    pool: z.enum(["full", "legacy-long-history"]).default("full"),
    cadence: cadence.default("month-end"),
    topK: topK.default(3),
    momentumWindow: sessions.default(60),
    trend: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("positive-momentum") }).strict(),
        z.object({ kind: z.literal("sma"), window: sessions }).strict(),
      ])
      .default(positiveMomentum),
    defense: defense.default("treasury"),
  })
  .strict();

const sectorRotation = z
  .object({
    strategyId: z.literal("etf-sector-rotation"),
    cadence: cadence.default("month-end"),
    topK: topK.default(2),
    momentumWindows: z
      .array(sessions)
      .nonempty()
      .default(() => [...sectorWindows] as [number, ...number[]]),
    exitRankBuffer: z.number().int().min(0).max(11).default(2),
    requirePositiveMomentum: z.boolean().default(true),
    defense: defense.default("treasury"),
  })
  .strict();

const riskBudget = z
  .object({
    strategyId: z.literal("etf-risk-budget"),
    mode: z.enum(["static-60-40", "inverse-vol"]).default("inverse-vol"),
    volatilityWindow: sessions.min(2).default(60),
    trendWindow: sessions.nullable().default(null),
    defense: defense.default("treasury"),
    maxEtfWeight: fraction.default(0.6),
  })
  .strict();

export const etfRotationConfigSchema = z.discriminatedUnion("strategyId", [
  dualMomentum,
  sectorRotation,
  riskBudget,
]);

export type EtfRotationConfig =
  | z.input<typeof dualMomentum>
  | (Omit<z.input<typeof sectorRotation>, "momentumWindows"> & {
      momentumWindows?: readonly number[];
    })
  | z.input<typeof riskBudget>;
export type ResolvedEtfRotationConfig =
  | Readonly<z.output<typeof dualMomentum>>
  | Readonly<
      Omit<z.output<typeof sectorRotation>, "momentumWindows"> & {
        momentumWindows: readonly number[];
      }
    >
  | Readonly<z.output<typeof riskBudget>>;
export type EtfRotationStrategyId = EtfRotationConfig["strategyId"];

export const etfDualMomentum = Object.freeze({
  id: "etf-dual-momentum",
  name: "多资产双动量",
  version: 1,
  defaults: Object.freeze({
    ...dualMomentum.parse({ strategyId: "etf-dual-momentum" }),
    trend: positiveMomentum,
  }),
});
export const etfSectorRotation = Object.freeze({
  id: "etf-sector-rotation",
  name: "行业 ETF 相对强弱轮动",
  version: 1,
  defaults: Object.freeze({
    ...sectorRotation.parse({ strategyId: "etf-sector-rotation" }),
    momentumWindows: sectorWindows,
  }),
});
export const etfRiskBudget = Object.freeze({
  id: "etf-risk-budget",
  name: "股债金风险预算配置",
  version: 1,
  defaults: Object.freeze(riskBudget.parse({ strategyId: "etf-risk-budget" })),
});

export const etfRotationCatalog = Object.freeze([
  etfDualMomentum,
  etfSectorRotation,
  etfRiskBudget,
] as const);
