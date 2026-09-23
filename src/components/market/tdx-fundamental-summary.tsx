"use client";
import type { ReviewValue } from "~/lib/portfolio/trade-review";
import {
  compactNumber,
  fundamentalMetrics,
  statementGroups,
  tdxDate,
  unverifiedFields,
  type ReportFields,
  type SnapshotOverlay,
} from "~/lib/market/tdx-fundamentals";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";

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
  report,
  reportDate,
  sourceFilename,
  price,
  overlay,
  overlayPending,
  overlayError,
  lag,
  children,
}: {
  /** 本地财务包的报告期数据，基本面主源，不等网络。 */
  report: ReportFields;
  reportDate: string;
  sourceFilename: string;
  /** 实时价来自五档快照；不可得时市值与估值留空而不是按收盘价替代。 */
  price: number | null;
  /** 协议快照叠加的最新股本等；尚未到达时为 null，市值退回报告期末口径。 */
  overlay: SnapshotOverlay | null;
  overlayPending: boolean;
  overlayError?: string | null;
  /** 本地财务包与实时快照不同期时的提示。 */
  lag?: string | null;
  children?: React.ReactNode;
}) {
  const metrics = fundamentalMetrics({
    report,
    reportDate,
    latestShares: overlay
      ? { totalShares: overlay.totalShares, floatShares: overlay.floatShares }
      : null,
    price,
  });
  return (
    <div className="space-y-4" data-testid="tdx-fundamental-summary">
      <p className="text-xs text-muted-foreground">
        报告期 {reportDate} · 本地财务包 {sourceFilename}
        {overlay && (
          <>
            {" "}
            · 上市日期 {tdxDate(overlay.ipoDate) ?? "日期无效或缺失"} ·
            快照更新日 {tdxDate(overlay.updatedDate) ?? "日期无效或缺失"} ·
            行业码 {overlay.industry} · 地区码 {overlay.province}
          </>
        )}
      </p>
      <p className="text-xs text-muted-foreground" role="status">
        {metrics.sharesBasis === "latest"
          ? "市值与年化估值使用实时快照的最新股本；每股指标一律使用报告期末股本。"
          : overlayPending
            ? "市值暂按报告期末股本计算，实时快照到达后会换成最新股本。"
            : overlayError
              ? `实时快照读取失败：${overlayError}。市值按报告期末股本计算，增发或回购后会偏。`
              : "市值按报告期末股本计算，增发或回购后会偏。"}
      </p>
      {lag && (
        <p role="alert" className="text-xs">
          {lag}
        </p>
      )}
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
          label="资产负债率（财务包口径下界）"
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
          value={compactNumber(report.shareholders) ?? "不可得"}
        />
        <Stat
          label="户均总股本（股）"
          value={fixed(metrics.sharesPerHolder, 0)}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        报表数字全部来自本地专业财务包，报告期取自包头，读盘即得、不依赖公共服务器；
        字段下标已对 30 只标的与协议快照比对锁定。年化是「报告期累计 ×
        季度倍数」（一季 ×4、半年 ×2、三季 ×4/3、年报 ×1），
        <strong>不是 TTM</strong>
        ，也不做季节性调整。资产负债率的分子只含财务包给出的流动负债与长期负债，
        实测低于真实总负债（sz000002 为 69.5%，公开口径约
        75%），只能当下界看；没有流动负债明细的银行股整体留空而不是记 0。
        需要可核验的完整财报请走基本面分析与财务质量档案。
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
                    {compactNumber(report[field]) ?? "不可得"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </details>
      ))}
      {overlay && (
        <details>
          <summary className="cursor-pointer text-sm">
            语义未确认的协议槽位（不参与任何派生）
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
                    {compactNumber(overlay[field]) ?? "不可得"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </details>
      )}
      {children}
    </div>
  );
}
