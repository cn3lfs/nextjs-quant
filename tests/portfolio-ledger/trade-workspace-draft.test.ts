import { expect, it } from "vitest";
import {
  newTradeDraft,
  editTradeDraft,
  tradeDraftInput,
  submittedTradeDraft,
  savedTradeDraft,
  tradeDraftSessionSchema,
} from "../../src/lib/portfolio/trade-workspace-draft";
const ready = () =>
  editTradeDraft(newTradeDraft("2026-09-29"), {
    symbol: "sh600000",
    price: "10",
    lowerLimit: "9",
    upperLimit: "11",
    limitSource: "当日终端",
  });
it("freezes a retry identity, rotates it only for new input, and rejects stale acknowledgements", () => {
  const draft = ready(),
    input = tradeDraftInput(draft),
    submitted = submittedTradeDraft(draft);
  expect(tradeDraftInput(submitted)).toEqual(input);
  const newer = editTradeDraft(submitted, { quantity: "200" });
  expect(newer.id).not.toBe(input.id);
  expect(savedTradeDraft(newer, input.id)).toBe(newer);
  expect(tradeDraftInput(submitted)).toEqual(input);
  const saved = savedTradeDraft(submitted, input.id);
  expect(saved.dirty).toBe(false);
  expect(saved.saved).toBe(true);
  expect(editTradeDraft(saved, { note: "下一笔" }).id).not.toBe(input.id);
});
it("restores pending confirmation as unknown with the same immutable input and rejects incompatible sessions", () => {
  const draft = submittedTradeDraft(ready()),
    input = tradeDraftInput(draft);
  const session = {
    schemaVersion: 1,
    draft,
    attempt: { input, state: "pending" },
  };
  const restored = tradeDraftSessionSchema.parse(
    JSON.parse(JSON.stringify(session)),
  );
  expect(restored.attempt).toEqual({ input, state: "unknown" });
  expect(
    tradeDraftSessionSchema.safeParse({ ...session, schemaVersion: 2 }).success,
  ).toBe(false);
  expect(
    tradeDraftSessionSchema.safeParse({
      ...session,
      draft: { ...draft, fields: { ...draft.fields, quantity: "200" } },
    }).success,
  ).toBe(false);
  expect(() =>
    tradeDraftInput(editTradeDraft(ready(), { date: "2026-02-30" })),
  ).toThrow();
});
