import { z } from "zod";
export const fundamentalModes = ["fundamental", "guo", "value"] as const;
export const fundamentalStageLabels = {
  fundamental: {
    identity: "证券与行业基准",
    collection: "财务与外部资料覆盖",
    quality: "财务健康与质量",
    valuation: "独立估值模型及假设",
    conclusion: "综合判断与缺项",
  },
  guo: {
    redFlags: "排雷",
    strategy: "战略与竞争定位",
    balanceReconstruction: "资产资本表重构",
    equityValueAdded: "股权价值增加表",
    cashStates: "经营现金流五状态",
    valuation: "保全性现金流估值",
    conclusion: "安全边际与结论",
  },
  value: {
    thesis: "投资命题与假设",
    valueCreation: "价值创造与每股回报",
    growth: "增长质量与持续性",
    certainty: "确定性与证伪",
    expectations: "价格隐含预期",
    variant: "市场分歧与反方论证",
    asymmetry: "情景与永久损失",
    action: "后续核验与监测",
  },
} as const;
export const fundamentalResearchInput = z
  .object({
    financeId: z.string().regex(/^financial-quality-[a-f0-9]{64}$/),
    snapshotId: z.string().min(1),
    scenarioId: z
      .string()
      .regex(/^valuation-scenario-[a-f0-9]{64}$/)
      .optional(),
    mode: z.enum(fundamentalModes),
    question: z.string().trim().min(1).max(2000),
  })
  .strict();
