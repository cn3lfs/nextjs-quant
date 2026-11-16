export function labDetailStatus(
  eligible: boolean,
  promoted: boolean,
  shadowActive: boolean,
) {
  return eligible && promoted
    ? "已晋级"
    : shadowActive
      ? "影子前推中"
      : "研究中";
}

type PauseSuggestion = {
  action: string;
  strategyId: string | null;
  version: number | null;
  revision: string | null;
  reason: string;
};

/** Reuse the review service's evidence; never infer decay from displayed returns. */
export function labPauseSuggestion<T extends PauseSuggestion>(
  suggestions: readonly T[],
  id: string,
  version: number,
  revision: string,
) {
  const suggestion = suggestions.find(
    (s) =>
      s.action === "pause-live" &&
      s.strategyId === id &&
      s.version === version &&
      !!s.revision,
  );
  return suggestion
    ? { suggestion, current: suggestion.revision === revision }
    : null;
}
