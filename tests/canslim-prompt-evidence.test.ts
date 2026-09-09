import { expect, it } from "vitest";
import type { Evidence } from "../src/lib/domain";
import { canslimPromptEvidence } from "../src/server/canslim-prompt-evidence";
it("retains every qualified geometry, original index and entries without modifying the archive", () => {
  const payload = {
    technical: {
      version: "canslim-technical-3",
      entries: [{ candidateIndex: 1 }],
      missing: ["gap"],
      patterns: {
        cup: {
          warnings: ["warning"],
          candidates: [
            { qualified: false, why: "failed" },
            { qualified: true, pivot: 123 },
          ],
        },
      },
    },
  };
  const evidence = {
    id: "canslim-technical-fixture",
    text: JSON.stringify(payload),
  } as Evidence;
  const before = JSON.stringify(evidence);
  const projected = JSON.parse(canslimPromptEvidence([evidence])[0]!.text);
  expect(projected.technical.patterns.cup).toEqual({
    warnings: ["warning"],
    candidateCount: 2,
    omittedUnqualifiedCount: 1,
    candidates: [{ qualified: true, pivot: 123, originalIndex: 1 }],
  });
  expect(projected.technical.entries).toEqual(payload.technical.entries);
  expect(projected.technical.missing).toEqual(["gap"]);
  expect(JSON.stringify(evidence)).toBe(before);
});
it("omits only the full membership list and preserves missing securities and warnings", () => {
  const payload = {
    version: "rs-membership-2",
    membershipCodes: ["600519.SH"],
    unavailable: [{ code: "600519.SH", reason: "unknown" }],
    warnings: ["partial"],
  };
  const evidence = {
    id: "membership",
    text: JSON.stringify(payload),
    envelope: {
      source: "hithink-astock-selector/membership-audit",
      payloadHash: "original",
    },
  } as Evidence;
  const result = canslimPromptEvidence([evidence])[0]!;
  expect(JSON.parse(result.text)).toEqual({
    version: payload.version,
    archivedMembershipCodeCount: 1,
    unavailable: payload.unavailable,
    warnings: payload.warnings,
  });
  expect(result).toHaveProperty(
    "promptProjection.originalPayloadHash",
    "original",
  );
  const unknown = {
    ...evidence,
    text: JSON.stringify({ ...payload, version: "future" }),
  };
  expect(canslimPromptEvidence([unknown])[0]).toBe(unknown);
});
