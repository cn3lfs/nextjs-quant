import { z } from "zod";
import { usageConfigHash } from "../research/research-config-hash";
import { sqlite } from "./index";

const idSchema = z.string().trim().min(1);
const timestampSchema = z.number().int().safe().nonnegative();
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | {
      [key: string]: JsonValue;
    };
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);
const parametersSchema = z.record(jsonValueSchema);

export const factorCompositeConfigSchema = z
  .object({
    factors: z
      .array(
        z
          .object({
            factorId: idSchema,
            direction: z.union([z.literal(1), z.literal(-1)]),
            weight: z.number().finite().nonnegative().optional(),
            formula: z.string().trim().min(1).optional(),
            parameters: parametersSchema.optional(),
          })
          .strict(),
      )
      .min(1),
    parameters: parametersSchema.optional(),
  })
  .strict()
  .refine(
    ({ factors }) =>
      new Set(factors.map(({ factorId }) => factorId)).size === factors.length,
    {
      message: "因子项不能重复",
      path: ["factors"],
    },
  );

export const factorCompositeSummarySchema = z
  .object({
    rankIC: z.number().finite().min(-1).max(1).nullable(),
    icir: z.number().finite().nullable(),
    details: parametersSchema.optional(),
  })
  .strict();

const compositeFields = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1),
    description: z.string(),
    weightingMethod: z.enum(["equal", "icir", "custom"]),
    neutralizationMode: z.enum(["none", "industry", "size", "industry_size"]),
    winsorizeMethod: z.enum(["none", "mad", "quantile"]),
    config: factorCompositeConfigSchema,
  })
  .strict();

function hasValidWeights({
  weightingMethod,
  config,
}: z.infer<typeof compositeFields>) {
  if (weightingMethod !== "custom") return true;
  const weights = config.factors.map(({ weight }) => weight ?? NaN);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return Number.isFinite(total) && total > 0;
}

const weightsError = {
  message: "自定义权重需逐项填写，且总和为正的有限数",
  path: ["config", "factors"],
};
export const upsertFactorCompositeInputSchema = compositeFields
  .extend({ description: z.string().default("") })
  .refine(hasValidWeights, weightsError);
export const factorCompositeRecordSchema = compositeFields
  .extend({
    configHash: z.string().regex(/^[0-9a-f]{64}$/),
    latestEvalSummary: factorCompositeSummarySchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .refine(hasValidWeights, weightsError);

export type FactorCompositeRecord = z.infer<typeof factorCompositeRecordSchema>;
export type UpsertFactorCompositeInput = z.input<
  typeof upsertFactorCompositeInputSchema
>;
export type FactorCompositeConfig = z.infer<typeof factorCompositeConfigSchema>;
export type FactorCompositeSummary = z.infer<
  typeof factorCompositeSummarySchema
>;

export function computeFactorCompositeConfigHash({
  weightingMethod,
  neutralizationMode,
  winsorizeMethod,
  config,
}: Pick<
  UpsertFactorCompositeInput,
  "weightingMethod" | "neutralizationMode" | "winsorizeMethod" | "config"
>): string {
  return usageConfigHash({
    weightingMethod,
    neutralizationMode,
    winsorizeMethod,
    config: factorCompositeConfigSchema.parse(config),
  });
}

const cursorSchema = z
  .object({ updatedAt: timestampSchema, id: idSchema })
  .strict();
export type FactorCompositeCursor = z.infer<typeof cursorSchema>;
const pageSizeSchema = z.number().int().min(1).max(1000);

type CompositeRow = Omit<
  FactorCompositeRecord,
  "config" | "configHash" | "latestEvalSummary"
> & {
  configJson: string;
  summaryJson: string | null;
};
const columns = `id,name,description,weighting_method AS weightingMethod,
  neutralization_mode AS neutralizationMode,winsorize_method AS winsorizeMethod,
  config_json AS configJson,latest_eval_summary_json AS summaryJson,
  created_at AS createdAt,updated_at AS updatedAt`;

function decodeComposite({ configJson, summaryJson, ...row }: CompositeRow) {
  const config = JSON.parse(configJson) as FactorCompositeConfig;
  return factorCompositeRecordSchema.parse({
    ...row,
    config,
    configHash: computeFactorCompositeConfigHash({ ...row, config }),
    latestEvalSummary: summaryJson === null ? null : JSON.parse(summaryJson),
  });
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k]!)}`).join(",")}}`;
}

export function upsertFactorComposite(
  raw: UpsertFactorCompositeInput,
  now = Date.now(),
) {
  const input = upsertFactorCompositeInputSchema.parse(raw);
  const at = timestampSchema.parse(now);
  const nextHash = computeFactorCompositeConfigHash(input);
  const configJson = canonicalJson(input.config as JsonValue);
  // An evaluation belongs to the canonical configuration hash that produced it.
  const row = sqlite().transaction(() => {
    const existing = sqlite()
      .prepare(`SELECT ${columns} FROM factor_composites WHERE id=?`)
      .get(input.id) as CompositeRow | undefined;
    const preserveSummary =
      existing !== undefined &&
      computeFactorCompositeConfigHash({
        weightingMethod: existing.weightingMethod,
        neutralizationMode: existing.neutralizationMode,
        winsorizeMethod: existing.winsorizeMethod,
        config: JSON.parse(existing.configJson) as FactorCompositeConfig,
      }) === nextHash;
    return sqlite()
      .prepare(
        `
      INSERT INTO factor_composites (
        id,name,description,weighting_method,neutralization_mode,winsorize_method,
        config_json,created_at,updated_at
      ) VALUES (@id,@name,@description,@weightingMethod,@neutralizationMode,@winsorizeMethod,
        @configJson,@at,@at)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,description=excluded.description,
        latest_eval_summary_json=CASE
          WHEN @preserveSummary=1 THEN factor_composites.latest_eval_summary_json
          ELSE NULL
        END,
        weighting_method=excluded.weighting_method,neutralization_mode=excluded.neutralization_mode,
        winsorize_method=excluded.winsorize_method,config_json=excluded.config_json,
        updated_at=max(factor_composites.updated_at,excluded.updated_at)
      RETURNING ${columns}
    `,
      )
      .get({
        ...input,
        configJson,
        preserveSummary: preserveSummary ? 1 : 0,
        at,
      }) as CompositeRow;
  })();
  return decodeComposite(row);
}

export function getFactorComposite(id: string) {
  const key = idSchema.parse(id);
  const row = sqlite()
    .prepare(`SELECT ${columns} FROM factor_composites WHERE id=?`)
    .get(key) as CompositeRow | undefined;
  return row ? decodeComposite(row) : null;
}

export function listFactorComposites(
  limit: number,
  after?: FactorCompositeCursor,
) {
  const size = pageSizeSchema.parse(limit);
  const cursor = cursorSchema.optional().parse(after);
  const rows = sqlite()
    .prepare(
      `
    SELECT ${columns} FROM factor_composites
    ${cursor ? "WHERE (updated_at,id) < (?,?)" : ""}
    ORDER BY updated_at DESC,id DESC LIMIT ?
  `,
    )
    .all(
      ...(cursor ? [cursor.updatedAt, cursor.id, size + 1] : [size + 1]),
    ) as CompositeRow[];
  const items = rows.slice(0, size).map(decodeComposite);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > size && last
        ? { updatedAt: last.updatedAt, id: last.id }
        : null,
  };
}

export function updateFactorCompositeSummary(
  id: string,
  summary: FactorCompositeSummary | null,
  expectedConfigHash: string,
  now = Date.now(),
) {
  const key = idSchema.parse(id);
  const value = factorCompositeSummarySchema.nullable().parse(summary);
  const at = timestampSchema.parse(now);
  const db = sqlite();
  return db
    .transaction(() => {
      const current = getFactorComposite(key);
      if (!current || current.configHash !== expectedConfigHash) return null;

      const row = db
        .prepare(
          `
        UPDATE factor_composites
        SET latest_eval_summary_json=?,updated_at=max(updated_at,?)
        WHERE id=? RETURNING ${columns}
      `,
        )
        .get(
          value === null ? null : JSON.stringify(value),
          at,
          key,
        ) as CompositeRow;
      return decodeComposite(row);
    })
    .immediate();
}

export function deleteFactorComposite(id: string) {
  const key = idSchema.parse(id);
  return (
    sqlite().prepare("DELETE FROM factor_composites WHERE id=?").run(key)
      .changes > 0
  );
}
