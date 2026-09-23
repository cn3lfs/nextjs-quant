/** Semantic tone shared by stats, pills, list rows and report stages. */
export type Tone = "neutral" | "accent" | "ok" | "warn" | "bad" | "idle";

// Unlayered classes (panels.css) so they win over the panel base rules.
export const toneText: Record<Tone, string> = {
  neutral: "nc-text-neutral",
  accent: "nc-text-accent",
  ok: "nc-text-ok",
  warn: "nc-text-warn",
  bad: "nc-text-bad",
  idle: "nc-text-idle",
};

/** Dark edge of a tone; neutral panels keep the soft hairline. */
export const toneEdge: Record<Tone, string> = {
  neutral: "nc-edge-neutral",
  accent: "nc-edge-accent",
  ok: "nc-edge-ok",
  warn: "nc-edge-warn",
  bad: "nc-edge-bad",
  idle: "nc-edge-neutral",
};

/** A-share price color: red up, green down, muted when flat or unknown. */
export function changeTone(value: number | null | undefined): Tone {
  return value === null || value === undefined || value === 0
    ? "idle"
    : value > 0
      ? "bad"
      : "ok";
}

export function signedPercent(value: number | null | undefined, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}%`;
}
