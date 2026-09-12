"use client";

import type { RouterOutputs } from "~/trpc/react";
import {
  trackingDecayThreshold,
  trackingDecayWarning,
} from "~/lib/three-segment-sample";
import { PerformanceSegmentTable } from "./period-performance-results";

export function ThreeSegmentResults({
  data,
}: {
  data: RouterOutputs["strategyResearchSegments"];
}) {
  const warning = trackingDecayWarning(data.segments[0]!, data.tracking);
  return (
    <section className="space-y-3" aria-label="三段样本治理">
      <h3 className="font-semibold">三段样本治理</h3>
      <p>
        系统推导跟踪起点：{data.trackingStart ?? "不存在"}。{data.reason}
      </p>
      <p className="text-sm text-muted-foreground">
        前向来源：台账 {data.evidence?.sources.ledgerDate ?? "无"}；盘中观察{" "}
        {data.evidence?.sources.previewDate ?? "无"}。策略版本：
        {data.evidence?.strategyVersion ?? "不可确定"}。
      </p>
      <p className="text-sm text-muted-foreground">
        下表按前向观察日期切分原模拟日收益，沿用原资金路径；不是前向成交业绩，不证明持有期、费用、证券池等参数在上线前已冻结。原始两段结果保留在下方。复利，年化因子{" "}
        {data.segments[0]?.yearlyDays}，wbt 夏普 rf=0。
      </p>
      <PerformanceSegmentTable
        rows={data.segments.map((segment) => ({
          ...segment,
          window: segment.partition,
          requestedTradingDays: segment.tradingDays,
          truncated: false,
          insufficientSample: segment.coverage.availableDays < 5,
        }))}
      />
      <p className="text-sm text-muted-foreground">
        衰减提示阈值：年化收益或 IR 相对开发段下降超过{" "}
        {trackingDecayThreshold * 100}
        %；只在开发段相应基线为正且两段可得时提示。IR 复用 U8
        默认参数对各段的归一化超额计算，不产生判定、不驱动操作。
      </p>
      <p className="text-sm text-muted-foreground">
        开发段 IR：
        {data.segments[0]?.informationRatio.value?.toFixed(4) ?? "不可得"}
        ；跟踪段 IR：
        {data.tracking?.informationRatio.value?.toFixed(4) ?? "不可得"}。
      </p>
      {data.tracking && !data.tracking.tradingDays && (
        <p>跟踪起点之后尚无快照内交易日，第三段指标不可得。</p>
      )}
      {warning && (
        <p role="status" className="text-destructive">
          {warning}
        </p>
      )}
    </section>
  );
}
