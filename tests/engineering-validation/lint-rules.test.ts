import { ESLint } from "eslint";
import { expect, it } from "vitest";

/** Negative control: the rule set must reject React #310 (hook after return). */
it("lint rejects a hook called after an early return", async () => {
  const eslint = new ESLint({ cwd: process.cwd() });
  const [bad] = await eslint.lintText(
    `import { useState } from "react";
export function Panel({ ready }: { ready: boolean }) {
  if (!ready) return null;
  const [value] = useState(0);
  return value;
}`,
    { filePath: "src/components/lint-probe.tsx" },
  );
  expect(bad!.messages.map((m) => m.ruleId)).toContain(
    "react-hooks/rules-of-hooks",
  );
  const [good] = await eslint.lintText(
    `import { useState } from "react";
export function Panel({ ready }: { ready: boolean }) {
  const [value] = useState(0);
  if (!ready) return null;
  return value;
}`,
    { filePath: "src/components/lint-probe.tsx" },
  );
  expect(good!.errorCount).toBe(0);
});
