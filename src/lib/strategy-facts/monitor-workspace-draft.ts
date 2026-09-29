import { z } from "zod";
import { marketSourceSchema } from "~/lib/market/market-source";
import {
  defaultStrategy,
  periodSchema,
  symbolSchema,
  type Monitor,
  type Period,
  type Strategy,
} from "~/lib/domain";
import type { MarketSource } from "~/lib/market/market-source";
export type MonitorDraft = {
  id?: string;
  expectedVersion?: string;
  name: string;
  symbolText: string;
  strategy: Strategy;
  period: Period;
  source: MarketSource;
  channels: string[];
  ai: boolean;
  enabled: boolean;
  revision: number;
  dirty: boolean;
};
export const newMonitorDraft = (): MonitorDraft => ({
  name: "趋势跟踪",
  symbolText: "",
  strategy: { ...defaultStrategy },
  period: "day",
  source: "local",
  channels: [],
  ai: false,
  enabled: false,
  revision: 0,
  dirty: false,
});
export function editMonitorDraft(
  value: Monitor & { configurationVersion: string },
): MonitorDraft {
  return {
    id: value.id,
    expectedVersion: value.configurationVersion,
    name: value.name,
    symbolText: value.symbols.join(","),
    strategy: value.strategy,
    period: value.period,
    source: value.source === "mcp" ? "local" : value.source,
    channels: value.channels,
    ai: value.ai,
    enabled: value.enabled,
    revision: 0,
    dirty: false,
  };
}
export function savedMonitorDraft(
  current: MonitorDraft,
  submittedRevision: number,
  saved: { id: string; configurationVersion: string },
): MonitorDraft {
  return {
    ...current,
    id: saved.id,
    expectedVersion: saved.configurationVersion,
    dirty: current.revision !== submittedRevision,
  };
}
export function monitorDraftInput(
  value: MonitorDraft,
  watchlist: readonly string[],
) {
  const symbols = value.symbolText.trim()
    ? value.symbolText.split(/[,，\s]+/).filter(Boolean)
    : [...watchlist];
  return {
    id: value.id,
    expectedVersion: value.expectedVersion,
    name: value.name,
    symbols,
    strategy: value.strategy,
    period: value.period,
    source: value.source,
    channels: [...value.channels],
    ai: value.ai,
    enabled: value.enabled,
  };
}

// Session drafts accept unfinished numeric ranges; business validation happens on save.
const draftStrategyFields = {
  name: z.string().max(1000),
  fast: z.number(),
  slow: z.number(),
  minChange: z.number(),
  maxChange: z.number(),
  minVolumeRatio: z.number(),
};
const draftStrategy = z.union([
  z.object({ ...draftStrategyFields, type: z.undefined().optional() }),
  z.object({
    ...draftStrategyFields,
    type: z.literal("ma-cross"),
    params: z.object(draftStrategyFields),
  }),
  z.object({
    ...draftStrategyFields,
    type: z.literal("czsc"),
    params: z.object({ config: z.union([z.literal(0), z.literal(1100)]) }),
  }),
  z.object({
    ...draftStrategyFields,
    type: z.literal("dual-breakout"),
    params: z.object({}).strict(),
  }),
]);
export const monitorSessionDrafts = z.record(
  z.string().min(1).max(200),
  z.object({
    id: z.string().max(200).optional(),
    expectedVersion: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    name: z.string().max(1000),
    symbolText: z.string().max(10000),
    strategy: draftStrategy,
    period: periodSchema,
    source: marketSourceSchema,
    channels: z.array(z.string().max(200)).max(1000),
    ai: z.boolean(),
    enabled: z.boolean(),
    revision: z.number().int().nonnegative(),
    dirty: z.boolean(),
  }),
);

/** Most symbols one subscription may watch (monitorSaveSchema). */
export const monitorSymbolLimit = 20;
const monitorPrefillSchema = z.object({
  name: z.string().trim().min(1).max(80),
  symbols: z.array(symbolSchema).min(1).max(monitorSymbolLimit),
});
export type MonitorPrefill = z.infer<typeof monitorPrefillSchema>;
/**
 * Link that opens a new, unsaved subscription draft on the signals page with
 * these symbols — how screening results become a watched list. Nothing is
 * saved or enabled until the user chooses a strategy and saves.
 */
export function monitorPrefillHref(prefill: MonitorPrefill) {
  const value = monitorPrefillSchema.parse(prefill);
  const params = new URLSearchParams({
    monitorTab: "monitors",
    monitorNew: JSON.stringify(value),
  });
  return `/signals?${params}`;
}
export function readMonitorPrefill(raw: string | null): MonitorPrefill | null {
  if (!raw || raw.length > 4000) return null;
  try {
    return monitorPrefillSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}
