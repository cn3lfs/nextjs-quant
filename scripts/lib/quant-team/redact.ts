import type { StructuredResult } from "./types";

const replacements: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /https:\/\/hooks\.slack\.com\/services\/[^\s"'<>]+/g,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization|bearer)\b\s*[:=]\s*["']?[^\s"',;]+/gi,
];

/** Summaries can travel to the manager/UI. Raw logs stay in the run directory. */
export function redactSecrets(value: string, maxLength = 4_000): string {
  let result = value;
  for (const pattern of replacements)
    result = result.replace(pattern, "[REDACTED]");
  return result.length > maxLength
    ? `${result.slice(0, maxLength)}…[truncated]`
    : result;
}

export function redactList(values: string[], maxItems = 100): string[] {
  return values.slice(0, maxItems).map((value) => redactSecrets(value));
}

export function redactResult(result: StructuredResult): StructuredResult {
  return {
    status: result.status,
    conclusion: redactSecrets(result.conclusion, 8_000),
    facts: redactList(result.facts),
    evidence: redactList(result.evidence),
    blockers: redactList(result.blockers),
    next: redactList(result.next),
  };
}
