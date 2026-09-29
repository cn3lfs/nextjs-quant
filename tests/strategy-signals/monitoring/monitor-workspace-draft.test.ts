import { expect, it } from "vitest";
import {
  newMonitorDraft,
  savedMonitorDraft,
  monitorDraftInput,
  monitorSessionDrafts,
} from "../../../src/lib/strategy-facts/monitor-workspace-draft";
it("saving a submitted revision preserves edits made while the request was pending", () => {
  const submitted = {
    ...newMonitorDraft(),
    name: "A",
    revision: 1,
    dirty: true,
  };
  const current = { ...submitted, name: "A newly edited", revision: 2 };
  const saved = { id: "monitor-a", configurationVersion: "a".repeat(64) };
  expect(savedMonitorDraft(current, 1, saved)).toMatchObject({
    name: "A newly edited",
    dirty: true,
    revision: 2,
    id: "monitor-a",
    expectedVersion: saved.configurationVersion,
  });
  expect(savedMonitorDraft(submitted, 1, saved).dirty).toBe(false);
});
it("freezes a fallback watchlist and restores unfinished session drafts", () => {
  const draft = newMonitorDraft(),
    watch = ["sh600519"];
  const input = monitorDraftInput(draft, watch);
  watch.push("sz000001");
  expect(input.symbols).toEqual(["sh600519"]);
  const unfinished = {
    ...draft,
    dirty: true,
    strategy: { ...draft.strategy, fast: 90, slow: 2 },
  };
  expect(monitorSessionDrafts.parse({ new: unfinished }).new).toEqual(
    unfinished,
  );
  expect(
    monitorSessionDrafts.safeParse({ new: { ...unfinished, enabled: "true" } })
      .success,
  ).toBe(false);
});
