export const researchKellyQualityVersion = "research-kelly-breakout-quality-1";

/** Read the five frozen checks, never trust a supplied score or probability. */
export function researchKellyQuality(evidence: string) {
  try {
    const parsed = JSON.parse(evidence) as { checks?: Record<string, unknown> };
    const values = ["trend", "level", "volume", "indicators", "candle"].map(
      (key) => parsed.checks?.[key],
    );
    if (values.some((value) => value !== "是" && value !== "否"))
      return { score: null, winRate: null, reason: "双突破五项质量证据不可用" };
    const score = values.filter((value) => value === "是").length;
    return {
      score,
      winRate: score >= 3 ? [0.45, 0.5, 0.55][score - 3]! : null,
      reason: score >= 3 ? null : "信号质量不足3/5，不买入",
    };
  } catch {
    return { score: null, winRate: null, reason: "双突破五项质量证据不可用" };
  }
}
