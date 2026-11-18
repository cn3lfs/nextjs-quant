import { describe, expect, it } from "vitest";
import {
  composeLongOnlyStrategies,
  type ComposeLongOnlyStrategiesInput,
  type CompositionActualContribution,
  type CompositionExitInstruction,
} from "../src/theory-composition.js";

const asOf = Date.UTC(2026, 10, 17, 8);
const frozenAt = asOf - 3_600_000;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value))
      deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function fill(
  childId: string,
  symbol: string,
  contribution: number,
  fillId = `${childId}-${symbol}`,
  revision = 1,
): CompositionActualContribution {
  return { childId, symbol, contribution, fillId, revision };
}

function exitToZero(
  exitId: string,
  childId: string,
  symbol: string,
): CompositionExitInstruction {
  return { exitId, childId, symbol, kind: "exit", targetContribution: 0 };
}

function baseInput(
  overrides: Partial<ComposeLongOnlyStrategiesInput> = {},
): ComposeLongOnlyStrategiesInput {
  return {
    asOf,
    rebalanceDue: true,
    hardExit: false,
    gate: { frozenAt, rows: [[0.5, 0.5]] },
    alpha: [1],
    children: [
      { childId: "A", status: "valid", targetWeights: { X: 0.8 } },
      { childId: "B", status: "valid", targetWeights: { Z: 0.8 } },
    ],
    capPerSymbol: 0.6,
    grossLimit: 1,
    actualContributions: [],
    exitInstructions: [],
    acknowledgedExitIds: [],
    ...overrides,
  };
}

describe("F18.09 composeLongOnlyStrategies", () => {
  it("caps a shared symbol first, then scales the whole vector to G", () => {
    const result = composeLongOnlyStrategies(
      baseInput({
        alpha: [0.6, 0.4],
        gate: {
          frozenAt,
          rows: [
            [0.5, 0.5],
            [0.25, 0.75],
          ],
        },
        children: [
          { childId: "A", status: "valid", targetWeights: { X: 0.8, Y: 0.2 } },
          { childId: "B", status: "valid", targetWeights: { X: 0.8, Z: 0.2 } },
        ],
        capPerSymbol: 0.3,
        grossLimit: 0.4,
      }),
    );
    // a_A = .6*.5 + .4*.25 = .4, a_B = .6*.5 + .4*.75 = .6.
    // u_X = .4*.8 + .6*.8 = .8, u_Y = .4*.2 = .08, u_Z = .6*.2 = .12.
    // Cap: X = .3, Y = .08, Z = .12, sum .5; G=.4 -> scale .8.
    // X=.24, Y=.064, Z=.096, cash=.6.
    expect(result.status).toBe("TARGET");
    expect(result.targetContributions).toEqual({
      X: 0.24,
      Y: 0.064,
      Z: 0.096,
    });
    expect(result.remainingTargetContributions).toEqual({
      X: 0.24,
      Y: 0.064,
      Z: 0.096,
    });
    expect(result.grossTarget).toBeCloseTo(0.4, 12);
    expect(result.cashTarget).toBeCloseTo(0.6, 12);
  });

  it("keeps an invalid child's share in cash instead of redistributing it", () => {
    const result = composeLongOnlyStrategies(
      baseInput({
        alpha: [0.6, 0.4],
        gate: {
          frozenAt,
          rows: [
            [0.5, 0.5],
            [0.25, 0.75],
          ],
        },
        children: [
          { childId: "A", status: "invalid" },
          { childId: "B", status: "valid", targetWeights: { X: 0.8, Z: 0.2 } },
        ],
        capPerSymbol: 0.3,
        grossLimit: 1,
      }),
    );
    // a_B = .6, so u_X = .48 capped to .3, u_Z = .12. Cash = .58.
    expect(result.status).toBe("TARGET");
    expect(result.targetContributions).toEqual({ X: 0.3, Z: 0.12 });
    expect(result.remainingTargetContributions).toEqual({ X: 0.3, Z: 0.12 });
    expect(result.cashTarget).toBeCloseTo(0.58, 12);
    expect(result.allocations[0]).toMatchObject({
      childId: "A",
      status: "invalid",
      gateWeight: 0,
      rawTargetWeight: 0,
    });
  });

  it("treats an unknown child as unknown configuration, not as invalid", () => {
    const result = composeLongOnlyStrategies(
      baseInput({
        children: [
          { childId: "A", status: "valid", targetWeights: { X: 0.5 } },
          { childId: "B", status: "unknown" },
        ],
        actualContributions: [fill("B", "Y", 0.2)],
      }),
    );
    // No new allocation for B; only its traceable actual holding is carried.
    expect(result.status).toBe("UNKNOWN");
    expect(result.targetContributions).toBeNull();
    expect(result.remainingTargetContributions).toEqual({ Y: 0.2 });
    expect(result.cashTarget).toBeCloseTo(0.8, 12);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "UNKNOWN_CHILD_STATUS" }),
    );
    expect(result.allocations[1]).toMatchObject({
      childId: "B",
      status: "unknown",
      gateWeight: 0,
      heldContribution: 0.2,
    });
  });

  it("keeps independent exits while an unknown gate blocks new allocation", () => {
    const result = composeLongOnlyStrategies(
      baseInput({
        gate: null,
        alpha: null,
        actualContributions: [fill("A", "X", 0.3), fill("B", "Z", 0.2)],
        exitInstructions: [exitToZero("e1", "A", "X")],
      }),
    );
    expect(result.status).toBe("UNKNOWN");
    expect(result.targetContributions).toBeNull();
    expect(result.remainingTargetContributions).toEqual({ X: 0, Z: 0.2 });
    expect(result.requestedReductions).toHaveLength(1);
    expect(result.requestedReductions[0]).toMatchObject({
      exitId: "e1",
      childId: "A",
      symbol: "X",
      actualContribution: 0.3,
      requested: 0.3,
      remainingContribution: 0,
    });
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "GATE_MISSING" }),
    );
  });

  it("checks unknown configuration before the non-rebalance calendar", () => {
    const unknownChild = composeLongOnlyStrategies(
      baseInput({
        rebalanceDue: false,
        children: [
          { childId: "A", status: "valid", targetWeights: { X: 0.5 } },
          { childId: "B", status: "unknown" },
        ],
        actualContributions: [fill("B", "Y", 0.2)],
      }),
    );
    expect(unknownChild.status).toBe("UNKNOWN");
    expect(unknownChild.remainingTargetContributions).toEqual({ Y: 0.2 });

    const known = composeLongOnlyStrategies(
      baseInput({
        rebalanceDue: false,
        actualContributions: [fill("A", "X", 0.3)],
      }),
    );
    expect(known.status).toBe("KEEP_PREVIOUS_TARGET");
    expect(known.remainingTargetContributions).toEqual({ X: 0.3 });
  });

  it("processes exits on a non-rebalance day and leaves actual untouched", () => {
    const input = deepFreeze(
      baseInput({
        rebalanceDue: false,
        actualContributions: [fill("A", "X", 0.3)],
        exitInstructions: [
          {
            exitId: "e1",
            childId: "A",
            symbol: "X",
            kind: "reduce",
            targetContribution: 0.1,
          },
        ],
      }),
    );
    const before = clone(input);
    const result = composeLongOnlyStrategies(input);
    expect(result.status).toBe("KEEP_PREVIOUS_TARGET");
    expect(result.targetContributions).toBeNull();
    expect(result.remainingTargetContributions).toEqual({ X: 0.1 });
    expect(result.requestedReductions[0]?.requested).toBeCloseTo(0.2, 12);
    expect(input).toEqual(before);
    expect(result.allocations[0]?.heldContribution).toBe(0.3);
  });

  it("replays pending intents idempotently and does not treat ack as a fill", () => {
    const input = baseInput({
      actualContributions: [fill("A", "X", 0.3)],
      exitInstructions: [
        {
          exitId: "e1",
          childId: "A",
          symbol: "X",
          kind: "reduce",
          targetContribution: 0.1,
        },
      ],
    });
    const first = composeLongOnlyStrategies(input);
    expect(composeLongOnlyStrategies(input)).toEqual(first);
    expect(first.requestedReductions).toHaveLength(1);
    expect(first.acknowledgedReductions).toHaveLength(0);

    const acknowledged = composeLongOnlyStrategies({
      ...input,
      acknowledgedExitIds: ["e1"],
    });
    // Acknowledgement does not remove the unfilled request.
    expect(acknowledged.requestedReductions).toHaveLength(1);
    expect(acknowledged.requestedReductions[0]?.acknowledged).toBe(true);
    expect(acknowledged.acknowledgedReductions).toHaveLength(1);
    expect(acknowledged.requestedReductions[0]?.requested).toBeCloseTo(0.2, 12);

    expect(composeLongOnlyStrategies(input).requestedReductions).toHaveLength(
      1,
    );
  });

  it("reduces only the unfilled remainder after host fills are fed back", () => {
    const instruction: CompositionExitInstruction = {
      exitId: "e1",
      childId: "A",
      symbol: "X",
      kind: "reduce",
      targetContribution: 0.1,
    };
    const requestFor = (contribution: number) =>
      composeLongOnlyStrategies(
        baseInput({
          actualContributions: [fill("A", "X", contribution)],
          exitInstructions: [instruction],
        }),
      ).requestedReductions[0]?.requested ?? 0;

    expect(requestFor(0.3)).toBeCloseTo(0.2, 12);
    expect(requestFor(0.2)).toBeCloseTo(0.1, 12);
    expect(requestFor(0.1)).toBe(0);
    expect(requestFor(0.05)).toBe(0);
  });

  it("does not reduce a second child at the same symbol", () => {
    const input = deepFreeze(
      baseInput({
        children: [
          { childId: "A", status: "valid", targetWeights: { X: 0.5 } },
          { childId: "B", status: "valid", targetWeights: { X: 0.5 } },
        ],
        actualContributions: [
          fill("A", "X", 0.2, "fa"),
          fill("B", "X", 0.3, "fb"),
        ],
        exitInstructions: [
          {
            exitId: "e1",
            childId: "A",
            symbol: "X",
            kind: "reduce",
            targetContribution: 0.1,
          },
        ],
      }),
    );
    const before = clone(input);
    const result = composeLongOnlyStrategies(input);
    expect(result.requestedReductions).toHaveLength(1);
    expect(result.requestedReductions[0]).toMatchObject({
      childId: "A",
      symbol: "X",
      actualContribution: 0.2,
      requested: 0.1,
    });
    expect(input).toEqual(before);

    // Fill A down to .15 -> request .05; fill to .1 -> no remaining request.
    const afterPartialFill = composeLongOnlyStrategies({
      ...input,
      actualContributions: [
        fill("A", "X", 0.15, "fa"),
        fill("B", "X", 0.3, "fb"),
      ],
    });
    expect(afterPartialFill.requestedReductions[0]?.requested).toBeCloseTo(
      0.05,
      12,
    );
    const atTarget = composeLongOnlyStrategies({
      ...input,
      actualContributions: [
        fill("A", "X", 0.1, "fa"),
        fill("B", "X", 0.3, "fb"),
      ],
    });
    expect(atTarget.requestedReductions).toHaveLength(0);
    expect(input).toEqual(before);
  });

  it("still quantifies exits when the gate is missing or the day is not due", () => {
    const instruction: CompositionExitInstruction = {
      exitId: "e1",
      childId: "A",
      symbol: "X",
      kind: "reduce",
      targetContribution: 0.1,
    };
    const missingGate = composeLongOnlyStrategies(
      baseInput({
        gate: null,
        alpha: null,
        actualContributions: [fill("A", "X", 0.2)],
        exitInstructions: [instruction],
      }),
    );
    expect(missingGate.requestedReductions[0]?.requested).toBeCloseTo(0.1, 12);

    const notDue = composeLongOnlyStrategies(
      baseInput({
        rebalanceDue: false,
        actualContributions: [fill("A", "X", 0.2)],
        exitInstructions: [instruction],
      }),
    );
    expect(notDue.requestedReductions[0]?.requested).toBeCloseTo(0.1, 12);
  });

  it("does not double count duplicate ids or different ids on one holding", () => {
    const duplicate = composeLongOnlyStrategies(
      baseInput({
        actualContributions: [fill("A", "X", 0.2)],
        exitInstructions: [
          exitToZero("e1", "A", "X"),
          exitToZero("e1", "A", "X"),
        ],
      }),
    );
    expect(duplicate.requestedReductions).toHaveLength(1);
    expect(duplicate.requestedReductions[0]?.requested).toBeCloseTo(0.2, 12);

    const conflicting = composeLongOnlyStrategies(
      baseInput({
        actualContributions: [fill("A", "X", 0.2)],
        exitInstructions: [
          exitToZero("e1", "A", "X"),
          {
            exitId: "e1",
            childId: "A",
            symbol: "X",
            kind: "reduce",
            targetContribution: 0.1,
          },
        ],
      }),
    );
    expect(conflicting.status).toBe("UNKNOWN");
    expect(conflicting.requestedReductions).toHaveLength(0);
    expect(conflicting.issues).toContainEqual(
      expect.objectContaining({ code: "CONFLICTING_EXIT_ID", exitId: "e1" }),
    );

    const twoIds = composeLongOnlyStrategies(
      baseInput({
        actualContributions: [fill("A", "X", 0.2)],
        exitInstructions: [
          exitToZero("e1", "A", "X"),
          {
            exitId: "e2",
            childId: "A",
            symbol: "X",
            kind: "reduce",
            targetContribution: 0.1,
          },
        ],
      }),
    );
    const total = twoIds.requestedReductions.reduce(
      (sum, reduction) => sum + reduction.requested,
      0,
    );
    expect(total).toBeCloseTo(0.2, 12);
    expect(twoIds.remainingTargetContributions?.X).toBe(0);
  });

  it("turns a hard exit into a full-cash intent without fabricating fills", () => {
    const result = composeLongOnlyStrategies(
      baseInput({
        hardExit: true,
        gate: null,
        alpha: null,
        actualContributions: [fill("A", "X", 0.3), fill("B", "Z", 0.2)],
      }),
    );
    expect(result.status).toBe("HARD_EXIT");
    expect(result.targetContributions).toBeNull();
    expect(result.remainingTargetContributions).toEqual({ X: 0, Z: 0 });
    expect(result.grossTarget).toBe(0);
    expect(result.cashTarget).toBe(1);
    expect(result.requestedReductions).toHaveLength(2);
    expect(
      result.requestedReductions.reduce(
        (sum, reduction) => sum + reduction.requested,
        0,
      ),
    ).toBeCloseTo(0.5, 12);
    expect(
      result.requestedReductions.every((r) => r.kind === "hard-exit"),
    ).toBe(true);
  });

  it("keeps hard exit as an intent when actual is missing but audits the gap", () => {
    const result = composeLongOnlyStrategies(
      baseInput({ hardExit: true, actualContributions: undefined }),
    );
    expect(result.status).toBe("HARD_EXIT");
    expect(result.remainingTargetContributions).toEqual({});
    expect(result.grossTarget).toBe(0);
    expect(result.cashTarget).toBe(1);
    expect(result.requestedReductions).toHaveLength(0);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "UNTRACEABLE_CONTRIBUTION" }),
    );
  });

  it("liquidates an invalid child's recognized holding to an explicit zero", () => {
    const result = composeLongOnlyStrategies(
      baseInput({
        children: [
          { childId: "A", status: "valid", targetWeights: { X: 0.8 } },
          { childId: "B", status: "invalid" },
        ],
        actualContributions: [fill("B", "Y", 0.2)],
      }),
    );
    expect(result.status).toBe("TARGET");
    expect(result.targetContributions).toEqual({ X: 0.4 });
    expect(result.remainingTargetContributions).toEqual({ X: 0.4, Y: 0 });
  });

  it("treats a missing actual snapshot as unknown rather than zero", () => {
    const exitInstruction = exitToZero("e1", "A", "X");
    const rebalance = composeLongOnlyStrategies(
      baseInput({
        actualContributions: undefined,
        exitInstructions: [exitInstruction],
      }),
    );
    expect(rebalance.status).toBe("UNKNOWN");
    expect(rebalance.remainingTargetContributions).toBeNull();
    expect(rebalance.grossTarget).toBeNull();
    expect(rebalance.cashTarget).toBeNull();
    expect(rebalance.requestedReductions).toHaveLength(0);
    expect(rebalance.pendingUnknownReductions).toEqual([
      {
        exitId: "e1",
        childId: "A",
        symbol: "X",
        kind: "exit",
        targetContribution: 0,
        reason: "ACTUAL_SNAPSHOT_MISSING",
      },
    ]);

    const notDue = composeLongOnlyStrategies(
      baseInput({
        rebalanceDue: false,
        actualContributions: undefined,
        exitInstructions: [exitInstruction],
      }),
    );
    expect(notDue.status).toBe("UNKNOWN");
    expect(notDue.remainingTargetContributions).toBeNull();
  });

  it("reports an untraceable contribution but still computes other exits", () => {
    const result = composeLongOnlyStrategies(
      baseInput({
        actualContributions: [
          fill("A", "X", 0.1, "f1", 1),
          fill("A", "X", 0.2, "f1", 1),
          fill("B", "Z", 0.3, "f2", 1),
        ],
        exitInstructions: [
          exitToZero("e1", "A", "X"),
          exitToZero("e2", "B", "Z"),
        ],
      }),
    );
    expect(result.status).toBe("UNKNOWN");
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "UNTRACEABLE_CONTRIBUTION",
        childId: "A",
        symbol: "X",
      }),
    );
    expect(result.requestedReductions).toHaveLength(1);
    expect(result.requestedReductions[0]).toMatchObject({
      exitId: "e2",
      childId: "B",
      symbol: "Z",
      requested: 0.3,
    });
    // A's actual is unknown, so a complete cash figure is not claimed.
    expect(result.remainingTargetContributions).toBeNull();
    expect(result.grossTarget).toBeNull();
    expect(result.cashTarget).toBeNull();
    expect(result.pendingUnknownReductions[0]).toMatchObject({
      exitId: "e1",
      reason: "UNTRACEABLE_CONTRIBUTION",
    });
  });

  it("does not reuse one fill id across child/symbol identities", () => {
    const result = composeLongOnlyStrategies(
      baseInput({
        actualContributions: [
          fill("A", "X", 0.1, "same-fill"),
          fill("B", "Z", 0.2, "same-fill"),
        ],
        exitInstructions: [
          exitToZero("e1", "A", "X"),
          exitToZero("e2", "B", "Z"),
        ],
      }),
    );
    expect(result.status).toBe("UNKNOWN");
    expect(result.requestedReductions).toHaveLength(0);
    expect(result.remainingTargetContributions).toBeNull();
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "UNTRACEABLE_CONTRIBUTION" }),
    );
  });

  it("uses only the latest revision of a fill identity", () => {
    const result = composeLongOnlyStrategies(
      baseInput({
        actualContributions: [
          fill("A", "X", 0.3, "f1", 1),
          fill("A", "X", 0.2, "f1", 2),
          fill("A", "X", 0.1, "f1", 1),
        ],
        exitInstructions: [exitToZero("e1", "A", "X")],
      }),
    );
    expect(result.requestedReductions[0]?.actualContribution).toBe(0.2);
    expect(result.requestedReductions[0]?.requested).toBe(0.2);
  });

  it("accepts zero cap and zero gross limit as risk-off, not invalid", () => {
    const zeroCap = composeLongOnlyStrategies(
      baseInput({ capPerSymbol: 0, grossLimit: 1 }),
    );
    expect(zeroCap.status).toBe("TARGET");
    expect(zeroCap.targetContributions).toEqual({ X: 0, Z: 0 });
    expect(zeroCap.grossTarget).toBe(0);
    expect(zeroCap.cashTarget).toBe(1);

    const zeroGross = composeLongOnlyStrategies(
      baseInput({ capPerSymbol: 1, grossLimit: 0 }),
    );
    expect(zeroGross.status).toBe("TARGET");
    expect(zeroGross.targetContributions).toEqual({ X: 0, Z: 0 });
    expect(zeroGross.grossTarget).toBe(0);
    expect(zeroGross.cashTarget).toBe(1);
  });

  it("keeps traceable exit requests identical under illegal or future gate evidence", () => {
    const instruction: CompositionExitInstruction = {
      exitId: "e1",
      childId: "A",
      symbol: "X",
      kind: "reduce",
      targetContribution: 0.1,
    };
    const withConfig = (overrides: Partial<ComposeLongOnlyStrategiesInput>) =>
      composeLongOnlyStrategies(
        baseInput({
          actualContributions: [fill("A", "X", 0.2)],
          exitInstructions: [instruction],
          ...overrides,
        }),
      );

    const baseline = withConfig({});
    expect(baseline.status).toBe("TARGET");
    expect(baseline.requestedReductions).toHaveLength(1);
    expect(baseline.requestedReductions[0]?.requested).toBeCloseTo(0.1, 12);

    const cases: {
      overrides: Partial<ComposeLongOnlyStrategiesInput>;
      code: string;
    }[] = [
      {
        overrides: { gate: { frozenAt: asOf + 1, rows: [[0.5, 0.5]] } },
        code: "GATE_INVALID",
      },
      {
        overrides: { alpha: [0.9] },
        code: "ALPHA_INVALID",
      },
      {
        overrides: {
          children: [
            { childId: "A", status: "valid", targetWeights: { X: 1.1 } },
            { childId: "B", status: "valid", targetWeights: { Z: 0.8 } },
          ],
        },
        code: "CHILD_TARGET_INVALID",
      },
    ];

    for (const { overrides, code } of cases) {
      const result = withConfig(overrides);
      expect(result.status).toBe("UNKNOWN");
      expect(result.targetContributions).toBeNull();
      expect(result.requestedReductions).toEqual(baseline.requestedReductions);
      expect(result.issues).toContainEqual(expect.objectContaining({ code }));
    }
  });

  it("collects illegal configuration as UNKNOWN and never admits a target", () => {
    const illegalAlpha = composeLongOnlyStrategies(
      baseInput({
        gate: {
          frozenAt,
          rows: [
            [0.5, 0.5],
            [0.5, 0.5],
          ],
        },
        alpha: [0.5, 0.4],
      }),
    );
    expect(illegalAlpha.status).toBe("UNKNOWN");
    expect(illegalAlpha.targetContributions).toBeNull();
    expect(illegalAlpha.issues).toContainEqual(
      expect.objectContaining({ code: "ALPHA_INVALID" }),
    );

    const illegalRow = composeLongOnlyStrategies(
      baseInput({ gate: { frozenAt, rows: [[0.5, 0.4]] } }),
    );
    expect(illegalRow.status).toBe("UNKNOWN");
    expect(illegalRow.targetContributions).toBeNull();
    expect(illegalRow.issues).toContainEqual(
      expect.objectContaining({ code: "GATE_INVALID" }),
    );

    const illegalChildTarget = composeLongOnlyStrategies(
      baseInput({
        children: [
          { childId: "A", status: "valid", targetWeights: { X: 1.1 } },
          { childId: "B", status: "valid", targetWeights: { Z: 0.5 } },
        ],
      }),
    );
    expect(illegalChildTarget.status).toBe("UNKNOWN");
    expect(illegalChildTarget.targetContributions).toBeNull();
    expect(illegalChildTarget.issues).toContainEqual(
      expect.objectContaining({ code: "CHILD_TARGET_INVALID" }),
    );

    const contradictoryChild = composeLongOnlyStrategies(
      baseInput({
        children: [
          { childId: "A", status: "valid", targetWeights: { X: 0.5 } },
          { childId: "B", status: "unknown", targetWeights: { Z: 0.5 } },
        ],
      }),
    );
    expect(contradictoryChild.status).toBe("UNKNOWN");
    expect(contradictoryChild.targetContributions).toBeNull();
    expect(contradictoryChild.issues).toContainEqual(
      expect.objectContaining({ code: "CHILD_TARGET_INVALID" }),
    );
  });

  it("keeps a hard exit as a full-cash intent under every illegal gate shape", () => {
    const variants: Partial<ComposeLongOnlyStrategiesInput>[] = [
      { gate: { frozenAt: asOf + 1, rows: [[0.5, 0.5]] } },
      { gate: { frozenAt, rows: [[0.5, 0.4]] } },
      { gate: { frozenAt, rows: [[0.5, 0.5]] }, alpha: [0.9] },
      {
        children: [
          { childId: "A", status: "valid", targetWeights: { X: 1.1 } },
          { childId: "B", status: "valid", targetWeights: { Z: 0.8 } },
        ],
      },
    ];

    for (const variant of variants) {
      const input = deepFreeze(
        baseInput({
          hardExit: true,
          actualContributions: [fill("A", "X", 0.3)],
          ...variant,
        }),
      );
      const before = clone(input);
      const result = composeLongOnlyStrategies(input);
      expect(result.status).toBe("HARD_EXIT");
      expect(result.grossTarget).toBe(0);
      expect(result.cashTarget).toBe(1);
      expect(result.requestedReductions).toHaveLength(1);
      expect(result.requestedReductions[0]?.requested).toBeCloseTo(0.3, 12);
      expect(input).toEqual(before);
    }
  });

  it("audits a bad decision clock without fabricating an amount", () => {
    const input = deepFreeze(
      baseInput({
        asOf: "2026-11-17T08:00:00",
        actualContributions: [fill("A", "X", 0.2)],
        exitInstructions: [
          {
            exitId: "e1",
            childId: "A",
            symbol: "X",
            kind: "reduce",
            targetContribution: 0.1,
          },
        ],
      }),
    );
    const before = clone(input);
    const result = composeLongOnlyStrategies(input);
    expect(result.status).toBe("UNKNOWN");
    expect(result.asOf).toBeNull();
    expect(result.targetContributions).toBeNull();
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "ASOF_INVALID" }),
    );
    expect(result.requestedReductions[0]?.requested).toBeCloseTo(0.1, 12);
    expect(input).toEqual(before);

    const hardResult = composeLongOnlyStrategies(
      baseInput({
        asOf: "2026-11-17T08:00:00",
        hardExit: true,
        actualContributions: [fill("A", "X", 0.3)],
      }),
    );
    expect(hardResult.status).toBe("HARD_EXIT");
    expect(hardResult.cashTarget).toBe(1);
    expect(hardResult.requestedReductions[0]?.requested).toBeCloseTo(0.3, 12);
    expect(hardResult.issues).toContainEqual(
      expect.objectContaining({ code: "ASOF_INVALID" }),
    );
  });

  it("audits invalid actual evidence without inventing amounts", () => {
    const input = deepFreeze(
      baseInput({
        actualContributions: [fill("A", "X", -0.2), fill("B", "Z", 0.3)],
        exitInstructions: [
          exitToZero("e1", "A", "X"),
          exitToZero("e2", "B", "Z"),
        ],
      }),
    );
    const before = clone(input);
    const result = composeLongOnlyStrategies(input);
    expect(result.status).toBe("UNKNOWN");
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "ACTUAL_INVALID" }),
    );
    expect(result.requestedReductions).toHaveLength(1);
    expect(result.requestedReductions[0]).toMatchObject({
      exitId: "e2",
      childId: "B",
      symbol: "Z",
      requested: 0.3,
    });
    expect(result.remainingTargetContributions).toBeNull();
    expect(input).toEqual(before);

    const hardResult = composeLongOnlyStrategies(
      baseInput({
        hardExit: true,
        actualContributions: [fill("A", "X", -0.2), fill("B", "Z", 0.3)],
      }),
    );
    expect(hardResult.status).toBe("HARD_EXIT");
    expect(hardResult.cashTarget).toBe(1);
    expect(hardResult.requestedReductions).toHaveLength(1);
    expect(hardResult.requestedReductions[0]).toMatchObject({
      childId: "B",
      symbol: "Z",
      requested: 0.3,
    });
    expect(hardResult.issues).toContainEqual(
      expect.objectContaining({ code: "ACTUAL_INVALID" }),
    );

    // A valid fill for the same key cannot turn skipped evidence into a
    // quantified reduction; the unknown remainder stays pending.
    const mixedKey = composeLongOnlyStrategies(
      baseInput({
        actualContributions: [
          fill("A", "X", -0.2, "bad"),
          fill("A", "X", 0.1, "good"),
        ],
        exitInstructions: [exitToZero("e1", "A", "X")],
      }),
    );
    expect(mixedKey.status).toBe("UNKNOWN");
    expect(mixedKey.requestedReductions).toHaveLength(0);
    expect(mixedKey.pendingUnknownReductions).toContainEqual(
      expect.objectContaining({
        exitId: "e1",
        reason: "UNTRACEABLE_CONTRIBUTION",
      }),
    );
  });

  it("rejects structural parameter errors", () => {
    expect(() =>
      composeLongOnlyStrategies(baseInput({ capPerSymbol: 1.1 })),
    ).toThrow(/capPerSymbol/);
    expect(() =>
      composeLongOnlyStrategies(baseInput({ grossLimit: -0.1 })),
    ).toThrow(/grossLimit/);
    expect(() =>
      composeLongOnlyStrategies(
        baseInput({
          children: [
            { childId: "A", status: "valid", targetWeights: { X: 0.5 } },
            { childId: "A", status: "valid", targetWeights: { Z: 0.5 } },
          ],
        }),
      ),
    ).toThrow(/duplicate composition childId/);
    expect(() =>
      composeLongOnlyStrategies(
        baseInput({
          exitInstructions: [
            {
              exitId: "e1",
              childId: "A",
              symbol: "X",
              kind: "reduce",
              targetContribution: 1.1,
            },
          ],
        }),
      ),
    ).toThrow(/targetContribution/);
  });
});
