import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

// The renderer snapshots remain in M4/P2. This guards the single-source layout
// so a future update cannot silently recreate a second hand-maintained copy.
const cases = [
  [
    "m4",
    "m4-monitor",
    "docs/strategy-signals/2026-09-10-m4-message-samples.md",
  ],
  [
    "p2",
    "p2-notification-policy",
    "docs/strategy-signals/2026-09-10-p2-message-samples.md",
  ],
] as const;

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

it.each(cases)(
  "%s samples have one canonical read/update path",
  (milestone, suite, canonical) => {
    const legacy = `docs/review/${milestone}-message-samples.md`;
    const removed = `docs/${milestone}-message-samples.md`;
    expect(existsSync(canonical)).toBe(true);
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(removed)).toBe(false);
    const test = readFileSync(
      `tests/strategy-signals/monitoring/${suite}.test.ts`,
      "utf8",
    );
    expect(test).toMatch(
      new RegExp(`writeFileSync\\(\\s*"${escape(canonical)}"`),
    );
    expect(test).toMatch(
      new RegExp(`readFileSync\\(\\s*"${escape(canonical)}"`),
    );
    expect(test).not.toContain(legacy);
    expect(test).not.toContain(removed);
  },
);
