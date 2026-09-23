"use client";
import { useState } from "react";
import { api } from "~/trpc/react";
import { Input } from "../ui/input";
import { Checkbox } from "../ui/checkbox";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { usePanelVisible } from "../workbench/keep-alive";
import {
  Books,
  FloppyDisk,
  Table as TableIcon,
  Target,
  Timer,
  UploadSimple,
} from "@phosphor-icons/react/ssr";
import {
  changeTone,
  PageGrid,
  Panel,
  PanelEmpty,
  StatsPanel,
  toneText,
} from "../panels";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "../ui/select";
import {
  Table,
  TableHeader,
  TableHead,
  TableRow,
  TableBody,
  TableCell,
} from "../ui/table";

const pct = (value: number | null) =>
  value === null ? "—" : `${(value * 100).toFixed(2)}%`;
const directions: Record<string, string> = {
  bullish: "偏多",
  bearish: "偏空",
  neutral: "中性/混合",
  unknown: "待核对",
};
export function ClsReviewControls() {
  const visible = usePanelVisible();
  const utils = api.useUtils();
  const summary = api.clsReviewSummary.useQuery(undefined, {
    enabled: visible,
    refetchInterval: 15000,
  });
  const schedule = api.clsReviewSchedule.useQuery(undefined, {
    enabled: visible,
    refetchInterval: 10000,
  });
  const [scheduleDraft, setScheduleDraft] = useState<{
    enabled: boolean;
    directory: string;
  } | null>(null);
  const scheduleValue = scheduleDraft ??
    schedule.data?.config ?? { enabled: false, directory: "" };
  const saveSchedule = api.clsReviewSaveSchedule.useMutation({
    onSuccess: () => {
      setScheduleDraft(null);
      void utils.clsReviewSchedule.invalidate();
    },
  });
  const [path, setPath] = useState("");
  const [previewPath, setPreviewPath] = useState("");
  const [selected, setSelected] = useState("");
  const [removing, setRemoving] = useState("");
  const remove = api.clsReviewRemove.useMutation({
    onSuccess: () => {
      setSelected("");
      setRemoving("");
      void utils.clsReviewReports.invalidate();
      void utils.clsReviewSample.invalidate();
      void utils.clsReviewSummary.invalidate();
      void utils.clsReviewVerifications.invalidate();
    },
  });
  const [offset, setOffset] = useState(0);
  const [date, setDate] = useState(() =>
    new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10),
  );
  const [sectionId, setSectionId] = useState("");
  const [quote, setQuote] = useState("");
  const [evidence, setEvidence] = useState("");
  const [verdict, setVerdict] = useState<
    "supported" | "contradicted" | "unresolved"
  >("unresolved");
  const [error, setError] = useState<string | null>(null);
  const preview = api.clsReviewPreview.useQuery(previewPath, {
    enabled: !!previewPath,
    retry: false,
  });
  const reports = api.clsReviewReports.useQuery(offset);
  const report = api.clsReviewExport.useQuery(selected, {
    enabled: !!selected,
  });
  const facts = api.clsReviewFacts.useQuery(selected, { enabled: !!selected });
  const sample = api.clsReviewSample.useQuery(date, {
    enabled: /^\d{4}-\d{2}-\d{2}$/.test(date),
  });
  const verifications = api.clsReviewVerifications.useQuery(date, {
    enabled: /^\d{4}-\d{2}-\d{2}$/.test(date),
  });
  const importReport = api.clsReviewImport.useMutation({
    onSuccess: (value) => {
      setSelected(value.id);
      setSectionId("");
      void utils.clsReviewReports.invalidate();
    },
  });
  const fix = api.clsReviewFixSample.useMutation({
    onSuccess: (value) => {
      setDate(value.date);
      void utils.clsReviewSample.invalidate();
    },
  });
  const verify = api.clsReviewVerify.useMutation({
    onSuccess: () => void utils.clsReviewVerifications.invalidate(),
  });
  const saveFact = api.clsReviewSaveFact.useMutation({
    onSuccess: () => {
      setQuote("");
      setEvidence("");
      void utils.clsReviewFacts.invalidate();
    },
  });
  async function download() {
    try {
      const value = await utils.clsReviewExportAll.fetch(selected);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(value)], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `cls-review-${date}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "导出失败");
    }
  }
  const horizon = (h: number) => summary.data?.find((row) => row.horizon === h);
  return (
    <PageGrid>
      <StatsPanel
        icon={Target}
        title="累计价格方向验证"
        meta="每个样本日采用最近一次核对，待观察和缺价不进入命中率分母"
        items={[
          {
            label: "已核对样本",
            value: summary.isLoading ? "…" : (horizon(0)?.total ?? 0),
            note: `有效 ${horizon(0)?.valid ?? 0}`,
          },
          {
            label: "当日方向命中",
            value: pct(horizon(0)?.hitRate ?? null),
            note: "基准见核对明细",
          },
          {
            label: "T+1 方向命中",
            value: pct(horizon(1)?.hitRate ?? null),
            note: `待观察 ${horizon(1)?.pending ?? 0}`,
          },
          {
            label: "T+5 平均超额",
            value: pct(horizon(5)?.meanExcessReturn ?? null),
            note: `超额有效 ${horizon(5)?.excessSamples ?? 0} 条`,
            tone: changeTone(horizon(5)?.meanExcessReturn ?? null),
          },
          {
            label: "缺价 / 无样本",
            value: horizon(0)?.unavailable ?? 0,
            note: "不计入命中率",
            tone: horizon(0)?.unavailable ? "warn" : "neutral",
          },
        ]}
      >
        {summary.error ? (
          <p role="alert" className="nc-text-bad">
            {summary.error.message}
          </p>
        ) : (
          <details className="mb-0">
            <summary>分窗口明细（收益为价格观察，事实支持率另行统计）</summary>
            <Table>
              <TableHeader>
                <TableRow>
                  {[
                    "窗口",
                    "已核对样本",
                    "有效",
                    "待观察",
                    "缺价/无样本",
                    "命中率",
                    "平均超额",
                    "超额有效数",
                  ].map((heading) => (
                    <TableHead key={heading}>{heading}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.data?.map((row) => (
                  <TableRow key={row.horizon}>
                    <TableCell>
                      {row.horizon ? `T+${row.horizon}` : "当日"}
                    </TableCell>
                    <TableCell>{row.total}</TableCell>
                    <TableCell>{row.valid}</TableCell>
                    <TableCell>{row.pending}</TableCell>
                    <TableCell>{row.unavailable}</TableCell>
                    <TableCell>{pct(row.hitRate)}</TableCell>
                    <TableCell>{pct(row.meanExcessReturn)}</TableCell>
                    <TableCell>{row.excessSamples}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </details>
        )}
      </StatsPanel>
      {[
        error,
        preview.error?.message,
        reports.error?.message,
        report.error?.message,
        facts.error?.message,
        sample.error?.message,
        verifications.error?.message,
        importReport.error?.message,
        fix.error?.message,
        verify.error?.message,
        saveFact.error?.message,
      ]
        .filter(Boolean)
        .map((message, index) => (
          <p
            key={index}
            role="alert"
            className="nc-span-12 m-0 text-[12px] text-nc-bad"
          >
            {message}
          </p>
        ))}
      <Panel
        span={7}
        icon={TableIcon}
        title="样本价格复盘"
        meta={
          sample.data
            ? `固定于 ${new Date(sample.data.fixedAt).toLocaleString("zh-CN")}`
            : date
        }
        actions={
          <label className="flex items-center gap-2 text-[11px] text-nc-text-3">
            样本日期
            <Input
              type="date"
              className="w-40"
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          </label>
        }
        note="当日与 T+1/5/10 方向、基准和超额收益；未到期、停牌、缺价单列。"
      >
        {sample.data ? (
          <div className="list-row">
            <div>
              <strong>
                {sample.data.selected?.symbol ?? "无样本"} ·{" "}
                {directions[sample.data.selected?.direction ?? "unknown"]}
              </strong>
              <p>{sample.data.reason ?? sample.data.selected?.evidence}</p>
            </div>
            <Button
              size="sm"
              disabled={verify.isPending}
              onClick={() => verify.mutate(date)}
            >
              读取行情并核对
            </Button>
          </div>
        ) : (
          <PanelEmpty>该日尚无固定样本，不能事后补选。</PanelEmpty>
        )}
        {verifications.data?.[0] && (
          <>
            <p className="muted">
              最近核对：
              {new Date(verifications.data[0].checkedAt).toLocaleString(
                "zh-CN",
              )}
            </p>
            {verifications.data[0].warnings.map((warning) => (
              <p key={warning} className="muted">
                {warning}
              </p>
            ))}
            <Table>
              <TableHeader>
                <TableRow>
                  {[
                    "观察窗口",
                    "截止日期",
                    "股票收益",
                    "基准收益",
                    "超额收益",
                    "方向",
                    "说明",
                  ].map((text) => (
                    <TableHead key={text}>{text}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {verifications.data[0].outcomes.map((row) => (
                  <TableRow key={row.horizon}>
                    <TableCell>
                      {row.horizon ? `T+${row.horizon}` : "当日"}
                    </TableCell>
                    <TableCell>{row.exitDate ?? "未到期"}</TableCell>
                    <TableCell
                      className={toneText[changeTone(row.grossReturn)]}
                    >
                      {pct(row.grossReturn)}
                    </TableCell>
                    <TableCell>{pct(row.benchmarkReturn)}</TableCell>
                    <TableCell
                      className={toneText[changeTone(row.excessReturn)]}
                    >
                      {pct(row.excessReturn)}
                    </TableCell>
                    <TableCell>
                      {row.hit === null ? "—" : row.hit ? "命中" : "未命中"}
                    </TableCell>
                    <TableCell>{row.reason ?? "观察完成"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </Panel>
      <Panel
        span={5}
        icon={Timer}
        title="每日自动复盘"
        tag={scheduleValue.enabled ? "已启用" : "未启用"}
        note="08:00—09:30读取当日报告，文件停止修改一分钟后固定样本；15:05后核对已有样本。应用未运行时不会执行，不改动Windows新闻分析任务。"
        bodyClassName="space-y-3"
      >
        <label className="flex items-center gap-2 text-[12px] text-nc-text-2">
          <Checkbox
            checked={scheduleValue.enabled}
            onCheckedChange={(checked) =>
              setScheduleDraft({ ...scheduleValue, enabled: checked === true })
            }
          />
          应用运行时自动检查
        </label>
        <label className="flex flex-col gap-[5px] text-[11px] text-nc-text-3">
          报告目录
          <Input
            value={scheduleValue.directory}
            onChange={(event) =>
              setScheduleDraft({
                ...scheduleValue,
                directory: event.target.value,
              })
            }
          />
        </label>
        <Button
          disabled={saveSchedule.isPending}
          onClick={() => saveSchedule.mutate(scheduleValue)}
        >
          <FloppyDisk size={14} />
          保存调度设置
        </Button>
        {schedule.data?.lastCheck && (
          <p className="muted">
            最近检查：
            {new Date(schedule.data.lastCheck.checkedAt).toLocaleString(
              "zh-CN",
            )}{" "}
            · {schedule.data.lastCheck.message}
          </p>
        )}
        {(saveSchedule.error || schedule.error) && (
          <p role="alert" className="nc-text-bad">
            {saveSchedule.error?.message ?? schedule.error?.message}
          </p>
        )}
      </Panel>
      <Panel
        icon={UploadSimple}
        title="导入报告"
        note="只读导入现有Markdown报告。盘前样本须在当日09:30以前固定；报告日期或文件时间不能替代实际选样时间。价格方向观察与事实核对分别统计。"
      >
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (path === previewPath) void preview.refetch();
            else setPreviewPath(path);
          }}
        >
          <label className="flex min-w-64 flex-1 flex-col gap-[5px] text-[11px] text-nc-text-3">
            报告文件完整路径
            <Input
              required
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="C:\Users\…\Documents\财联社报告.md"
            />
          </label>
          <Button type="submit" disabled={preview.isFetching}>
            预览报告
          </Button>
        </form>
        {preview.data && (
          <section className="list-row mt-3 block space-y-2">
            <strong>{preview.data.report.title}</strong>
            <p>
              报告日期：{preview.data.report.reportDate ?? "未识别"} · 章节{" "}
              {preview.data.report.sections.length}
            </p>
            {preview.data.report.warnings.map((warning) => (
              <p key={warning} className="muted">
                {warning}
              </p>
            ))}
            <details>
              <summary>核对原文</summary>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-sm">
                {preview.data.report.markdown}
              </pre>
            </details>
            <Button
              size="sm"
              disabled={importReport.isPending || preview.isFetching}
              onClick={() =>
                importReport.mutate({
                  path: previewPath,
                  hash: preview.data!.report.hash,
                })
              }
            >
              导入此版本
            </Button>
          </section>
        )}
      </Panel>
      <Panel
        icon={Books}
        title="已导入报告"
        meta={`第 ${offset / 20 + 1} 页`}
        actions={
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={!offset}
              onClick={() => setOffset(Math.max(0, offset - 20))}
            >
              上一页
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={(reports.data?.length ?? 0) < 20}
              onClick={() => setOffset(offset + 20)}
            >
              下一页
            </Button>
          </>
        }
      >
        <div className="flex flex-wrap gap-2">
          {reports.isLoading ? (
            <PanelEmpty>正在读取…</PanelEmpty>
          ) : reports.data?.length ? (
            reports.data.map((item) => (
              <Button
                key={item.id}
                size="sm"
                variant={selected === item.id ? "default" : "outline"}
                className="h-auto whitespace-normal"
                onClick={() => {
                  setSelected(item.id);
                  setSectionId("");
                  setQuote("");
                  setEvidence("");
                }}
              >
                {item.report.title} · {item.report.reportDate ?? "日期待核对"} ·
                版本{item.versionNumber}
              </Button>
            ))
          ) : (
            <PanelEmpty>尚无报告</PanelEmpty>
          )}
        </div>
        {report.data && (
          <section className="mt-3 space-y-3 rounded-lg border border-nc-border-soft bg-nc-inset p-3">
            <div className="flex flex-wrap items-center gap-2">
              <strong className="mr-auto text-[13px] font-medium">
                {report.data.report.title}
              </strong>
              <span className="muted">
                导入时间：
                {new Date(report.data.importedAt).toLocaleString("zh-CN")}
              </span>
            </div>
            <div className="button-row">
              <Button
                size="sm"
                disabled={fix.isPending}
                onClick={() => fix.mutate(selected)}
              >
                用此报告固定今日盘前样本
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void download()}
              >
                导出报告与全部关联复盘
              </Button>
              <Button
                size="sm"
                variant={removing === selected ? "danger" : "outline"}
                disabled={remove.isPending}
                onClick={() =>
                  removing === selected
                    ? remove.mutate(selected)
                    : setRemoving(selected)
                }
              >
                {removing === selected
                  ? "确认清理报告及关联证据"
                  : "清理此版本"}
              </Button>
              {removing === selected && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setRemoving("")}
                >
                  保留
                </Button>
              )}
            </div>
            {remove.error && (
              <p role="alert" className="nc-text-bad">
                {remove.error.message}
              </p>
            )}
            <details>
              <summary>已保存原文</summary>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-sm">
                {report.data.report.markdown}
              </pre>
            </details>
            <h4 className="mb-1">事实核对</h4>
            <p className="m-0 text-[12px] text-nc-text-2">
              有依据支持 {facts.data?.statistics.supported ?? 0} · 被反证{" "}
              {facts.data?.statistics.contradicted ?? 0} · 待核对{" "}
              {facts.data?.statistics.unresolved ?? 0} · 已核对支持率{" "}
              {pct(facts.data?.statistics.supportRate ?? null)}
            </p>
            <form
              className="form-grid"
              onSubmit={(event) => {
                event.preventDefault();
                saveFact.mutate({
                  reportId: selected,
                  sectionId,
                  quote,
                  evidence,
                  verdict,
                });
              }}
            >
              <label>
                原文章节
                <Select value={sectionId} onValueChange={setSectionId}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择章节" />
                  </SelectTrigger>
                  <SelectContent>
                    {report.data.report.sections.map((section) => (
                      <SelectItem key={section.id} value={section.id}>
                        {section.name} · {directions[section.direction]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label>
                核对结果
                <Select
                  value={verdict}
                  onValueChange={(value) => setVerdict(value as typeof verdict)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unresolved">待核对</SelectItem>
                    <SelectItem value="supported">有依据支持</SelectItem>
                    <SelectItem value="contradicted">被反证</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <label className="col-span-full">
                事实原文摘录
                <Textarea
                  required
                  value={quote}
                  onChange={(event) => setQuote(event.target.value)}
                />
              </label>
              <label className="col-span-full">
                核对依据（公告、原始来源或无法核实的原因）
                <Textarea
                  required
                  value={evidence}
                  onChange={(event) => setEvidence(event.target.value)}
                />
              </label>
              <div className="col-span-full">
                <Button
                  type="submit"
                  disabled={!sectionId || saveFact.isPending}
                >
                  保存事实核对
                </Button>
              </div>
            </form>
            {facts.data?.rows.map((fact) => (
              <p
                key={fact.id}
                className="m-0 border-t border-nc-border-soft pt-2 text-[12px]"
              >
                {fact.quote} ·{" "}
                <span
                  className={
                    fact.verdict === "supported"
                      ? "nc-text-ok"
                      : fact.verdict === "contradicted"
                        ? "nc-text-bad"
                        : "nc-text-warn"
                  }
                >
                  {fact.verdict === "supported"
                    ? "有依据支持"
                    : fact.verdict === "contradicted"
                      ? "被反证"
                      : "待核对"}
                </span>
                ：{fact.evidence}
              </p>
            ))}
          </section>
        )}
      </Panel>
    </PageGrid>
  );
}
