import type { SecurityTradingStatus } from "~/lib/market/security-trading-status";
const labels = { trading: "交易", suspended: "停牌", unknown: "未核验" };
export function TradingStatusEvidence({
  value,
}: {
  value: SecurityTradingStatus | null | undefined;
}) {
  if (!value) return <p className="muted">尚无已归档的交易状态核验信息</p>;
  return (
    <details className="notice">
      <summary>
        上次状态核验：{labels[value.status]} · {value.symbol.toUpperCase()} ·{" "}
        {value.asOf ?? "状态日期未确认"}
      </summary>
      <p>{value.reason}</p>
      <p>
        来源：{value.source} · 查询时间：
        {new Date(value.fetchedAt).toLocaleString("zh-CN")}
      </p>
      <p>
        仅表示该次来源观察；新信号要求当日且 60
        秒内的核验，不能据此保证可成交或还原历史停复牌。
      </p>
      <pre>{JSON.stringify(value.evidence, null, 2)}</pre>
      <p>证据指纹：{value.evidenceHash}</p>
    </details>
  );
}
