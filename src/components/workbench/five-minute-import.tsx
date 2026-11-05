import { useEffect, useRef, useState } from "react";
import { Database } from "@phosphor-icons/react/ssr";
import { api } from "~/trpc/react";
import { Panel } from "../panels";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "../ui/table";
import { Field, ResultPager } from "./shared";
import { useSnapshotCache } from "~/lib/stores/snapshot-cache";

declare global {
  interface Window {
    quantDesktop?: { selectDirectory: () => Promise<string | null> };
  }
}

const labels: Record<string, string> = {
  previewing: "预检中",
  ready: "预检完成",
  running: "导入中",
  finished: "导入完成",
  partial: "部分导入",
  restoring: "恢复中",
  restored: "已恢复",
  "restore-partial": "部分恢复",
  interrupted: "已中断",
  preview: "待导入",
  skipped: "已跳过",
  prepared: "待核对",
  written: "已写入",
  unchanged: "无需更新",
  failed: "失败",
};

export function FiveMinuteImport({ root }: { root: string }) {
  const utils = api.useUtils();
  const invalidatedJobs = useRef(new Set<string>());
  const [directories, setDirectories] = useState("");
  const [tdxRoot, setTdxRoot] = useState(root);
  const [desktopAvailable, setDesktopAvailable] = useState(false);
  useEffect(() => setTdxRoot(root), [root]);
  useEffect(() => setDesktopAvailable(Boolean(window.quantDesktop)), []);
  const [id, setId] = useState("");
  const [activeJob, setActiveJob] = useState("");
  const [page, setPage] = useState(0);
  const [historyPage, setHistoryPage] = useState(0);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const history = api.fiveMinuteImportHistory.useQuery({ page: historyPage });
  const detail = api.fiveMinuteImport.useQuery(
    { id, page, filter },
    { enabled: !!id, retry: false },
  );
  const jobId =
    activeJob ||
    detail.data?.batch.operationJob ||
    detail.data?.batch.previewJob ||
    "";
  const job = api.jobSummary.useQuery(
    { id: jobId },
    {
      enabled: !!jobId,
      refetchInterval: (query) =>
        ["queued", "running"].includes(query.state.data?.status ?? "")
          ? 1500
          : false,
    },
  );
  const preview = api.startFiveMinuteImport.useMutation({
    onSuccess: (result) => {
      setId(result.id);
      setActiveJob(result.jobId);
      setPage(0);
      setFilter("");
      void history.refetch();
    },
    onError: (e) => setError(e.message),
  });
  const execute = api.executeFiveMinuteImport.useMutation({
    onSuccess: (result) => {
      setActiveJob(result.jobId);
      void detail.refetch();
    },
    onError: (e) => setError(e.message),
  });
  const cancel = api.cancel.useMutation({
    onSuccess: () => void job.refetch(),
    onError: (e) => setError(e.message),
  });
  const exportRows = api.exportFiveMinuteImport.useMutation({
    onSuccess: (text) => {
      const url = URL.createObjectURL(
        new Blob([text], { type: "text/csv;charset=utf-8" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `five-minute-${id}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    },
    onError: (e) => setError(e.message),
  });
  useEffect(() => {
    if (
      job.data &&
      ["completed", "failed", "cancelled"].includes(job.data.status)
    ) {
      void detail.refetch();
      void history.refetch();
    }
    // Refresh only on a change of task identity or terminal status.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.data?.id, job.data?.status]);
  useEffect(() => {
    const current = job.data;
    if (
      !current ||
      current.id !== detail.data?.batch.operationJob ||
      !["completed", "failed", "cancelled"].includes(current.status) ||
      invalidatedJobs.current.has(current.id)
    )
      return;
    invalidatedJobs.current.add(current.id);
    useSnapshotCache.getState().clearMarket();
    void utils.status.invalidate();
    void utils.securities.invalidate();
  }, [job.data, detail.data?.batch.operationJob, utils]);
  const pending =
    preview.isPending ||
    execute.isPending ||
    ["queued", "running"].includes(job.data?.status ?? "");
  const summary = detail.data?.summary;
  const changeDirectories = (value: string) => {
    setDirectories(value);
    setId("");
    setActiveJob("");
  };
  const changeRoot = (value: string) => {
    setTdxRoot(value);
    setId("");
    setActiveJob("");
  };
  const chooseDirectory = async (setPath: (path: string) => void) => {
    try {
      const path = await window.quantDesktop?.selectDirectory();
      if (path) setPath(path);
    } catch (error) {
      setError(error instanceof Error ? error.message : "选择目录失败");
    }
  };
  const start = () => {
    setError("");
    preview.mutate({
      directories: directories
        .split(/\r?\n/)
        .map((v) => v.trim())
        .filter(Boolean),
      source: "wswdz",
      tdxRoot,
    });
  };
  const action = (restore: boolean) => {
    setError("");
    if (
      !window.confirm(
        restore
          ? `请确认已关闭通达信和其他行情写入程序。恢复目标：${detail.data?.batch.root}。导入后发生变化的文件会跳过。确认恢复？`
          : `请确认已关闭通达信和其他行情写入程序，并已核对 CSV 为未复权数据。导入目标：${detail.data?.batch.root}。已有时间的冲突记录会保留原值；成交量超限置零 ${summary?.overflow ?? 0} 条。确认导入？`,
      )
    )
      return;
    execute.mutate({ id, restore });
  };
  return (
    <Panel
      title="五分钟 CSV 导入"
      icon={Database}
      span={12}
      note="直接更新五分钟行情，不创建备份。操作前关闭通达信；仅自动修复有明确来源依据的成交量，其他已有冲突保留。"
    >
      <p className="mb-2 text-nc-text-3">
        指数、国债回购保留源量；股票和 ETF
        自动核验股、份与手的换算。超过无符号32位容量（约42.95亿）时置零并列出时间。
        导入前请核对来源价格未复权；这里的通达信目录仅用于本批次，不修改终端默认设置。
      </p>
      <Field label="微盛 CSV 数据目录（可填写 samples 上级目录，或每行一个 SH/SZ 目录）">
        <Textarea
          rows={3}
          value={directories}
          disabled={pending}
          onChange={(e) => changeDirectories(e.target.value)}
          placeholder={"D:\\wsWDZ\\wdz_tool\\samples"}
        />
      </Field>
      {desktopAvailable && (
        <Button
          variant="ghost"
          disabled={pending}
          onClick={() => void chooseDirectory(changeDirectories)}
        >
          选择数据目录
        </Button>
      )}
      <Field label="通达信安装目录">
        <Input
          value={tdxRoot}
          disabled={pending}
          onChange={(e) => changeRoot(e.target.value)}
        />
      </Field>
      {desktopAvailable && (
        <Button
          variant="ghost"
          disabled={pending}
          onClick={() => void chooseDirectory(changeRoot)}
        >
          选择通达信目录
        </Button>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={pending || !directories.trim() || !tdxRoot.trim()}
          onClick={start}
        >
          开始导入
        </Button>
        {pending && jobId && (
          <Button variant="ghost" onClick={() => cancel.mutate(jobId)}>
            取消任务
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-nc-bad">
          {error}
        </p>
      )}
      {job.data && (
        <p role="status" className="my-3">
          任务：{job.data.phase ?? job.data.status} · {job.data.progress}%{" "}
          {job.data.error && `· ${job.data.error}`}
        </p>
      )}
      <Field label="批次历史">
        <Select
          value={id || "none"}
          onValueChange={(value) => {
            setId(value === "none" ? "" : value);
            setActiveJob("");
            setPage(0);
            setFilter("");
          }}
        >
          <SelectTrigger aria-label="批次历史">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">选择批次</SelectItem>
            {(history.data?.items ?? []).map((b) => (
              <SelectItem key={b.id} value={b.id}>
                {new Date(b.createdAt).toLocaleString("zh-CN")} ·{" "}
                {labels[b.status] ?? b.status} · {b.count} 文件
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {history.data && (
        <ResultPager
          page={historyPage}
          count={history.data.total}
          onChange={setHistoryPage}
        />
      )}
      {detail.error && (
        <p role="alert" className="text-nc-bad">
          {detail.error.message}
        </p>
      )}
      {detail.data && summary && (
        <>
          <p>本批次通达信目录：{detail.data.batch.root}</p>
          <p>
            批次 {id} ·{" "}
            {labels[detail.data.batch.status] ?? detail.data.batch.status} ·
            新增 {summary.added} 条，相同 {summary.identical} 条，冲突{" "}
            {summary.conflicts} 条，错误 {summary.errors} 个，跳过{" "}
            {summary.skipped} 个，新建 {summary.newFiles} 个，已写入{" "}
            {summary.written} 个；成交量超限置零 {summary.overflow} 条。
          </p>
          <div className="flex flex-wrap gap-2 mb-3">
            {!detail.data.batch.direct && (
              <Button
                variant="ghost"
                disabled={pending}
                onClick={() => action(true)}
              >
                恢复旧批次
              </Button>
            )}
            <Button variant="ghost" onClick={() => void detail.refetch()}>
              刷新结果
            </Button>
            <Button
              variant="ghost"
              disabled={exportRows.isPending}
              onClick={() => exportRows.mutate(id)}
            >
              导出明细
            </Button>
          </div>
          <Field label="明细筛选">
            <Select
              value={filter || "all"}
              onValueChange={(value) => {
                setFilter(value === "all" ? "" : value);
                setPage(0);
              }}
            >
              <SelectTrigger aria-label="明细筛选">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部</SelectItem>
                <SelectItem value="failed">有错误</SelectItem>
                <SelectItem value="skipped">跳过</SelectItem>
                <SelectItem value="conflicts">有冲突</SelectItem>
                <SelectItem value="overflow">成交量超限置零</SelectItem>
                <SelectItem value="prepared">待核对</SelectItem>
                <SelectItem value="written">已写入</SelectItem>
                <SelectItem value="restored">已恢复</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>代码</TableHead>
                  <TableHead>时间范围</TableHead>
                  <TableHead>新增/相同/冲突</TableHead>
                  <TableHead>状态及说明</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.data.items.map((item) => (
                  <TableRow key={item.symbol}>
                    <TableCell>{item.symbol}</TableCell>
                    <TableCell>
                      {item.first ?? "—"} 至 {item.last ?? "—"}
                    </TableCell>
                    <TableCell>
                      {item.added ?? 0}/{item.identical ?? 0}/
                      {item.conflicts ?? 0}
                    </TableCell>
                    <TableCell>
                      {labels[item.state] ?? item.state}{" "}
                      {item.error ?? item.restoredError ?? ""}
                      {!!item.overflowTimes?.length && (
                        <details>
                          <summary>置零 {item.overflowTimes.length} 条</summary>
                          <p>{item.overflowTimes.join("、")}</p>
                        </details>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <ResultPager
            page={page}
            count={detail.data.total}
            onChange={setPage}
          />
        </>
      )}
    </Panel>
  );
}
