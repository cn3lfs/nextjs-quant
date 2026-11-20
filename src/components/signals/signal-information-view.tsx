"use client";
import { signalInformation } from "~/lib/strategy-facts/signal-information";
import type { LedgerRow } from "~/lib/strategy-facts/signal-ledger";
import {
  SignalInformationTables,
  type SignalInformationDisplay,
} from "./signal-information-tables";
import { Button } from "../ui/button";
import {
  useInfiniteSlice,
  useIntersectionLoadMore,
} from "../ui/use-infinite-table";
import { ChartScatter } from "@phosphor-icons/react/ssr";
import { Panel } from "../panels";

export function SignalInformationView({
  rows = [],
  computed,
}: {
  rows?: readonly LedgerRow[];
  page?: number;
  computed?: SignalInformationDisplay;
  onPageChange?: (page: number) => void;
}) {
  // The live ledger supplies the server's full-population summary. Retain the
  // pure row renderer for fixed-sample callers without duplicating disclosure UI.
  const calculated = computed ? undefined : signalInformation(rows);
  const result = computed ?? {
    decay: calculated!.decay,
    groups: calculated!.groups.map(({ daily, ...group }) => {
      const sectionReasons: Record<string, number> = {};
      for (const section of daily)
        if (section.reason)
          sectionReasons[section.reason] =
            (sectionReasons[section.reason] ?? 0) + 1;
      return { ...group, sectionReasons };
    }),
  };
  const slice = useInfiniteSlice(result.decay, 2);
  const sentinel = useIntersectionLoadMore({
    enabled: slice.hasMore,
    loading: false,
    onLoadMore: slice.onLoadMore,
  });
  return (
    <Panel
      id="signal-information"
      aria-label="信息含量"
      icon={ChartScatter}
      title="信息含量"
      bodyClassName="min-w-0 space-y-4 overflow-x-auto text-[12px] text-nc-text-2"
    >
      <p className="m-0">
        出处：V3 信号信息含量口径。按策略 × 方向 ×
        期限分别计算；全样本服务端计算，非策略业绩，不作显著性判断，不拟合或外推。
      </p>
      <p>
        去重键为证券 × 观察日 × 策略，保留字典序最小
        ID（可能排除另一方向）。去重优先；其余排除计数可重叠，不能相加。未回填独立计数。分层胜率以价格上涨为胜，零收益计入分母。
      </p>
      <p>
        截面至少5条；分层默认5组，每组期望不足10条降为3组，仍不足则留空。并列整体归低组，可能产生空组。t值不修正持有期重叠与截面间相关性；三个期限的可用样本可能不同。
      </p>
      {!slice.rows.length ? (
        <p>尚无向前信号记录，信息含量留空。</p>
      ) : (
        slice.rows.map((d) => {
          const groups = result.groups.filter(
            (g) => g.strategy === d.strategy && g.direction === d.direction,
          );
          return (
            <div key={`${d.strategy}:${d.direction}`} className="space-y-4">
              <h3>
                {d.strategy === "czsc" ? "缠论" : "双突破"} ·{" "}
                {d.direction === "long" ? "向上" : "向下"}
              </h3>
              {d.direction === "short" && (
                <p>
                  价格变化方向，不是做空收益。空头评分越高、价格跌幅越大时，IC
                  为负。
                </p>
              )}
              <SignalInformationTables groups={groups} decay={[d]} />
            </div>
          );
        })
      )}
      <div ref={sentinel} aria-hidden="true" className="h-px" />
      {result.decay.length > 0 && (
        <div className="flex items-center gap-3 text-xs text-nc-text-3">
          <span>
            已加载 {slice.rows.length} / {result.decay.length} 组
          </span>
          {slice.hasMore && (
            <Button size="sm" variant="outline" onClick={slice.onLoadMore}>
              加载更多
            </Button>
          )}
        </div>
      )}
    </Panel>
  );
}
