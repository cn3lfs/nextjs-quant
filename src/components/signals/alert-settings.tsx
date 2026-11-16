"use client";
import type { Settings } from "~/lib/domain";
import { alertModeLabels } from "~/lib/strategy-facts/alerts";
import { LedgerInput } from "./ledger-fields";
import Link from "next/link";
export function AlertSettings({
  value,
  onChange,
}: {
  value: Settings["alerts"];
  onChange: (value: Settings["alerts"]) => void;
}) {
  return (
    <section aria-label="提醒引擎设置" className="space-y-3 rounded border p-4">
      <h2>统一提醒与分仓</h2>
      <p className="text-xs text-nc-text-3">
        默认影子模式：求值并记录本应发送的提醒。开启后仅向已启用订阅投递，始终须人工交易。修改后点击上方保存设置。
      </p>
      <p>
        提醒模式：{alertModeLabels[value.mode]}。
        <Link href="/lab" className="underline">
          前往实验室核对门槛并手动切换
        </Link>
      </p>
      {value.mode === "live" && (
        <p role="status">保存后允许向已启用订阅和渠道发送提醒。</p>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        {(["cn-equity", "crypto"] as const).map((market) => (
          <LedgerInput
            key={market}
            label={`${market === "crypto" ? "数字货币资金（USDT）" : "A股资金（元）"}`}
            value={String(value.capital[market])}
            onChange={(v) =>
              onChange({
                ...value,
                capital: { ...value.capital, [market]: Number(v) },
              })
            }
          />
        ))}
      </div>
      {value.sleeves.map((s, i) => (
        <div
          key={`${s.market}:${s.id}`}
          className="flex flex-wrap items-end gap-3"
        >
          <span>
            {s.market === "crypto" ? "数字货币" : "A股"} · {s.id}
          </span>
          <LedgerInput
            label={`${s.market} ${s.id} 目标份额%`}
            value={String(s.share * 100)}
            onChange={(v) =>
              onChange({
                ...value,
                sleeves: value.sleeves.map((a, j) =>
                  j === i ? { ...a, share: Number(v) / 100 } : a,
                ),
              })
            }
          />
          <LedgerInput
            label={`${s.market} ${s.id} 单笔风险%`}
            value={String(s.risk * 100)}
            onChange={(v) =>
              onChange({
                ...value,
                sleeves: value.sleeves.map((a, j) =>
                  j === i ? { ...a, risk: Number(v) / 100 } : a,
                ),
              })
            }
          />
        </div>
      ))}
      <p className="text-xs text-nc-text-3">
        A股未启用低位配置时，闲置资金归波段仓。数量受分仓风险和剩余额度双重限制，已预留撮合费用；实际成交与滑点需核对，币种数量须有平台步长依据。
      </p>
    </section>
  );
}
