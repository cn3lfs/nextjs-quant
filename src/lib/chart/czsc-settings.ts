import { z } from "zod";

/** czsc-tdx api v20 analysis configuration (adapter/czsc_api.h `czsc_config`). */
export type CzscConfig = {
  strokeRule: number;
  strokeEndpoint: number;
  strokeGap: number;
  gapThreshold: number;
  segmentMethod: number;
  centerStrokeFormation: number;
  signalsPublication: number;
};
/** Display-only projection (`czsc_projection`); never part of the analysis identity. */
export type CzscProjection = { segmentBoundary: number; centerBox: number };

/** One `czsc_config_fields` row; `layer` 0 analysis / 1 outputs / 2 projection. */
export type CzscConfigField = {
  key: string;
  label: string;
  layer: number;
  /** 0 enum / 1 float */
  kind: number;
  defaultValue: number;
  defaultFloat: number;
  minFloat: number;
  maxFloat: number;
};
export type CzscConfigChoice = {
  field: string;
  value: number;
  key: string;
  label: string;
  lessons: string;
  /** 1 = lesson source; 0 = community / non-original rule. */
  original: number;
  note: string;
};
/** When `whenField == whenValue`, `field` is not applicable (`onlyValue` -1) or fixed to `onlyValue`. */
export type CzscConfigRule = {
  whenField: string;
  whenValue: number;
  field: string;
  onlyValue: number;
  reason: string;
};
export type CzscConfigSchema = {
  fields: CzscConfigField[];
  choices: CzscConfigChoice[];
  rules: CzscConfigRule[];
};

/** Schema field key → struct member; the chart only edits analysis and projection fields. */
export const czscConfigKeys = {
  "stroke.rule": "strokeRule",
  "stroke.endpoint": "strokeEndpoint",
  "stroke.gap": "strokeGap",
  "stroke.gapThreshold": "gapThreshold",
  "segment.method": "segmentMethod",
  "center.strokeFormation": "centerStrokeFormation",
  "signals.publication": "signalsPublication",
} as const satisfies Record<string, keyof CzscConfig>;
export const czscProjectionKeys = {
  "projection.segmentBoundary": "segmentBoundary",
  "projection.centerBox": "centerBox",
} as const satisfies Record<string, keyof CzscProjection>;

/**
 * Chart-only structure settings, keyed by schema field. Research, monitoring
 * and the signal ledger always use the DLL defaults (the former 0 / 1100).
 * Unknown keys are ignored by the server; the DLL validates combinations.
 */
export const czscSettingsSchema = z.record(z.string().max(64), z.number());
export type CzscSettings = z.infer<typeof czscSettingsSchema>;

/** Split chart settings into struct overrides; only known schema keys pass. */
export function czscOverrides(settings: CzscSettings) {
  const config: Partial<CzscConfig> = {};
  const projection: Partial<CzscProjection> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (key in czscConfigKeys)
      config[czscConfigKeys[key as keyof typeof czscConfigKeys]] = value;
    else if (key in czscProjectionKeys)
      projection[czscProjectionKeys[key as keyof typeof czscProjectionKeys]] =
        value;
  }
  return { config, projection };
}

/** Value of a field under the current settings, falling back to the DLL default. */
export function czscFieldValue(field: CzscConfigField, settings: CzscSettings) {
  return (
    settings[field.key] ??
    (field.kind === 1 ? field.defaultFloat : field.defaultValue)
  );
}

/** Rule disabling `field` under the current settings, if any. */
export function czscBlockingRule(
  schema: CzscConfigSchema,
  field: string,
  settings: CzscSettings,
) {
  return schema.rules.find((rule) => {
    if (rule.field !== field) return false;
    const when = schema.fields.find((f) => f.key === rule.whenField);
    return when && czscFieldValue(when, settings) === rule.whenValue;
  });
}

/** Relative sensitivity on the SSE regression sample (czsc-tdx v7 reply). */
export const czscStrokeSample =
  "上证指数样本端点数：老笔158 · 新笔180 · czsc笔208 · 4K笔208 · 分型笔718";

/**
 * Settings actually sent to the DLL: values fixed by a rule are forced, and
 * fields a rule marks not applicable are dropped (the DLL default applies).
 */
export function czscEffectiveSettings(
  schema: CzscConfigSchema | undefined,
  settings: CzscSettings,
): CzscSettings {
  if (!schema) return settings;
  const out = { ...settings };
  for (const field of schema.fields) {
    const rule = czscBlockingRule(schema, field.key, out);
    if (!rule) continue;
    if (rule.onlyValue >= 0) out[field.key] = rule.onlyValue;
    else delete out[field.key];
  }
  return out;
}
