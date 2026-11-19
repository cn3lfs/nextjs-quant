import { describe, expect, it } from "vitest";
import { computeRiskDistance } from "~/lib/portfolio/risk-distance";

describe("computeRiskDistance", () => {
  it.each([
    { price: null, stop: 90 },
    { price: 100, stop: null },
    { price: 100, stop: 0 },
    { price: -10, stop: 90 },
    { price: NaN, stop: 90 },
    { price: Infinity, stop: 90 },
    { price: 100, stop: NaN },
    { price: 100, stop: Infinity },
  ])("keeps distances unknown for price=$price and stop=$stop", (input) => {
    expect(computeRiskDistance({ ...input, target: 120, cost: 95 })).toEqual({
      status: "unknown",
      stopDistanceRatio: null,
      targetDistanceRatio: null,
      markerPosition: null,
      hasTarget: false,
      rMultiple: null,
    });
  });

  it.each([
    { price: 100, expectedDistance: 0 },
    { price: 80, expectedDistance: -0.25 },
  ])(
    "marks price $price at or below the stop as touched",
    ({ price, expectedDistance }) => {
      expect(computeRiskDistance({ price, stop: 100 })).toMatchObject({
        status: "touched",
        stopDistanceRatio: expectedDistance,
        markerPosition: 0,
      });
    },
  );

  it.each([
    { stop: 97.5, expectedDistance: 0.025, status: "near" },
    { stop: 97, expectedDistance: 0.03, status: "near" },
    { stop: 96, expectedDistance: 0.04, status: "safe" },
  ])(
    "classifies a $expectedDistance stop distance as $status",
    ({ stop, expectedDistance, status }) => {
      expect(computeRiskDistance({ price: 100, stop })).toMatchObject({
        status,
        stopDistanceRatio: expect.closeTo(expectedDistance, 10),
      });
    },
  );

  it("measures both distances, marker position and R multiple with a target", () => {
    expect(
      computeRiskDistance({
        price: 1648.5,
        stop: 1548,
        target: 1760,
        cost: 1580,
      }),
    ).toMatchObject({
      stopDistanceRatio: expect.closeTo(100.5 / 1648.5, 10),
      targetDistanceRatio: expect.closeTo(111.5 / 1648.5, 10),
      markerPosition: expect.closeTo(100.5 / 212, 10),
      hasTarget: true,
      rMultiple: expect.closeTo(68.5 / 32, 10),
    });
  });

  it("uses half the 20% buffer when the target is omitted and the stop is 10% away", () => {
    expect(computeRiskDistance({ price: 100, stop: 90 })).toMatchObject({
      hasTarget: false,
      targetDistanceRatio: null,
      markerPosition: expect.closeTo(0.5, 10),
    });
  });

  it.each([80, 75])(
    "ignores target %s at or below the stop and clamps the marker to 1",
    (target) => {
      expect(
        computeRiskDistance({ price: 120, stop: 80, target }),
      ).toMatchObject({
        hasTarget: false,
        targetDistanceRatio: null,
        markerPosition: 1,
      });
    },
  );

  it.each([90, 85])(
    "keeps the R multiple unknown when cost %s is at or below the stop",
    (cost) => {
      expect(
        computeRiskDistance({ price: 100, stop: 90, target: 120, cost })
          .rMultiple,
      ).toBeNull();
    },
  );
});
