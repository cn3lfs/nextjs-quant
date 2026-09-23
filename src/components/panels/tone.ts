/** Semantic tone shared by stats, pills, list rows and report stages. */
export type Tone = "neutral" | "accent" | "ok" | "warn" | "bad" | "idle";

export const toneText: Record<Tone, string> = {
  neutral: "text-nc-text",
  accent: "text-nc-accent",
  ok: "text-nc-ok",
  warn: "text-nc-warn",
  bad: "text-nc-bad",
  idle: "text-nc-text-4",
};

/** Dark edge of a tone; neutral panels keep the soft hairline. */
export const toneEdge: Record<Tone, string> = {
  neutral: "border-nc-border-soft",
  accent: "border-nc-accent-800",
  ok: "border-nc-ok-edge",
  warn: "border-nc-warn-edge",
  bad: "border-nc-bad-edge",
  idle: "border-nc-border-soft",
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
