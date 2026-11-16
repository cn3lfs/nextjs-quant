import { expect, it } from "vitest";
import {
  labDetailStatus,
  labPauseSuggestion,
} from "~/components/research/lab-review";

it("keeps an old promotion record from claiming current qualification", () => {
  expect(labDetailStatus(false, true, true)).toBe("影子前推中");
  expect(labDetailStatus(false, true, false)).toBe("研究中");
  expect(labDetailStatus(true, false, true)).toBe("影子前推中");
  expect(labDetailStatus(true, true, true)).toBe("已晋级");
});

const suggestion = {
  action: "pause-live",
  strategyId: "same-parameters",
  version: 2,
  revision: "current",
  reason: "同参数二十日选择归因衰减，建议人工核对",
};
it("uses only the matching strategy/version pause suggestion and preserves its reason", () => {
  const result = labPauseSuggestion(
    [
      { ...suggestion, strategyId: "other" },
      { ...suggestion, version: 1 },
      { ...suggestion, action: "reduce" },
      suggestion,
    ],
    "same-parameters",
    2,
    "current",
  );
  expect(result).toEqual({ suggestion, current: true });
  expect(result?.suggestion).toBe(suggestion);
});
it("does not turn a stale review into an executable current recommendation", () => {
  expect(
    labPauseSuggestion([suggestion], "same-parameters", 2, "new-revision"),
  ).toEqual({ suggestion, current: false });
});
it("missing evidence and unbound recommendations do not manufacture decay", () => {
  expect(labPauseSuggestion([], "same-parameters", 2, "current")).toBeNull();
  expect(
    labPauseSuggestion(
      [{ ...suggestion, revision: null }],
      "same-parameters",
      2,
      "current",
    ),
  ).toBeNull();
});
