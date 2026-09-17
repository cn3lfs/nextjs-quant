import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareSeries,
  compareSnapshots,
  configs,
  readFixture,
} from "../scripts/compare-czsc-dlls.mjs";

test("fixed fixture is the original 2038-bar SSE input", () => {
  assert.equal(readFixture().fixture.date.length, 2038);
});
test("float32 strict tolerance, non-finite rejection and first difference", () => {
  const below = Math.fround(0.0001);
  assert.ok(below < 0.0001);
  assert.equal(compareSeries([0], [below]).differences, 0);
  const above = Math.fround(below + 2 ** -37);
  assert.equal(compareSeries([0], [above]).differences, 1);
  assert.equal(compareSeries([0], [0.0001]).differences, 1);
  assert.equal(compareSeries([NaN, Infinity], [NaN, Infinity]).differences, 2);
  assert.throws(() => compareSeries([0], []), /length/);
});
test("negative control at output 58 fails with exact config/bar; missing data never passes", () => {
  const fixture = { date: ["a", "b"] };
  const before = { fixtureSha256: "fixed", projections: {} };
  for (const aux of ["hl", "cv"])
    for (const config of configs)
      for (let output = 0; output <= 58; output++)
        before.projections[`${aux}:${config}:${output}`] = [0, 0];
  const after = structuredClone(before);
  assert.equal(compareSnapshots(before, after, fixture).exitCode, 0);
  after.projections["cv:1100:58"][1] = 1;
  const result = compareSnapshots(before, after, fixture);
  assert.equal(result.exitCode, 1);
  assert.equal(result.compared, 472);
  assert.deepEqual(result.firstDifference, {
    aux: "cv",
    config: 1100,
    output: 58,
    index: 1,
    oldValue: 0,
    newValue: 1,
    delta: 1,
    date: "b",
  });
  delete after.projections["hl:0:0"];
  assert.throws(() => compareSnapshots(before, after, fixture), /Missing/);
  after.fixtureSha256 = "changed";
  assert.throws(() => compareSnapshots(before, after, fixture), /Fixture/);
});
