"use client";
import type { Settings } from "~/lib/domain";
import {
  alertModeLabels,
  effectiveMarketCapital,
  UNIVERSAL_DEFAULT_RISK,
} from "~/lib/strategy-facts/alerts";
import { Button } from "../ui/button";
import { LedgerInput } from "./ledger-fields";
import Link from "next/link";

const riskPresets = [
  { label: "0.5% 稳健", value: 0.005 },
  { label: "1% 标准", value: 0.01 },
  { label: "2% 进取", value: 0.02 },
] as const;

export function AlertSettings({
  value,
  onChange,
}: {
  value: Settings["alerts"];
  onChange: (value: Settings["alerts"]) => void;
}) {
  const universalRisk =
    value.sleeves.find((s) => s.share > 0)?.risk ??
    value.sleeves[0]?.risk ??
    UNIVERSAL_DEFAULT_RISK;
  // One universal risk for every strategy: rewrite each sleeve's risk but keep
  // its existing share; `universalMarketSleeve` already lets share === 0
  // sleeves share the whole market pool.
  const updateRisk = (risk: number) => {
    onChange({
      ...value,
      sleeves: value.sleeves.map((s) => ({ ...s, risk })),
    });
  };
  return (
    <section aria-label="提醒引擎设置" className="space-y-3 rounded border p-4">
      <h2>统一提醒与通用风控</h2>
      <p className="text-xs text-nc-text-3">
        默认空跑观察（只记录信号，不推送或下单）。开启正式提醒后，仅向已启用的订阅推送，交易仍须人工执行。修改后点击上方保存设置。
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
      <div className="space-y-3 rounded border border-nc-border-soft p-3">
        <h3 className="text-sm font-medium">
          通用仓位与风控体系（全策略共用）
        </h3>
        <div className="grid gap-3 lg:grid-cols-2">
          {(["cn-equity", "crypto"] as const).map((market) => (
            <LedgerInput
              key={market}
              label={
                market === "crypto" ? "数字货币资金（USDT）" : "A股资金（元）"
              }
              value={String(effectiveMarketCapital(value, market))}
              onChange={(v) =>
                onChange({
                  ...value,
                  capital: {
                    "cn-equity":
                      market === "cn-equity"
                        ? Number(v)
                        : effectiveMarketCapital(value, "cn-equity"),
                    crypto:
                      market === "crypto"
                        ? Number(v)
                        : effectiveMarketCapital(value, "crypto"),
                  },
                })
              }
            />
          ))}
        </div>
        <div className="space-y-2">
          <LedgerInput
            label="通用单笔最大风险（%）"
            value={String(universalRisk * 100)}
            onChange={(v) => updateRisk(Number(v) / 100)}
          />
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-nc-text-3">快捷预设</span>
            {riskPresets.map((preset) => (
              <Button
                key={preset.label}
                type="button"
                size="sm"
                variant="outline"
                onClick={() => updateRisk(preset.value)}
              >
                {preset.label}
              </Button>
            ))}
          </div>
        </div>
        <p className="rounded bg-nc-inset px-3 py-2 text-xs text-nc-text-2">
          所有选股方法与策略（双突破、缠论买卖点、历史低位、区间/均线/回踩公式、多周期RPS等）统一共用这套通用风控体系，无需按每个策略或分仓单独分配份额。每笔计划按「入场价
          − 止损价」与通用单笔最大风险比例自动计算建议数量（A股自动按 100
          股整手取整并预留交易税费）。
        </p>
      </div>
    </section>
  );
}
