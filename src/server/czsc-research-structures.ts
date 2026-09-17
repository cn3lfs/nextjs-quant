import type { CzscFamily, CzscSignalStructure } from "~/lib/czsc";
import type { CzscProjections } from "./czsc";
import { decodeCzscNative } from "./czsc-structures";

const fields = {
  contextFlags: 21,
  breakoutId: 26,
  pointId: 27,
  trendId: 28,
  leavePointId: 33,
  retestPointId: 34,
  smallTurnLeavePointId: 38,
  smallTurnRetestPointId: 39,
  secondBasePointId: 40,
  secondTurnPointId: 41,
  smallTurnBasePointId: 42,
  previousStartPointId: 43,
  previousEndPointId: 44,
  currentStartPointId: 45,
  currentEndPointId: 46,
  centerLifecycle: 47,
} as const;
export const czscNativeOutputs = Array.from({ length: 34 }, (_, i) => i + 59);
export const czscResearchOutputs = [
  ...new Set([
    10,
    11,
    12,
    13,
    ...Object.values(fields),
    48,
    49,
    50,
    51,
    52,
    56,
    57,
    58,
  ]),
];

/** Decode only. No JS reconstruction of missing native trends/candidates. */
export function decodeCzscResearchStructures(
  raw: CzscProjections,
  config: 0 | 1100,
  length: number,
  includeNative = false,
  anchor?: 1 | 2,
) {
  const codes: Record<number, readonly number[]> = {
    11: [0, 1, 2, 3],
    12: [-1, 0, 1],
    13: [0, 1, 2, 3, 4],
    47: [-3, 0, 1, 2, 3],
    48: [-3, 0, 1, 2, 3],
    49: [0, 1, 2],
    56: [0, 1, 2, 3],
    58: [-1, 0, 1],
  };
  for (const output of czscResearchOutputs) {
    const values = raw.projections[`${config}:${output}`];
    if (
      !values ||
      values.length !== length ||
      values.some(
        (v) =>
          !Number.isFinite(v) ||
          (output !== 10 &&
            (!Number.isInteger(v) ||
              (codes[output] ? !codes[output]!.includes(v) : v < 0))),
      )
    )
      throw new Error(
        `结构缺口：原生投影${config}:${output}缺失、长度错误或非有限值`,
      );
  }
  const at = (output: number, i: number) =>
    raw.projections[`${config}:${output}`]![i]!;
  const signal = (index: number): CzscSignalStructure =>
    Object.fromEntries(
      Object.entries(fields).map(([key, output]) => [key, at(output, index)]),
    ) as CzscSignalStructure;
  const diagnostics: NonNullable<CzscFamily["diagnostics"]> = {
    version: "native-projections-b67f3c6-1",
    ma: Array.from({ length }, (_, index) => ({
      index,
      difference: at(10, index),
      kiss: at(11, index),
      instantWarning: at(12, index),
      volumeKiss: at(13, index),
    })),
    lifecycle: Array.from({ length }, (_, index) => ({
      index,
      value: at(48, index),
    })).filter((p) => p.value !== 0),
    // Level zero can still contain consolidation context (56/57/58).
    nested: Array.from({ length }, (_, index) => ({
      lowConfig: 0 as const,
      sourceConfig: 1100 as const,
      index,
      level: at(49, index),
      sourceCandidateId: at(50, index),
      lowStartPointId: at(51, index),
      lowEndPointId: at(52, index),
      semantic: at(56, index),
      confirmFlags: at(57, index),
      direction: at(58, index),
    })).filter(
      (p) => p.level !== 0 || p.semantic !== 0 || p.confirmFlags !== 0,
    ),
  };
  return {
    signal,
    diagnostics,
    ...(includeNative
      ? { native: decodeCzscNative(raw, config, length, anchor) }
      : {}),
  };
}
