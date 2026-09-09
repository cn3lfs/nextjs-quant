import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  remoteResearchEvidence,
  evidenceEnvelope,
} from "../src/server/evidence";

it("remote fetch time never masquerades as verified financial or publication time", () => {
  const payload = { report: "2023 annual", amount: 100 };
  const first = remoteResearchEvidence("sh600519", "tdx_quotes", payload, 1000);
  const later = remoteResearchEvidence("sh600519", "tdx_quotes", payload, 2000);
  expect(first.asOf).toBe("源时点未核验");
  expect(first.envelope).toMatchObject({
    asOf: null,
    publishedAt: null,
    fetchedAt: 1000,
    reportPeriod: null,
    currency: null,
    unit: {},
    adjustment: "unknown",
    quality: "partial",
  });
  expect(later.envelope?.fetchedAt).toBe(2000);
  expect(later.id).toBe(first.id);
  const changed = remoteResearchEvidence(
    "sh600519",
    "tdx_quotes",
    { ...payload, amount: 101 },
    2000,
  );
  expect(changed.id).not.toBe(first.id);
});
it("hashes complete data before prompt truncation and retains a warning", () => {
  const payload = { text: "x".repeat(16000) };
  const evidence = remoteResearchEvidence(
    "sh600519",
    "wenda_notice_query",
    payload,
    1000,
  );
  expect(evidence.text.length).toBe(14000);
  expect(evidence.envelope?.payloadHash).toBe(
    createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
  );
  expect(
    evidence.envelope?.warnings.some((warning) => warning.includes("14000")),
  ).toBe(true);
  expect(evidence.envelope?.type).toBe("announcement");
  expect(() =>
    evidenceEnvelope(payload, { ...evidence.envelope!, fetchedAt: NaN }),
  ).toThrow();
});
