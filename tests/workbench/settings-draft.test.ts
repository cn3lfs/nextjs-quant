import { describe, expect, it } from "vitest";
import { settingsSchema } from "../../src/lib/domain";
import {
  acknowledgeSettings,
  changedSettings,
  reconcileSettings,
  settingsToSave,
} from "../../src/lib/settings/settings-draft";

describe("settings draft ownership and save races", () => {
  const base = settingsSchema.parse({ tdxRoot: "C:/original" });
  it("adopts remote clean fields and keeps edited fields", () => {
    const state = { base, draft: { ...base, tdxRoot: "C:/draft" } };
    const next = reconcileSettings(state, {
      ...base,
      analysisLimit: 3,
      tdxRoot: "C:/remote",
    });
    expect(next.draft.tdxRoot).toBe("C:/draft");
    expect(next.draft.analysisLimit).toBe(3);
    expect(changedSettings(next)).toEqual(["tdxRoot"]);
  });
  it("acknowledges only the submitted edit and retains a newer edit", () => {
    const submitted = { ...base, tdxRoot: "C:/submitted" };
    const state = { base, draft: { ...submitted, tdxRoot: "C:/newer" } };
    expect(changedSettings(acknowledgeSettings(state, submitted))).toEqual([
      "tdxRoot",
    ]);
    expect(
      changedSettings(
        acknowledgeSettings({ base, draft: submitted }, submitted),
      ),
    ).toEqual([]);
  });
  it("preserves independently updated fields when submitting a stale form", () => {
    const current = {
      ...base,
      holdoutStart: "2026-01-01",
      outboundProxy: "",
      industryBlocksRoot: "C:/new-blocks",
    };
    const result = settingsToSave(
      { base, draft: { ...base, tdxRoot: "C:/draft" } },
      current,
    );
    expect(result).toMatchObject({
      holdoutStart: "2026-01-01",
      outboundProxy: "",
      industryBlocksRoot: "C:/new-blocks",
      tdxRoot: "C:/draft",
    });
  });
  it("compares nested values structurally", () => {
    expect(changedSettings({ base, draft: structuredClone(base) })).toEqual([]);
  });
  it("adopts server normalization without discarding newer input", () => {
    const original = { ...base, codexModel: " model " };
    const submitted = { ...original, codexModel: "model" };
    expect(
      changedSettings(
        acknowledgeSettings({ base, draft: original }, submitted, original),
      ),
    ).toEqual([]);
    const newer = { ...original, codexModel: "next" };
    expect(
      acknowledgeSettings({ base, draft: newer }, submitted, original).draft
        .codexModel,
    ).toBe("next");
  });
});
