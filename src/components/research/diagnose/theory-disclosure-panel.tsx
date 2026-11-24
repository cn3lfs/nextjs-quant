"use client";

import { useState, type ReactNode } from "react";
import type {
  DiagnoseArchiveSummary,
  DiagnoseCounts,
  DiagnoseGrowthPitDisclosure,
  DiagnoseNativeChanDisclosure,
  DiagnoseScenarioCellGroup,
  DiagnoseWyckoffFunnel,
} from "~/lib/research/diagnose-contract";
import { Pill } from "../../panels";
import { Button } from "../../ui/button";
import { formatCount, formatMs, formatPercent } from "./format";

function DisclosureSection({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2 rounded-lg border border-nc-border-soft bg-nc-inset px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h4 className="text-sm font-semibold text-nc-text">{title}</h4>
        {meta}
      </div>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-sub text-nc-text-3">{label}</dt>
      <dd className="break-all text-nc-text tabular-nums">{children}</dd>
    </div>
  );
}

function FunnelSteps({
  steps,
}: {
  steps: { label: string; value: number | null | undefined }[];
}) {
  return (
    <ol className="flex flex-wrap items-center gap-1.5 text-sm">
      {steps.map((step, index) => (
        <li key={step.label} className="flex items-center gap-1.5">
          {index > 0 && (
            <span aria-hidden="true" className="text-nc-text-4">
              →
            </span>
          )}
          <span className="rounded border border-nc-border-soft bg-nc-card px-2 py-0.5">
            <span className="text-nc-text-3">{step.label}</span>{" "}
            <strong className="tabular-nums">{formatCount(step.value)}</strong>
          </span>
        </li>
      ))}
    </ol>
  );
}

function NativeChanCard({ entry }: { entry: DiagnoseNativeChanDisclosure }) {
  const hash = entry.dllHash ?? entry.identity.dllHash;
  const [copyStatus, setCopyStatus] = useState("");
  async function copyHash() {
    try {
      await navigator.clipboard.writeText(hash);
      setCopyStatus("已复制");
    } catch {
      setCopyStatus("复制失败，可查看完整指纹");
    }
  }
  return (
    <div className="rounded-lg border border-nc-border-soft bg-nc-card px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <strong className="text-sm text-nc-text">{entry.symbol}</strong>
        <Pill tone={entry.cached ? "ok" : "neutral"}>
          {entry.cached ? "缓存命中" : "未命中缓存"}
        </Pill>
        {entry.mode && (
          <Pill tone="neutral">
            {entry.mode === "current-dll-compute"
              ? "当前 DLL 计算"
              : "冻结回放"}
          </Pill>
        )}
        {entry.captureMetricsAvailable === false && (
          <span className="text-sub text-nc-warn">抓取耗时不可用</span>
        )}
      </div>
      <dl className="mt-2 grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <Field label="DLL 指纹">
          <Button
            type="button"
            variant="plain"
            size="sm"
            className="h-auto min-h-0 px-0 py-0 font-mono text-sub underline"
            title={hash}
            onClick={() => void copyHash()}
          >
            {hash.length > 16 ? `${hash.slice(0, 16)}…` : hash}（复制）
          </Button>
          {copyStatus && (
            <span role="status" className="ml-2 text-sub text-nc-text-3">
              {copyStatus}
            </span>
          )}
        </Field>
        <Field label="API 版本">{formatCount(entry.identity.apiVersion)}</Field>
        <Field label="构建提交">
          <span className="font-mono text-sub">
            {entry.identity.buildCommit || "—"}
          </span>
        </Field>
        <Field label="配置 ID">
          <span className="font-mono text-sub">
            {entry.identity.configId || "—"}
          </span>
        </Field>
        <Field label="配置 / 锚点">
          {formatCount(entry.identity.config)} /{" "}
          {formatCount(entry.identity.anchor)}
        </Field>
        <Field label="投影版本">{formatCount(entry.projectionVersion)}</Field>
        <Field label="originDate">{entry.originDate}</Field>
        <Field label="baselineDate">{entry.baselineDate}</Field>
        <Field label="firstIndex">{formatCount(entry.firstIndex)}</Field>
        <Field label="前缀数量">{formatCount(entry.prefixCount)}</Field>
        <Field label="抓取耗时">
          {formatMs(
            entry.captureMetricsAvailable === false
              ? undefined
              : entry.captureElapsedMs,
          )}
        </Field>
        <Field label="缓存加载">{formatMs(entry.cacheLoadMs)}</Field>
        <Field label="审计 / 待定">
          {formatCount(entry.auditCount)} / {formatCount(entry.pendingCount)}
        </Field>
        <Field label="信号价格基">{entry.signalPriceBasis ?? "—"}</Field>
      </dl>
    </div>
  );
}

function PitCard({
  entry,
  counts,
  portfolio,
}: {
  entry: DiagnoseGrowthPitDisclosure;
  counts?: DiagnoseCounts;
  portfolio: boolean;
}) {
  const range = entry.reportDateRange
    ? `${entry.reportDateRange[0]} 至 ${entry.reportDateRange[1]}`
    : "—";
  return (
    <div className="space-y-2 rounded-lg border border-nc-border-soft bg-nc-card px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <strong className="text-sm text-nc-text">{entry.symbol}</strong>
        <Pill tone="neutral">PIT 财务披露</Pill>
        <span className="text-sub text-nc-text-3">
          严格报告 {formatCount(entry.strictReportCount)} · {range}
        </span>
      </div>

      <FunnelSteps
        steps={[
          {
            label: "价格候选",
            value: entry.funnel?.priceSignals ?? entry.priceSignalCount,
          },
          { label: "趋势/VCP", value: entry.funnel?.trendVcpSignals },
          { label: "PIT 财务过滤", value: entry.funnel?.pitFinanceSignals },
          { label: "M 大盘制度", value: entry.funnel?.marketRegimeSignals },
          ...(!portfolio
            ? [
                { label: "委托", value: counts?.orders },
                { label: "成交", value: counts?.fills },
              ]
            : []),
        ]}
      />

      <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <Field label="合格 / 缺失 / 冲突日">
          {formatCount(entry.qualifiedDays)} / {formatCount(entry.missingDays)}{" "}
          / {formatCount(entry.conflictDays)}
        </Field>
        <Field label="价格信号">{formatCount(entry.priceSignalCount)}</Field>
        <Field label="经 PIT 过滤信号">
          {formatCount(entry.pitFilteredSignalCount)}
        </Field>
        <Field label="来源问题">{formatCount(entry.sourceIssuesCount)}</Field>
        {entry.exitSuppressedEntrySignals !== undefined && (
          <Field label="退出抑制的入场信号">
            {formatCount(entry.exitSuppressedEntrySignals)}
          </Field>
        )}
        {entry.marketRegime && (
          <Field label="大盘制度（允许/阻断/未知日）">
            {formatCount(entry.marketRegime.allowedDays)} /{" "}
            {formatCount(entry.marketRegime.blockedDays)} /{" "}
            {formatCount(entry.marketRegime.unknownDays)}
          </Field>
        )}
      </dl>

      {entry.sepaPit && (
        <div className="rounded border border-nc-border-soft px-2 py-1.5">
          <p className="text-sub font-medium text-nc-text">SEPA PIT 覆盖</p>
          <dl className="mt-1 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <Field label="严格报告">
              {formatCount(entry.sepaPit.strictReportCount)}
            </Field>
            <Field label="严格 / 容忍通过日">
              {formatCount(entry.sepaPit.strictPassDays)} /{" "}
              {formatCount(entry.sepaPit.tolerantPassDays)}
            </Field>
            <Field label="不完整 / 失败日">
              {formatCount(entry.sepaPit.incompleteDays)} /{" "}
              {formatCount(entry.sepaPit.failedDays)}
            </Field>
            <Field label="报告区间">
              {entry.sepaPit.reportDateRange
                ? `${entry.sepaPit.reportDateRange[0]} 至 ${entry.sepaPit.reportDateRange[1]}`
                : "—"}
            </Field>
          </dl>
          <p className="mt-1 text-sub text-nc-text-3">
            {entry.sepaPit.boundary}
          </p>
        </div>
      )}

      {entry.checkCoverage && Object.keys(entry.checkCoverage).length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] text-sm">
            <caption className="sr-only">CANSLIM / SEPA 门槛覆盖</caption>
            <thead>
              <tr className="border-b border-nc-border-soft text-left text-sub text-nc-text-3">
                <th scope="col" className="py-1 pr-2 font-medium">
                  门槛
                </th>
                <th scope="col" className="py-1 pr-2 font-medium">
                  已计算
                </th>
                <th scope="col" className="py-1 pr-2 font-medium">
                  缺失
                </th>
                <th scope="col" className="py-1 pr-2 font-medium">
                  冲突
                </th>
                <th scope="col" className="py-1 pr-2 font-medium">
                  通过
                </th>
                <th scope="col" className="py-1 font-medium">
                  边际通过率
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-nc-border-soft">
              {Object.entries(entry.checkCoverage).map(([gate, row]) => (
                <tr key={gate}>
                  <th
                    scope="row"
                    className="py-1 pr-2 text-left font-normal text-nc-text"
                  >
                    {gate}
                  </th>
                  <td className="py-1 pr-2 tabular-nums">
                    {formatCount(row.computed)}
                  </td>
                  <td className="py-1 pr-2 tabular-nums">
                    {formatCount(row.missing)}
                  </td>
                  <td className="py-1 pr-2 tabular-nums">
                    {formatCount(row.conflict)}
                  </td>
                  <td className="py-1 pr-2 tabular-nums">
                    {formatCount(row.passed)}
                  </td>
                  <td className="py-1 tabular-nums">
                    {row.marginalPassRate === null
                      ? "—"
                      : formatPercent(row.marginalPassRate)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-sub text-nc-text-3">
        仅使用满足 availableFrom &lt;= date
        的财报。公告当日不可见，报告期仅用于标记财报所属周期。
      </p>
      <p className="text-sub text-nc-text-4">{entry.boundary}</p>

      {entry.duplicateIssues && entry.duplicateIssues.length > 0 && (
        <div
          role="alert"
          className="rounded border border-nc-border-soft bg-nc-inset px-2 py-1.5"
        >
          <p className="text-sub font-medium text-nc-down">
            重复记录披露（同一报告期多条记录，已排除或标记）
          </p>
          <ul className="mt-1 space-y-0.5 text-sub text-nc-text-3">
            {entry.duplicateIssues.map((issue, index) => (
              <li
                key={`${issue.file ?? "issue"}-${index}`}
                className="break-all"
              >
                {[issue.file, issue.code ?? issue.symbol, issue.reportDate]
                  .filter(Boolean)
                  .join(" · ")}
                {issue.recordOffsets?.length
                  ? ` · 记录偏移 ${issue.recordOffsets.join(", ")}`
                  : ""}
                {" — "}
                {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function WyckoffCard({ entry }: { entry: DiagnoseWyckoffFunnel }) {
  return (
    <div className="space-y-2 rounded-lg border border-nc-border-soft bg-nc-card px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <strong className="text-sm text-nc-text">{entry.symbol}</strong>
        <Pill tone="neutral">Wyckoff 漏斗</Pill>
      </div>
      <FunnelSteps
        steps={[
          { label: "父级事件", value: entry.parentEvents },
          { label: "回调收缩", value: entry.pullbackShrinkage },
          { label: "候选", value: entry.candidates },
          { label: "次日量能确认", value: entry.nextDayVolumeConfirm },
          { label: "入场信号", value: entry.entrySignals },
        ]}
      />
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
        <Field label="父级确认">{formatCount(entry.parentConfirmations)}</Field>
        <Field label="跨日带入候选">
          {formatCount(entry.carryInCandidates)}
        </Field>
        <Field label="买入委托 / 成交">
          {formatCount(entry.buyOrders)} / {formatCount(entry.buyFills)}
        </Field>
      </dl>
      {entry.nextDayBreakdown && (
        <div className="space-y-1.5 rounded border border-nc-border-soft px-2 py-1.5">
          <p className="text-sub font-medium text-nc-text">
            次日确认四条件独立计数
          </p>
          <FunnelSteps
            steps={[
              {
                label: "守住候选低点",
                value: entry.nextDayBreakdown.holdCandidateLow,
              },
              {
                label: "收盘破高",
                value: entry.nextDayBreakdown.closeAboveCandidateHigh,
              },
              {
                label: "≥1.5×均量",
                value: entry.nextDayBreakdown.volumeGe15xMean20,
              },
              {
                label: "无阻断原因",
                value: entry.nextDayBreakdown.validNextBarNoReason,
              },
              {
                label: "全满足",
                value: entry.nextDayBreakdown.allFourConfirmed,
              },
            ]}
          />
          <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
            <Field label="有次日K线的候选">
              {formatCount(entry.nextDayBreakdown.candidatesWithNextBar)}
            </Field>
            <Field label="守住低点且收盘破高">
              {formatCount(entry.nextDayBreakdown.holdAndCloseAboveHigh)}
            </Field>
            <Field label="1.0× 均量对照">
              {formatCount(entry.nextDayBreakdown.volumeGe10xMean20)}
            </Field>
          </dl>
        </div>
      )}
      <p className="text-sub text-nc-text-3">{entry.boundary}</p>
    </div>
  );
}

function PoolDisclosure({
  pool,
}: {
  pool: NonNullable<DiagnoseArchiveSummary["pool"]>;
}) {
  return (
    <DisclosureSection
      title={`证券池 · ${pool.label}`}
      meta={
        <span className="text-sub text-nc-text-3">
          {pool.id} · {formatCount(pool.symbolCount)} 个标的
        </span>
      }
    >
      <p className="text-sm text-nc-text-3">{pool.survivorBiasDisclosure}</p>
      {pool.members && pool.members.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-nc-text-3">
            查看池成员（{pool.members.length}）
          </summary>
          <ul className="mt-1 grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
            {pool.members.map((member) => (
              <li key={member.symbol} className="text-sub text-nc-text-3">
                <span className="text-nc-text">{member.symbol}</span>{" "}
                {member.name} · {member.board} · {member.group} · {member.role}
              </li>
            ))}
          </ul>
        </details>
      )}
    </DisclosureSection>
  );
}

/**
 * Theory disclosures for native Chan, CANSLIM/SEPA PIT, Wyckoff and the pool.
 * Every section is opt-in: absent data renders nothing rather than a fake zero.
 */
export function TheoryDisclosurePanel({
  nativeChan,
  canslimPit,
  growthPit,
  wyckoffFunnel,
  pool,
  counts,
  mode,
}: {
  nativeChan?: readonly DiagnoseNativeChanDisclosure[];
  canslimPit?: readonly DiagnoseGrowthPitDisclosure[];
  growthPit?: readonly DiagnoseGrowthPitDisclosure[];
  wyckoffFunnel?: readonly DiagnoseWyckoffFunnel[];
  pool?: DiagnoseArchiveSummary["pool"];
  counts?: DiagnoseCounts;
  mode?: DiagnoseScenarioCellGroup["mode"];
}) {
  const pitBySymbol = new Map<string, DiagnoseGrowthPitDisclosure>();
  for (const entry of [...(growthPit ?? []), ...(canslimPit ?? [])])
    if (!pitBySymbol.has(entry.symbol)) pitBySymbol.set(entry.symbol, entry);
  const pit = [...pitBySymbol.values()];
  const chan = nativeChan ?? [];
  const wyckoff = wyckoffFunnel ?? [];
  if (!chan.length && !pit.length && !wyckoff.length && !pool) return null;
  return (
    <section aria-label="理论口径披露" className="space-y-2">
      <h4 className="text-sm font-semibold text-nc-text">理论口径披露</h4>

      {chan.length > 0 && (
        <DisclosureSection
          title="原生缠论 · DLL 身份与抓取口径"
          meta={
            <span className="text-sub text-nc-text-3">
              逐标的冻结回放；指纹变化时历史归档不可直接互比。
            </span>
          }
        >
          <div className="space-y-2">
            {chan.map((entry) => (
              <NativeChanCard
                key={`${entry.symbol}-${entry.originDate}`}
                entry={entry}
              />
            ))}
          </div>
        </DisclosureSection>
      )}

      {pit.length > 0 && (
        <DisclosureSection
          title="CANSLIM / SEPA · PIT 财务口径"
          meta={
            <span className="text-sub text-nc-text-3">
              严格 PIT：只用当时已公告的财报；公告日边界见各标的说明。
            </span>
          }
        >
          <div className="space-y-2">
            {pit.map((entry) => (
              <PitCard
                key={entry.symbol}
                entry={entry}
                counts={counts}
                portfolio={mode === "portfolio"}
              />
            ))}
          </div>
          {mode === "portfolio" && (
            <div className="space-y-1">
              <p className="text-sub text-nc-text-3">组合执行合计</p>
              <FunnelSteps
                steps={[
                  { label: "委托", value: counts?.orders },
                  { label: "成交", value: counts?.fills },
                ]}
              />
            </div>
          )}
        </DisclosureSection>
      )}

      {wyckoff.length > 0 && (
        <DisclosureSection
          title="Wyckoff · 事件漏斗"
          meta={
            <span className="text-sub text-nc-text-3">
              父级事件 → 回调收缩 → 次日量能确认 → 入场信号。
            </span>
          }
        >
          <div className="space-y-2">
            {wyckoff.map((entry) => (
              <WyckoffCard key={entry.symbol} entry={entry} />
            ))}
          </div>
        </DisclosureSection>
      )}

      {pool && <PoolDisclosure pool={pool} />}
    </section>
  );
}
