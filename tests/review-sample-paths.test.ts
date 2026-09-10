import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

// The renderer snapshots remain in M4/P2. This guards the single-source layout
// so a future update cannot silently recreate a second hand-maintained copy.
it.each([
  ["m4", "m4-monitor"],
  ["p2", "p2-notification-policy"],
])("%s samples have one canonical read/update path", (milestone, suite) => {
  const canonical = `docs/review/${milestone}-message-samples.md`;
  const legacy = `docs/${milestone}-message-samples.md`;
  expect(existsSync(canonical)).toBe(true);
  expect(existsSync(legacy)).toBe(false);
  const test = readFileSync(`tests/${suite}.test.ts`, "utf8");
  expect(test).toContain(`writeFileSync("${canonical}",`);
  expect(test).toContain(`readFileSync("${canonical}", "utf8")`);
  expect(test).not.toContain(legacy);
});
