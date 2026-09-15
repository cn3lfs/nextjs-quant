"use client";
import type { ReviewValue } from "~/lib/trade-review";
import {
  compactNumber,
  fundamentalMetrics,
  statementGroups,
  unverifiedFields,
  type FinanceSnapshot,
} from "~/lib/tdx-fundamentals";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table";

const missing = (metric: ReviewValue) =>
  `不可得：${metric.reason ?? "证据不足"}`;
const fixed = (metric: ReviewValue, digits = 2) =>
  metric.value === null ? missing(metric) : metric.value.toFixed(digits);
const ratio = (metric: ReviewValue) =>
  metric.value === null
    ? missing(metric)
    : `${(metric.value * 100).toFixed(2)}%`;
const amount = (metric: ReviewValue) =>
  metric.value === null
    ? missing(metric)
    : (compactNumber(metric.value) ?? missing(metric));

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm tabular-nums">{value}</span>
    </div>
  );
}

export function TdxFundamentalSummary({
  finance,
  price,
  period,
  periodReason,
}: {
  finance: FinanceSnapshot;
  /** 实时价来自五档快照；不可得时市值与估值一律留空而不是按收盘价替代。 */
  price: number | null;
  /** 由本地财务包反查的报告期；协议快照本身不含报告期。 */
  period: { reportDate: string; sourceFilename: string } | null;
  periodReason?: string | null;
}) {
  const metrics = fundamentalMetrics(
    finance,
    price,
    period?.reportDate ?? null,
  );
  return (
    <div className="space-y-4" data-testid="tdx-fundamental-summary">
      <p className="text-xs text-muted-foreground">
        报告期 {metrics.reportDate ?? "未确定"}
        {period
          ? `（本地财务包 ${period.sourceFilename} 反查）`
          : `（${periodReason ?? "无法判定"}，因此不给出任何年化口径）`}{" "}
        · 快照更新日 {metrics.snapshotDate ?? "日期无效或缺失"} · 上市日期{" "}
        {metrics.ipoDate ?? "日期无效或缺失"} · 通达信内部行业码{" "}
        {finance.industry} · 地区码 {finance.province}（编码未映射名称）
      </p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Stat label="总市值（元）" value={amount(metrics.marketCap)} />
        <Stat label="流通市值（元）" value={amount(metrics.floatMarketCap)} />
        <Stat label="流通占比" value={ratio(metrics.floatRatio)} />
        <Stat label="市净率 PB" value={fixed(metrics.priceToBook)} />
        <Stat label="年化市盈率" value={fixed(metrics.annualizedPe)} />
        <Stat label="年化市销率" value={fixed(metrics.priceToSales)} />
        <Stat
          label="每股净资产（元/股）"
          value={fixed(metrics.bookValuePerShare, 3)}
        />
        <Stat
          label="每股收益（报告期累计，元）"
          value={fixed(metrics.reportedEps, 4)}
        />
        <Stat
          label="年化每股收益（元）"
          value={fixed(metrics.annualizedEps, 4)}
        />
        <Stat label="报告期净资产收益率" value={ratio(metrics.reportedRoe)} />
        <Stat label="报告期净利率" value={ratio(metrics.netMargin)} />
        <Stat
          label="资产负债率（协议口径下界）"
          value={ratio(metrics.debtRatio)}
        />
        <Stat
          label="每股资本公积（元）"
          value={fixed(metrics.reservePerShare, 4)}
        />
        <Stat
          label="每股未分配利润（元）"
          value={fixed(metrics.undistributedPerShare, 4)}
        />
        <Stat
          label="股东户数（户）"
          value={compactNumber(finance.shareholders) ?? "不可得"}
        />
        <Stat
          label="户均流通股（股）"
          value={fixed(metrics.sharesPerHolder, 0)}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        金额口径已与本地专业财务包 <code>gpcw*.dat</code>{" "}
        逐字段核对：协议值为千元，换算成元后在四只标的上完全吻合；报告期由同一批财务包反查，
        命中不唯一时留空。年化是「报告期累计 × 季度倍数」（一季 ×4、半年
        ×2、三季 ×4/3、年报 ×1），
        <strong>不是 TTM</strong>
        ，也不做季节性调整。资产负债率的分子只含协议给出的流动负债与长期负债，实测低于真实总负债
        （sz000002 为 69.5%，公开口径约
        75%），只能当下界看；协议不给流动负债的银行股整体留空而不是记
        0。需要可核验的完整财报请走基本面分析与财务质量档案。
      </p>
      {statementGroups.map((group) => (
        <details key={group.title}>
          <summary className="cursor-pointer text-sm">
            {group.title}（单位：元）
          </summary>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>项目</TableHead>
                <TableHead className="text-right">金额（元）</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {group.fields.map(([field, label]) => (
                <TableRow key={field}>
                  <TableCell>{label}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {compactNumber(finance[field]) ?? "不可得"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </details>
      ))}
      <details>
        <summary className="cursor-pointer text-sm">
          语义未确认的协议字段（不参与任何派生）
        </summary>
        <p className="text-xs text-muted-foreground">
          这些槽位已被复用或错位：sh600519 的法人股大于总股本、sz000002
          的发起人股为负、职工股槽位的值实际等于每股收益，在财务包里任何倍率下都找不到对应值。
          因此只按协议原值列出，<strong>不换算单位、不当作股本使用</strong>。
        </p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>槽位</TableHead>
              <TableHead className="text-right">协议原值</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {unverifiedFields.map(([field, label]) => (
              <TableRow key={field}>
                <TableCell>{label}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {compactNumber(finance[field]) ?? "不可得"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </details>
    </div>
  );
}
