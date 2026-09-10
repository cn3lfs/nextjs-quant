import {
  tierLabels,
  type DeliveryTier,
  type NotificationPolicy,
} from "~/lib/notification-policy";

export function NotificationPolicyFields({
  value: p,
  onChange,
}: {
  value: NotificationPolicy;
  onChange: (p: NotificationPolicy) => void;
}) {
  const tier = (
    label: string,
    value: DeliveryTier,
    change: (v: DeliveryTier) => void,
  ) => (
    <label>
      {label}
      <select
        value={value}
        onChange={(e) => change(e.target.value as DeliveryTier)}
      >
        {Object.entries(tierLabels).map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <fieldset>
      <legend>信号分级与静默（缠论 / 双突破）</legend>
      <p>
        只影响推送，台账记录全部信号及过滤原因。设置保存后对新决策生效；待发通知仍会核验当前静默、限额与去重。
      </p>
      <div className="form-grid">
        {tier("缠论 · 观察", p.czsc.observe, (v) =>
          onChange({ ...p, czsc: { ...p.czsc, observe: v } }),
        )}
        {tier("缠论 · 确认", p.czsc.confirmed, (v) =>
          onChange({ ...p, czsc: { ...p.czsc, confirmed: v } }),
        )}
        {tier("缠论 · 强质量", p.czsc.strong, (v) =>
          onChange({ ...p, czsc: { ...p.czsc, strong: v } }),
        )}
        <label>
          双突破高档最低分（0–5）
          <input
            type="number"
            min={0}
            max={5}
            value={p.breakout.highMin}
            onChange={(e) =>
              onChange({
                ...p,
                breakout: { ...p.breakout, highMin: Number(e.target.value) },
              })
            }
          />
        </label>
        <label>
          双突破中档最低分（低于高档）
          <input
            type="number"
            min={0}
            max={5}
            value={p.breakout.middleMin}
            onChange={(e) =>
              onChange({
                ...p,
                breakout: { ...p.breakout, middleMin: Number(e.target.value) },
              })
            }
          />
        </label>
        {tier("双突破 · 高档", p.breakout.high, (v) =>
          onChange({ ...p, breakout: { ...p.breakout, high: v } }),
        )}
        {tier("双突破 · 中档", p.breakout.middle, (v) =>
          onChange({ ...p, breakout: { ...p.breakout, middle: v } }),
        )}
        {tier("双突破 · 低档", p.breakout.low, (v) =>
          onChange({ ...p, breakout: { ...p.breakout, low: v } }),
        )}
        <label>
          每渠道每日最多消息数（含1条汇总）
          <input
            type="number"
            min={1}
            max={100}
            value={p.dailyLimit}
            onChange={(e) =>
              onChange({ ...p, dailyLimit: Number(e.target.value) })
            }
          />
        </label>
        <label>
          同标的同策略同方向去重交易日数（0关闭）
          <input
            type="number"
            min={0}
            max={60}
            value={p.dedupTradingDays}
            onChange={(e) =>
              onChange({ ...p, dedupTradingDays: Number(e.target.value) })
            }
          />
        </label>
        <label>
          收盘汇总时间（北京时间）
          <input
            type="time"
            min="15:05"
            max="23:30"
            value={p.summaryTime}
            onChange={(e) => onChange({ ...p, summaryTime: e.target.value })}
          />
        </label>
      </div>
      <label>
        <input
          type="checkbox"
          checked={p.quietOutsideTrading}
          onChange={(e) =>
            onChange({ ...p, quietOutsideTrading: e.target.checked })
          }
        />
        非交易时段静默（交易日09:30–11:30、13:00–15:00以外）
      </label>
      <label>
        <input
          type="checkbox"
          checked={p.quietEnabled}
          onChange={(e) => onChange({ ...p, quietEnabled: e.target.checked })}
        />
        启用自定义静默时段
      </label>
      <div className="form-grid">
        <label>
          静默开始
          <input
            type="time"
            disabled={!p.quietEnabled}
            value={p.quietStart}
            onChange={(e) => onChange({ ...p, quietStart: e.target.value })}
          />
        </label>
        <label>
          静默结束
          <input
            type="time"
            disabled={!p.quietEnabled}
            value={p.quietEnd}
            onChange={(e) => onChange({ ...p, quietEnd: e.target.value })}
          />
        </label>
      </div>
      <p>
        可跨午夜，开始与结束相同表示全天静默。汇总仅在设定时间起15分钟内放行非交易时段静默，仍遵守自定义静默；错过窗口或封卷后迟到只记台账，不跨日补推。日线15:05后产生，默认进入汇总。去重按每渠道的首次投递尝试计，重试不增加逻辑消息数。
      </p>
      <p>
        观察档仅为已有台账观察记录设置分级，不绕过监控引擎“仅确认/强质量”的信号生成约束。
      </p>
    </fieldset>
  );
}
