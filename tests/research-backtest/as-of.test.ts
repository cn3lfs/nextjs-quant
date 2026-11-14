import { expect, it } from "vitest";
import { z } from "zod";
import {
  asOfObservationSchema,
  createAsOfAdapter,
  type AsOfObservation,
} from "../../src/lib/research/evidence/as-of";
import { readAsOfInput } from "../../src/lib/research/evidence/as-of-inputs";

const asOf = "2024-05-01T15:00:00+08:00";
const query = {
  domain: "finance" as const,
  entity: "sh600000",
  field: "quarterlyEps",
  effectiveAt: "2024-03-31",
  unit: "CNY/share",
  schema: z.number().finite(),
};
function record(overrides: Partial<AsOfObservation> = {}): AsOfObservation {
  return {
    domain: query.domain,
    entity: query.entity,
    field: query.field,
    effectiveAt: query.effectiveAt,
    source: "fixed-publication",
    unit: query.unit,
    value: 1.2,
    availableAt: "2024-04-25T18:00:00+08:00",
    capturedAt: "2024-06-01T09:00:00+08:00",
    versionId: "original",
    availabilityEvidence: {
      kind: "version-publication",
      reference: "fixed-announcement-original",
    },
    ...overrides,
  };
}
const read = (rows: unknown, date = asOf) =>
  createAsOfAdapter(rows, { asOf: date }).read(query);

it("requires availableAt as an input and never substitutes report period, mtime or capture time", () => {
  const { availableAt: _, ...raw } = record();
  expect(asOfObservationSchema.safeParse(raw).success).toBe(false);
  expect(read([raw])).toMatchObject({
    status: "missing",
    value: null,
    code: "missing-available-at",
  });
  expect(
    read([
      { ...raw, formatVersion: 1, mtime: asOf, reportPeriod: "2024-03-31" },
    ]),
  ).toMatchObject({ status: "missing", code: "missing-available-at" });
});
it("keeps report period, publication and capture separate, including late archival ingestion", () => {
  const r = record();
  expect(read([r])).toEqual({
    status: "available",
    value: 1.2,
    provenance: (({ value: _, ...p }) => p)(r),
  });
  expect(read([r], "2024-04-25T17:59:59+08:00")).toMatchObject({
    status: "missing",
    value: null,
  });
  expect(read([r], r.availableAt)).toMatchObject({
    status: "available",
    value: 1.2,
  });
});
it("does not backfill a revised value into the past or choose the newest captured file", () => {
  const original = record({ capturedAt: "2024-08-01T00:00:00Z" });
  const revision = record({
    value: 9.9,
    versionId: "revised",
    availableAt: "2024-06-01T00:00:00Z",
    capturedAt: "2024-06-02T00:00:00Z",
    availabilityEvidence: {
      kind: "version-publication",
      reference: "fixed-correction",
    },
  });
  expect(read([revision, original])).toEqual(read([original]));
  expect(read([original, revision])).toEqual(read([original]));
  expect(read([original, revision], revision.availableAt)).toMatchObject({
    status: "available",
    value: 9.9,
    provenance: { versionId: "revised" },
  });
  expect(read([revision])).toMatchObject({
    status: "missing",
    code: "no-coverage",
  });
});
it("supports an independent archive cutoff without equating it to market knowledge", () => {
  expect(
    createAsOfAdapter([record()], { asOf, capturedBy: asOf }).read(query),
  ).toMatchObject({ status: "missing", code: "no-coverage" });
  expect(
    createAsOfAdapter([record()], {
      asOf,
      capturedBy: "2024-06-02T00:00:00Z",
    }).read(query),
  ).toMatchObject({ status: "available" });
});
it.each([
  "2024-04-25",
  "2024-04-25T18:00:00",
  "",
  null,
  undefined,
  "2024-02-30T00:00:00Z",
  "2024-04-25T18:00:00+99:99",
])("rejects non-instant availableAt %s", (availableAt) => {
  expect(read([{ ...record(), availableAt }])).toMatchObject({
    status: "missing",
    code: "missing-available-at",
  });
});
it.each(["source", "capturedAt", "versionId", "availabilityEvidence"])(
  "requires explicit provenance %s",
  (field) => {
    expect(read([{ ...record(), [field]: undefined }])).toMatchObject({
      status: "missing",
      code: "invalid-provenance",
    });
  },
);
it("rejects capture before first public availability and unverified publication kinds", () => {
  expect(read([record({ capturedAt: "2024-04-01T00:00:00Z" })])).toMatchObject({
    status: "missing",
    code: "invalid-capture-time",
  });
  expect(
    read([
      {
        ...record(),
        availabilityEvidence: { kind: "file-mtime", reference: "x" },
      },
    ]),
  ).toMatchObject({ status: "missing", code: "invalid-provenance" });
});
it("refuses reused revision identities and same-time conflicts regardless of input order", () => {
  const rows = [record(), record({ value: 2 })];
  for (const r of [rows, [...rows].reverse()])
    expect(read(r)).toMatchObject({
      status: "missing",
      code: "version-conflict",
    });
  expect(
    read([record(), record({ versionId: "second", value: 2 })]),
  ).toMatchObject({ status: "missing", code: "value-conflict" });
  expect(read([record(), record()])).toEqual(read([record()]));
});
it("refuses implicit cross-source choice but accepts explicitly scoped queries", () => {
  const rows = [record(), record({ source: "other", value: 2 })];
  expect(read(rows)).toMatchObject({
    status: "missing",
    code: "source-conflict",
  });
  expect(
    createAsOfAdapter(rows, { asOf }).read({ ...query, source: "other" }),
  ).toMatchObject({ status: "available", value: 2 });
});
it("does not fall back when the latest known value is invalid, missing or wrong-unit", () => {
  for (const value of [null, undefined, NaN, Infinity, "1.2"]) {
    const revision = record({ value, versionId: "r2", availableAt: asOf });
    expect(read([record(), revision])).toMatchObject({
      status: "missing",
      value: null,
      code: "invalid-value",
    });
  }
  expect(read([record({ unit: "%" })])).toMatchObject({
    status: "missing",
    code: "unit-mismatch",
  });
  expect(read([record({ value: 0 })])).toMatchObject({
    status: "available",
    value: 0,
  });
});
it("matches exact field/entity/effective date and rejects malformed containers", () => {
  for (const overrides of [
    { entity: "sh600001" },
    { field: "annualEps" },
    { effectiveAt: "2023-03-31" },
  ])
    expect(read([record(overrides)])).toMatchObject({
      status: "missing",
      code: "no-coverage",
    });
  expect(read([{}])).toMatchObject({
    status: "missing",
    code: "invalid-input",
  });
  expect(read({})).toMatchObject({ status: "missing", code: "invalid-input" });
  expect(read([record()], "2024-03-01T00:00:00Z")).toMatchObject({
    status: "missing",
    code: "not-effective",
  });
  expect(read([record()], "2024-05-01")).toMatchObject({
    status: "missing",
    code: "invalid-request",
  });
});
it("compares actual instants across timezones instead of lexicographic timestamps", () => {
  const r = record({ availableAt: "2024-05-01T06:59:59Z" });
  expect(read([r])).toMatchObject({ status: "available" });
  expect(read([record({ availableAt: "2024-05-01T07:00:01Z" })])).toMatchObject(
    { status: "missing" },
  );
});
it("reports unsupported fields and invalid financial periods explicitly", () => {
  const adapter = createAsOfAdapter([], { asOf });
  expect(readAsOfInput(adapter, { ...query, field: "unmapped" })).toMatchObject(
    { status: "missing", code: "unsupported-field", value: null },
  );
  expect(
    readAsOfInput(adapter, { ...query, effectiveAt: "2024-04-01" }),
  ).toMatchObject({ status: "missing", code: "invalid-report-period" });
});
