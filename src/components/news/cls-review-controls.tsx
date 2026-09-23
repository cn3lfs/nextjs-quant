"use client";
import { useState } from "react";
import { api } from "~/trpc/react";
import { Input } from "../ui/input";
import { Checkbox } from "../ui/checkbox";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { usePanelVisible } from "../workbench/keep-alive";
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
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h2 className="font-semibold">累计价格方向验证</h2>
        <p className="text-sm text-muted-foreground">
          每个样本日采用最近一次核对，待观察和缺价不进入命中率分母。收益为价格观察，事实支持率另行统计。
        </p>
        {summary.isLoading ? (
          <p>正在读取统计…</p>
        ) : summary.error ? (
          <p role="alert">{summary.error.message}</p>
        ) : (
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
        )}
      </section>
      <section className="space-y-3 rounded-lg border p-4">
        <h2 className="font-semibold">每日自动复盘</h2>
        <label className="flex items-center gap-2">
          <Checkbox
            checked={scheduleValue.enabled}
            onCheckedChange={(checked) =>
              setScheduleDraft({ ...scheduleValue, enabled: checked === true })
            }
          />
          应用运行时自动检查
        </label>
        <label className="block">
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
        <p className="text-sm text-muted-foreground">
          08:00—09:30读取当日报告，文件停止修改一分钟后固定样本；15:05后核对已有样本。应用未运行时不会执行，不改动Windows新闻分析任务。
        </p>
        <Button
          disabled={saveSchedule.isPending}
          onClick={() => saveSchedule.mutate(scheduleValue)}
        >
          保存调度设置
        </Button>
        {schedule.data?.lastCheck && (
          <p>
            最近检查：
            {new Date(schedule.data.lastCheck.checkedAt).toLocaleString(
              "zh-CN",
            )}{" "}
            · {schedule.data.lastCheck.message}
          </p>
        )}
        {(saveSchedule.error || schedule.error) && (
          <p role="alert">
            {saveSchedule.error?.message ?? schedule.error?.message}
          </p>
        )}
      </section>
      <p className="text-sm text-muted-foreground">
        只读导入现有Markdown报告。盘前样本须在当日09:30以前固定；报告日期或文件时间不能替代实际选样时间。价格方向观察与事实核对分别统计。
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (path === previewPath) void preview.refetch();
          else setPreviewPath(path);
        }}
      >
        <label className="min-w-64 flex-1">
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
        <section className="space-y-2 rounded-lg border p-4">
          <h2 className="font-semibold">{preview.data.report.title}</h2>
          <p>
            报告日期：{preview.data.report.reportDate ?? "未识别"} · 章节{" "}
            {preview.data.report.sections.length}
          </p>
          {preview.data.report.warnings.map((warning) => (
            <p key={warning} className="text-sm text-muted-foreground">
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
          <p key={index} role="alert" className="text-destructive">
            {message}
          </p>
        ))}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">已导入报告</h2>
        {reports.isLoading ? (
          <p>正在读取…</p>
        ) : reports.data?.length ? (
          reports.data.map((item) => (
            <Button
              key={item.id}
              variant={selected === item.id ? "default" : "outline"}
              className="mr-2 h-auto whitespace-normal"
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
          <p>尚无报告</p>
        )}
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={!offset}
            onClick={() => setOffset(Math.max(0, offset - 20))}
          >
            上一页
          </Button>
          <Button
            variant="outline"
            disabled={(reports.data?.length ?? 0) < 20}
            onClick={() => setOffset(offset + 20)}
          >
            下一页
          </Button>
        </div>
      </section>
      {report.data && (
        <section className="space-y-3 rounded-lg border p-4">
          <h2 className="font-semibold">{report.data.report.title}</h2>
          <p>
            导入时间：{new Date(report.data.importedAt).toLocaleString("zh-CN")}
          </p>
          <Button disabled={fix.isPending} onClick={() => fix.mutate(selected)}>
            用此报告固定今日盘前样本
          </Button>
          <Button
            className="ml-2"
            variant="outline"
            onClick={() => void download()}
          >
            导出报告与全部关联复盘
          </Button>
          <Button
            variant="outline"
            className="ml-2"
            disabled={remove.isPending}
            onClick={() =>
              removing === selected
                ? remove.mutate(selected)
                : setRemoving(selected)
            }
          >
            {removing === selected ? "确认清理报告及关联证据" : "清理此版本"}
          </Button>
          {removing === selected && (
            <Button variant="ghost" onClick={() => setRemoving("")}>
              保留
            </Button>
          )}
          {remove.error && <p role="alert">{remove.error.message}</p>}
          <details>
            <summary>已保存原文</summary>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-sm">
              {report.data.report.markdown}
            </pre>
          </details>
          <h3 className="font-semibold">事实核对</h3>
          <p className="text-sm">
            有依据支持 {facts.data?.statistics.supported ?? 0} · 被反证{" "}
            {facts.data?.statistics.contradicted ?? 0} · 待核对{" "}
            {facts.data?.statistics.unresolved ?? 0} · 已核对支持率{" "}
            {pct(facts.data?.statistics.supportRate ?? null)}
          </p>
          <form
            className="space-y-3"
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
                <SelectTrigger>
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
            <label className="block">
              事实原文摘录
              <Textarea
                required
                value={quote}
                onChange={(event) => setQuote(event.target.value)}
              />
            </label>
            <label className="block">
              核对依据（公告、原始来源或无法核实的原因）
              <Textarea
                required
                value={evidence}
                onChange={(event) => setEvidence(event.target.value)}
              />
            </label>
            <label>
              核对结果
              <Select
                value={verdict}
                onValueChange={(value) => setVerdict(value as typeof verdict)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="unresolved">待核对</SelectItem>
                  <SelectItem value="supported">有依据支持</SelectItem>
                  <SelectItem value="contradicted">被反证</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <Button type="submit" disabled={!sectionId || saveFact.isPending}>
              保存事实核对
            </Button>
          </form>
          {facts.data?.rows.map((fact) => (
            <p key={fact.id} className="border-t pt-2 text-sm">
              {fact.quote} ·{" "}
              {fact.verdict === "supported"
                ? "有依据支持"
                : fact.verdict === "contradicted"
                  ? "被反证"
                  : "待核对"}
              ：{fact.evidence}
            </p>
          ))}
        </section>
      )}
      <section className="space-y-3 rounded-lg border p-4">
        <h2 className="text-lg font-semibold">样本价格复盘</h2>
        <label>
          样本日期
          <Input
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </label>
        {sample.data ? (
          <>
            <p>
              固定时间：{new Date(sample.data.fixedAt).toLocaleString("zh-CN")}{" "}
              · 股票：{sample.data.selected?.symbol ?? "无样本"} ·{" "}
              {directions[sample.data.selected?.direction ?? "unknown"]}
            </p>
            <p>{sample.data.reason ?? sample.data.selected?.evidence}</p>
            <Button
              disabled={verify.isPending}
              onClick={() => verify.mutate(date)}
            >
              读取行情并核对
            </Button>
          </>
        ) : (
          <p>该日尚无固定样本，不能事后补选。</p>
        )}
        {verifications.data?.[0] && (
          <>
            <p>
              最近核对：
              {new Date(verifications.data[0].checkedAt).toLocaleString(
                "zh-CN",
              )}
            </p>
            {verifications.data[0].warnings.map((warning) => (
              <p key={warning} className="text-sm text-muted-foreground">
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
                    <TableCell>{pct(row.grossReturn)}</TableCell>
                    <TableCell>{pct(row.benchmarkReturn)}</TableCell>
                    <TableCell>{pct(row.excessReturn)}</TableCell>
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
      </section>
    </div>
  );
}
