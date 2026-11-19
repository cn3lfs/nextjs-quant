import { formatNumber as displayNumber } from "trading-strategy-core/format-number";
import type { EquityPoint } from "~/lib/backtest/equity-drawdown";
import {
  computeMonthlyReturnsHeatmap,
  computeTopDrawdownPeriods,
} from "~/lib/backtest/monthly-heatmap";
import { cn } from "~/lib/common/classnames";

const MONTH_LABELS = [
  "1月",
  "2月",
  "3月",
  "4月",
  "5月",
  "6月",
  "7月",
  "8月",
  "9月",
  "10月",
  "11月",
  "12月",
] as const;

/** 保留两位小数与正负号；缺失严格显示「—」，不能变成 0.00%。 */
function signedPercent(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  const percent = value * 100;
  const rounded = Math.abs(percent) < 0.005 ? 0 : percent;
  return `${rounded > 0 ? "+" : ""}${displayNumber(rounded, 2)}%`;
}

function heatTone(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "empty";
  if (value === 0) return "flat";
  return value > 0 ? "up" : "down";
}

/** 柔和热力底色：按幅度取 6%–24% 的 token 混色，绝不使用刺眼纯红/纯绿。 */
function heatStyle(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value === 0) return undefined;
  const token = value > 0 ? "--nc-up" : "--nc-down";
  const alpha = Math.min(24, 6 + Math.abs(value) * 100 * 2).toFixed(1);
  return {
    backgroundColor: `color-mix(in srgb, var(${token}) ${alpha}%, var(--nc-card))`,
  };
}

/**
 * 月度收益热力图（A 股口径：红涨绿跌）。表格横向可滚动，缺失月份显示「—」；
 * 下方列出 Top 3 最大回撤区间，未恢复的区间明确标注。
 */
export function MonthlyReturnsHeatmap({
  equity,
  initial,
  className,
}: {
  equity: readonly EquityPoint[];
  initial?: number;
  className?: string;
}) {
  const rows = computeMonthlyReturnsHeatmap(equity, initial);
  const drawdowns = computeTopDrawdownPeriods(equity, initial, 3);

  return (
    <section
      className={cn("nc-heatmap", className)}
      aria-label="月度收益热力图"
    >
      <header className="nc-heatmap-head">
        <h3 className="nc-heatmap-title">月度收益热力图</h3>
        <div className="nc-heatmap-legend">
          <span>
            <i
              className="nc-heatmap-swatch"
              data-tone="up"
              aria-hidden="true"
            />
            正收益
          </span>
          <span>
            <i
              className="nc-heatmap-swatch"
              data-tone="down"
              aria-hidden="true"
            />
            负收益
          </span>
          <span>
            <i
              className="nc-heatmap-swatch"
              data-tone="empty"
              aria-hidden="true"
            />
            — 无数据
          </span>
        </div>
      </header>

      {rows.length === 0 ? (
        <p className="nc-panel-empty">
          暂无可计算的月度收益 — 需要至少一个有效净值点。
        </p>
      ) : (
        <div className="nc-table-scroll">
          <table className="nc-heatmap-table">
            <caption className="sr-only">
              月度收益热力图：红底为正收益、绿底为负收益、— 为无数据
            </caption>
            <thead>
              <tr>
                <th scope="col">年份</th>
                {MONTH_LABELS.map((label) => (
                  <th scope="col" key={label}>
                    {label}
                  </th>
                ))}
                <th scope="col">全年</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.year}>
                  <th scope="row">{row.year}</th>
                  {row.months.map((value, index) => (
                    <td
                      key={MONTH_LABELS[index] ?? index}
                      data-tone={heatTone(value)}
                      data-empty={value == null ? "true" : undefined}
                      style={heatStyle(value)}
                    >
                      {signedPercent(value)}
                    </td>
                  ))}
                  <td
                    data-tone={heatTone(row.yearTotal)}
                    data-empty={row.yearTotal == null ? "true" : undefined}
                    style={heatStyle(row.yearTotal)}
                  >
                    {signedPercent(row.yearTotal)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {drawdowns.length > 0 && (
        <div className="nc-heatmap-drawdowns" aria-label="最大回撤区间">
          {drawdowns.map((period) => (
            <span
              className="nc-heatmap-drawdown"
              key={`${period.peakDate}-${period.troughDate}`}
            >
              最大回撤{" "}
              <b className="tabular">{displayNumber(period.depth * 100, 2)}%</b>
              <span className="tabular">
                （{period.peakDate} ~ {period.troughDate}）
              </span>
              {period.recoveryDate === null && (
                <span className="nc-heatmap-unrecovered">未恢复</span>
              )}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
