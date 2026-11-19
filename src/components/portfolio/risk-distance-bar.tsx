import { formatNumber as displayNumber } from "trading-strategy-core/format-number";
import { cn } from "~/lib/common/classnames";
import { computeRiskDistance } from "~/lib/portfolio/risk-distance";

function isPositive(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function signedRatio(value: number, digits: number) {
  const percent = value * 100;
  return `${percent > 0 ? "+" : ""}${displayNumber(percent, digits)}%`;
}

function signedR(value: number) {
  return `${value > 0 ? "+" : ""}${displayNumber(value, 2)}R`;
}

/**
 * 持仓距止损的可视化。颜色只作辅助：未知状态给出文字胶囊，正常状态同时
 * 给出「距止损 -X.X%」等文字，颜色从不单独承载语义。
 */
export function RiskDistanceBar({
  price,
  stop,
  target,
  cost,
  rMultiple,
  compact = false,
  className,
}: {
  price: number | null | undefined;
  stop: number | null | undefined;
  target?: number | null | undefined;
  cost?: number | null | undefined;
  rMultiple?: number | null | undefined;
  compact?: boolean;
  className?: string;
}) {
  const result = computeRiskDistance({ price, stop, target, cost });
  const shownR = rMultiple ?? result.rMultiple;

  if (result.status === "unknown") {
    const label = isPositive(stop) ? "待核对" : "未设止损";
    return (
      <div
        className={cn("nc-risk-distance", className)}
        data-status="unknown"
        data-compact={compact}
      >
        <span className="nc-risk-flag" data-status="unknown">
          {label}
        </span>
      </div>
    );
  }

  if (result.status === "touched") {
    return (
      <div
        className={cn("nc-risk-distance", className)}
        data-status="touched"
        data-compact={compact}
      >
        <span className="nc-risk-flag" data-status="touched">
          已触及止损
          <span className="tabular">
            {displayNumber((result.stopDistanceRatio ?? 0) * 100, 2)}%
          </span>
        </span>
      </div>
    );
  }

  const position = result.markerPosition;
  const markerPercent = Math.max(0, Math.min(1, position ?? 0)) * 100;
  const distanceValue = `-${displayNumber(
    (result.stopDistanceRatio ?? 0) * 100,
    1,
  )}%`;
  const distanceLabel = `距止损 ${distanceValue}`;
  const ariaLabel = [
    distanceLabel,
    shownR != null ? signedR(shownR) : null,
    result.targetDistanceRatio != null
      ? `目标 ${signedRatio(result.targetDistanceRatio, 1)}`
      : null,
  ]
    .filter(Boolean)
    .join("，");

  return (
    <div
      className={cn("nc-risk-distance", className)}
      data-status={result.status}
      data-compact={compact}
    >
      <div className="nc-risk-distance-head">
        <span>
          距止损 <b className="tabular">{distanceValue}</b>
        </span>
        {shownR != null && <span className="tabular">{signedR(shownR)}</span>}
        {result.targetDistanceRatio != null && (
          <span className="tabular">
            目标 {signedRatio(result.targetDistanceRatio, 1)}
          </span>
        )}
      </div>
      <div className="nc-risk-track" role="img" aria-label={ariaLabel}>
        <span className="nc-risk-zone nc-risk-zone-stop" aria-hidden="true" />
        <span className="nc-risk-zone nc-risk-zone-safe" aria-hidden="true" />
        <span
          className="nc-risk-marker"
          style={{ left: `${markerPercent.toFixed(2)}%` }}
          aria-hidden="true"
        />
      </div>
    </div>
  );
}
