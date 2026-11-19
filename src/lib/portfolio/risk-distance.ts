export type RiskDistanceStatus = "unknown" | "touched" | "near" | "safe";

export type RiskDistanceInput = {
  price: number | null | undefined;
  stop: number | null | undefined;
  target?: number | null | undefined;
  cost?: number | null | undefined;
  /** 距止损阈值，以比例表示，默认 0.03。 */
  nearThreshold?: number;
};

export type RiskDistanceResult = {
  status: RiskDistanceStatus;
  stopDistanceRatio: number | null;
  targetDistanceRatio: number | null;
  /** 有目标价时按止损到目标价定位，缺目标价时按 20% 安全缓冲定位。 */
  markerPosition: number | null;
  hasTarget: boolean;
  rMultiple: number | null;
};

function isPositivePrice(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function computeRiskDistance({
  price,
  stop,
  target,
  cost,
  nearThreshold = 0.03,
}: RiskDistanceInput): RiskDistanceResult {
  if (!isPositivePrice(price) || !isPositivePrice(stop)) {
    return {
      status: "unknown",
      stopDistanceRatio: null,
      targetDistanceRatio: null,
      markerPosition: null,
      hasTarget: false,
      rMultiple: null,
    };
  }

  const stopDistanceRatio = (price - stop) / price;
  const hasTarget = isPositivePrice(target) && target > stop;
  const position = hasTarget
    ? (price - stop) / (target - stop)
    : stopDistanceRatio / 0.2;
  let status: RiskDistanceStatus = "safe";
  if (price <= stop) status = "touched";
  else if (stopDistanceRatio <= nearThreshold) status = "near";

  return {
    status,
    stopDistanceRatio,
    targetDistanceRatio: hasTarget ? (target - price) / price : null,
    markerPosition: Math.max(0, Math.min(1, position)),
    hasTarget,
    rMultiple:
      isPositivePrice(cost) && cost > stop ? (price - cost) / (cost - stop) : null,
  };
}
