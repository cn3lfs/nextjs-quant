import Link from "next/link";
import { signalInformation } from "~/lib/strategy-facts/signal-information";
import type { LedgerRow } from "~/lib/strategy-facts/signal-ledger";
import { SignalInformationTables } from "./signal-information-tables";
import { ChartScatter } from "@phosphor-icons/react/ssr";
import { Panel } from "../panels";

export function SignalInformationView({
  rows,
  page = 1,
}: {
  rows: readonly LedgerRow[];
  page?: number;
}) {
  const result = signalInformation(rows);
  const pageCount = Math.max(1, result.decay.length);
  const current = Math.min(pageCount, Math.max(1, Math.trunc(page) || 1));
  const selected = result.decay.slice(current - 1, current);
  const groups = result.groups.filter((g) =>
    selected.some(
      (d) => d.strategy === g.strategy && d.direction === g.direction,
    ),
  );
  return (
    <Panel
      id="signal-information"
      aria-label="信息含量"
      icon={ChartScatter}
      title="信息含量"
      bodyClassName="space-y-4 text-[12px] text-nc-text-2"
    >
      <p className="m-0">
        出处：V3 信号信息含量口径。按策略 × 方向 ×
        期限分别计算；全样本服务端计算，每页展示一个策略与方向的三个期限。非策略业绩，不作显著性判断，不拟合或外推。
      </p>
      <p>
        去重键为证券 × 观察日 × 策略，保留字典序最小
        ID（可能排除另一方向）。去重优先；其余排除计数可重叠，不能相加。未回填独立计数。分层胜率以价格上涨为胜，零收益计入分母。
      </p>
      <p>
        截面至少5条；分层默认5组，每组期望不足10条降为3组，仍不足则留空。并列整体归低组，可能产生空组。t值不修正持有期重叠与截面间相关性；三个期限的可用样本可能不同。
      </p>
      {!selected.length ? (
        <p>尚无向前信号记录，信息含量留空。</p>
      ) : (
        selected.map((d) => (
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
            <SignalInformationTables
              groups={groups.map(({ daily, ...group }) => {
                const sectionReasons: Record<string, number> = {};
                for (const section of daily)
                  if (section.reason)
                    sectionReasons[section.reason] =
                      (sectionReasons[section.reason] ?? 0) + 1;
                return { ...group, sectionReasons };
              })}
              decay={[d]}
            />
          </div>
        ))
      )}
      <nav aria-label="信息含量分页" className="flex items-center gap-4">
        {current > 1 && (
          <Link href={`?informationPage=${current - 1}#signal-information`}>
            上一页
          </Link>
        )}
        <span>
          第 {current} / {pageCount} 页
        </span>
        {current < pageCount && (
          <Link href={`?informationPage=${current + 1}#signal-information`}>
            下一页
          </Link>
        )}
      </nav>
    </Panel>
  );
}
