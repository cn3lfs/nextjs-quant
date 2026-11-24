import { z } from "zod";
import {
  alphaExperimentSchema,
  targetSnapshotSchema,
} from "./alpha-experiment";
import {
  buildLabDraftFromHandoff,
  diagnoseResultInputSchema,
  isDiagnosticOnlyStrategyKey,
  parseScanToLabHandoff,
} from "./diagnose-contract";
import { labIdentitySchema } from "./strategy-lab";
import type { StudioTemplateKind } from "./studio-result";

export type StudioView = "compose" | "result" | "archive";

export const studioViewOptions = [
  { value: "compose", label: "编排" },
  { value: "result", label: "结果" },
  { value: "archive", label: "归档" },
] as const;

export const studioTemplateLabels: Record<StudioTemplateKind, string> = {
  single: "单策略",
  "multi-book": "多分仓（2–6）",
  "etf-rotation": "ETF 轮动",
  "alpha-formula": "因子与公式组合",
  "exit-family": "退出家族",
  "ma-baseline-5m": "5m SMA 基线",
};

export type StudioRunReference =
  | { kind: "diagnose"; id: string }
  | { kind: "ma"; id: string }
  | { kind: "object"; id: string }
  | { kind: "run"; id: string };

function objectIdentity(params: URLSearchParams) {
  if (!params.has("strategy")) return { kind: "none" } as const;
  const rawVersion = params.get("version") ?? "1";
  const parsed = /^\d+$/.test(rawVersion)
    ? labIdentitySchema.safeParse({
        id: params.get("strategy"),
        version: Number(rawVersion),
      })
    : null;
  return parsed?.success
    ? ({ kind: "valid", identity: parsed.data } as const)
    : ({ kind: "invalid" } as const);
}

export function parseStudioEntry(search: string | URLSearchParams) {
  const params = new URLSearchParams(search);
  const identity = objectIdentity(params);
  const handoff = parseScanToLabHandoff(params);
  const batch =
    handoff.kind === "valid" && handoff.handoff.scope === "portfolio-diagnose"
      ? handoff
      : null;
  const rawArchive = params.get("archive")?.trim();
  const archiveId =
    rawArchive &&
    /^(?:lab-[\w.\u3400-\u9fff-]+|cli-(?:~[\w-]+|[\w.\u3400-\u9fff-]+))$/.test(
      rawArchive,
    ) &&
    rawArchive.length <= 4096 &&
    !rawArchive.includes("..") &&
    !rawArchive.endsWith(".")
      ? rawArchive
      : null;
  const runId =
    diagnoseResultInputSchema.shape.jobId.safeParse(params.get("run")?.trim())
      .data ?? null;
  const alphaId = params.get("alpha")?.trim() || null;
  const preset =
    identity.kind === "none" && !params.has("handoff")
      ? params.get("preset")
      : null;
  const mode = params.get("mode");
  const object =
    mode === "object" ||
    (mode !== "diagnose" &&
      (identity.kind !== "none" ||
        !!preset ||
        (handoff.kind !== "none" && !batch)));
  const batchDraft = batch && buildLabDraftFromHandoff(batch.handoff);
  const hint = batch?.handoff.strategyHint;
  const batchPrefill =
    batch && batchDraft
      ? {
          symbols: batch.handoff.symbols,
          mode: "portfolio" as const,
          start: batchDraft.start,
          end: batchDraft.end,
          ...(hint === "core-4"
            ? { bookPreset: "core-4" as const }
            : hint && isDiagnosticOnlyStrategyKey(hint)
              ? { strategyKey: hint }
              : {}),
        }
      : null;
  const rawTemplate = params.get("template") ?? "";
  const template: StudioTemplateKind = Object.hasOwn(
    studioTemplateLabels,
    rawTemplate,
  )
    ? (rawTemplate as StudioTemplateKind)
    : batch
      ? hint === "core-4"
        ? "multi-book"
        : "single"
      : alphaId
        ? "alpha-formula"
        : object || mode === "diagnose"
          ? "single"
          : "ma-baseline-5m";
  const viewParam = params.get("view");
  const explicitView = studioViewOptions.find(
    ({ value }) => value === viewParam,
  )?.value;
  // A portfolio handoff opens composition on mixed legacy links. An explicit
  // view can still open the referenced archive without losing the handoff.
  const reference: StudioRunReference | null =
    batch && !explicitView
      ? null
      : archiveId
        ? { kind: "diagnose", id: archiveId }
        : runId
          ? { kind: "run", id: runId }
          : null;
  const view: StudioView = explicitView ?? (reference ? "result" : "compose");
  return {
    view,
    template,
    identity,
    preset,
    object,
    handoff,
    batchPrefill,
    batchKey: batch?.key ?? null,
    archiveId,
    reference,
    alphaId,
  };
}

export type StudioEntry = ReturnType<typeof parseStudioEntry>;
export const alphaStudioHandoffKey = "quant:alpha-studio-handoff";
const alphaStudioHandoffSchema = z.object({
  version: z.literal(1),
  compositeId: z.string().min(1),
  config: alphaExperimentSchema,
  targetSnapshot: targetSnapshotSchema,
  initial: z.number().positive().max(1e9).optional(),
  costScenario: z.enum(["base", "double-cost"]),
});

export function parseAlphaStudioHandoff(
  raw: string | null,
  compositeId: string,
) {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = alphaStudioHandoffSchema.safeParse(value);
  return parsed.success && parsed.data.compositeId === compositeId
    ? parsed.data
    : null;
}
