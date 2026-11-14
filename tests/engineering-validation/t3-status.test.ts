import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { taskAge } from "~/lib/research/workflow/task-history";

it("labels Beijing calendar days independently of the computer timezone", () => {
  const now = Date.parse("2026-09-10T00:01:00+08:00");
  expect(taskAge(now, now)).toBe("今天");
  expect(taskAge(Date.parse("2026-09-09T23:59:00+08:00"), now)).toBe("昨天");
  expect(taskAge(Date.parse("2026-09-08T00:00:00+08:00"), now)).toBe("2 天前");
  expect(taskAge(Date.parse("2026-09-11T00:00:00+08:00"), now)).toBe(
    "未来日期",
  );
  const source = readFileSync(
    "src/components/workbench/task-history.tsx",
    "utf8",
  );
  expect(source).toContain("taskAge(job.createdAt)");
  expect(source).toContain("stamp(job.createdAt)");
});

// Annotation paint ordering, callbacks, query enablement and canvas reuse are
// exercised with real React/browser effects in chart-annotations-browser.mjs.
