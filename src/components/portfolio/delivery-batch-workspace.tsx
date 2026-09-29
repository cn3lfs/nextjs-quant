"use client";
import { useEffect, useRef, useState } from "react";
import { api, type RouterInputs, type RouterOutputs } from "~/trpc/react";
import { Button } from "../ui/button";
import { DeliveryMapping } from "./delivery-mapping";
import { DataTable } from "../ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../ui/dialog";
import {
  TradeError,
  TradeEvidence,
  downloadTradeFile,
} from "./trade-workspace-fields";
import {
  DeliveryField,
  DeliverySelect,
  deliveryReadOptions,
  deliverySourceText,
  deliveryScopeText,
} from "./delivery-workspace-fields";
type Batch = RouterOutputs["deliveryBatchPage"]["items"][number];
type Detail = NonNullable<RouterOutputs["deliveryBatchDetail"]>;
export function DeliveryBatchWorkspace({
  active,
  initialId,
  openRevision,
  onSaved,
}: {
  active: boolean;
  initialId: string | null;
  openRevision: number;
  onSaved: (account: string) => Promise<void>;
}) {
  const utils = api.useUtils();
  const detailFocus = useRef<HTMLElement | null>(null),
    listFocus = useRef<HTMLDivElement | null>(null);
  const returnFocus = useRef<string | null>(null),
    listScroll = useRef(0);
  const closeDetail = () => {
    setId(null);
    requestAnimationFrame(() => {
      (returnFocus.current
        ? document.getElementById(returnFocus.current)
        : listFocus.current
      )?.focus({
        preventScroll: true,
      });
      window.scrollTo({ top: listScroll.current });
    });
  };
  const [account, setAccount] = useState(""),
    [source, setSource] = useState("all"),
    [keyword, setKeyword] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  const [filter, setFilter] = useState<RouterInputs["deliveryBatchPage"]>({});
  const [position, setPosition] = useState<{
    offset: number;
    version?: string;
  }>({ offset: 0 });
  const [id, setId] = useState<string | null>(initialId),
    [confirm, setConfirm] = useState<Detail | null>(null);
  const [section, setSection] = useState<
      "rawRows" | "unresolved" | "diagnostics"
    >("rawRows"),
    [offset, setOffset] = useState(0);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [exporting, setExporting] = useState(false);
  useEffect(() => {
    if (initialId) {
      setId(initialId);
      setOffset(0);
    }
  }, [initialId, openRevision]);
  useEffect(() => {
    if (!id) return;
    const frame = requestAnimationFrame(() => {
      detailFocus.current?.focus({ preventScroll: true });
      if (window.innerWidth < 1280)
        detailFocus.current?.scrollIntoView({ block: "start" });
    });
    return () => cancelAnimationFrame(frame);
  }, [id, openRevision]);
  const page = api.deliveryBatchPage.useQuery(
    { ...filter, ...position },
    { ...deliveryReadOptions, enabled: active },
  );
  const detail = api.deliveryBatchDetail.useQuery(id ?? "missing", {
    ...deliveryReadOptions,
    enabled: active && !!id,
  });
  const evidence = api.deliveryEvidencePage.useQuery(
    { id: id ?? "missing", section, offset },
    {
      ...deliveryReadOptions,
      enabled: active && !!id && !!detail.data && !detail.error,
    },
  );
  const revoke = api.deliveryRevokeChecked.useMutation();
  const apply = () => {
    setFilter({
      account: account.trim() || undefined,
      source: source === "all" ? undefined : (source as Batch["source"]),
      keyword,
      from: from ? new Date(`${from}T00:00:00+08:00`).getTime() : undefined,
      to: to ? new Date(`${to}T23:59:59.999+08:00`).getTime() : undefined,
    });
    setPosition({ offset: 0 });
    setId(null);
    setError("");
  };
  const refreshPage = async () => {
    setPosition({ offset: page.data?.offset ?? position.offset });
    await utils.deliveryBatchPage.invalidate();
    if (id) {
      await detail.refetch();
      await evidence.refetch();
    }
  };
  const exportBatch = async () => {
    if (!id || exporting) return;
    setExporting(true);
    setError("");
    try {
      const value = await utils.deliveryBatchExport.fetch(id, {
        staleTime: 0,
        gcTime: 0,
      });
      if (!value) throw new Error("批次不存在或已撤销");
      downloadTradeFile(
        `交割单批次-${id}.json`,
        "application/json",
        JSON.stringify(value, null, 2),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };
  const openConfirm = async () => {
    if (!id) return;
    setError("");
    try {
      const value = await utils.deliveryBatchDetail.fetch(id, {
        staleTime: 0,
        gcTime: 0,
      });
      if (!value) throw new Error("批次不存在或已撤销");
      setConfirm(value);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const remove = async () => {
    if (!confirm || revoke.isPending) return;
    setError("");
    try {
      const result = await revoke.mutateAsync(confirm);
      const affectedAccount = confirm.account;
      setConfirm(null);
      setId(null);
      setNotice(
        result.batches
          ? `撤销完成：实际删除成交 ${result.fills} 笔、现金流 ${result.cashFlows} 笔。`
          : "批次已不存在，未再删除任何记录。",
      );
      setPosition({ offset: page.data?.offset ?? position.offset });
      await utils.deliveryBatchDetail.invalidate(confirm.id);
      await utils.deliveryEvidencePage.invalidate();
      try {
        await utils.deliveryBatchPage.invalidate();
        await onSaved(affectedAccount);
      } catch {
        setNotice("撤销已完成，列表刷新失败，请重新检索。");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="space-y-4" aria-label="批次核对工作区">
      <TradeError error={error} />
      {notice && <p role="status">{notice}</p>}
      <div className="grid gap-3 sm:grid-cols-3">
        <DeliveryField label="批次账户" value={account} onChange={setAccount} />
        <DeliverySelect
          label="批次来源"
          value={source}
          options={{ all: "全部来源", ...deliverySourceText }}
          onChange={setSource}
        />
        <DeliveryField
          label="批次文件名"
          value={keyword}
          onChange={setKeyword}
        />
        <DeliveryField
          label="导入起始日期"
          value={from}
          onChange={setFrom}
          type="date"
        />
        <DeliveryField
          label="导入结束日期"
          value={to}
          onChange={setTo}
          type="date"
        />
      </div>
      <div className="flex gap-2">
        <Button onClick={apply}>检索批次</Button>
        <Button
          variant="outline"
          onClick={() => {
            void refreshPage();
          }}
        >
          刷新批次
        </Button>
      </div>
      <div className={id ? "grid items-start gap-4 xl:grid-cols-2" : ""}>
        <div
          ref={listFocus}
          tabIndex={-1}
          className={id ? "hidden min-w-0 xl:block" : "min-w-0"}
        >
          <DataTable<Batch>
            label="历史导入批次"
            data={page.error ? [] : (page.data?.items ?? [])}
            columns={[
              {
                id: "file",
                header: "文件与账户",
                cell: ({ row }) => (
                  <div className="break-all">
                    <p>{row.original.fileName}</p>
                    <p className="text-xs">
                      {row.original.account} ·{" "}
                      {deliverySourceText[row.original.source]} ·{" "}
                      {new Date(row.original.importedAt).toLocaleString(
                        "zh-CN",
                      )}
                    </p>
                  </div>
                ),
              },
              {
                id: "counts",
                header: "当前拥有",
                cell: ({ row }) =>
                  `成交 ${row.original.ownedFills} / 现金流 ${row.original.ownedCashFlows}`,
              },
              {
                id: "open",
                header: "核对",
                cell: ({ row }) => (
                  <Button
                    size="sm"
                    variant="outline"
                    id={`delivery-batch-${row.original.id}`}
                    onClick={(event) => {
                      returnFocus.current = event.currentTarget.id;
                      listScroll.current = window.scrollY;
                      setId(row.original.id);
                      setOffset(0);
                    }}
                  >
                    查看批次 {row.original.fileName}
                  </Button>
                ),
              },
            ]}
            rowCount={page.data?.count ?? 0}
            pagination={{
              pageIndex: (page.data?.offset ?? position.offset) / 20,
              pageSize: 20,
            }}
            sorting={[]}
            onSortingChange={() => {}}
            onPaginationChange={() => {}}
            showPagination={false}
            getRowId={(row) => row.id}
            loading={page.isFetching}
            error={page.error?.message}
            onRetry={() => {
              void refreshPage();
            }}
          />
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={!page.data?.offset || page.isFetching}
              onClick={() =>
                setPosition({
                  offset: Math.max(0, (page.data?.offset ?? 0) - 20),
                  version: page.data?.version,
                })
              }
            >
              上一页批次
            </Button>
            <span>
              第 {(page.data?.offset ?? position.offset) / 20 + 1} 页 ·{" "}
              {page.data?.count ?? 0} 批
            </span>
            <Button
              variant="outline"
              disabled={
                !page.data?.nextCursor || page.isFetching || !!page.error
              }
              onClick={() =>
                setPosition({
                  offset: page.data!.offset + 20,
                  version: page.data!.version,
                })
              }
            >
              下一页批次
            </Button>
          </div>
        </div>
        {id && (
          <section
            aria-label="批次证据详情"
            ref={detailFocus}
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !confirm) {
                event.preventDefault();
                closeDetail();
              }
            }}
            className="min-w-0 space-y-3 rounded border p-3"
          >
            <Button variant="outline" onClick={closeDetail}>
              返回批次列表
            </Button>
            <TradeError
              error={detail.error?.message}
              onRetry={() => void detail.refetch()}
            />
            {detail.isFetching && <p role="status">正在读取批次…</p>}
            {detail.data === null && <p>批次不存在或已撤销。</p>}
            {detail.data && !detail.error && (
              <>
                <h3 className="break-all font-medium">
                  {detail.data.fileName} · {detail.data.account}
                </h3>
                <p>
                  {deliverySourceText[detail.data.source]} ·{" "}
                  {deliveryScopeText[detail.data.scope]}
                </p>
                <p>
                  文件识别：成交 {detail.data.statistics.fills} / 现金流{" "}
                  {detail.data.statistics.cashFlows}；当前拥有：成交{" "}
                  {detail.data.ownedFills} / 现金流 {detail.data.ownedCashFlows}
                </p>
                <p>
                  首次新增成交 {detail.data.receipt?.fills ?? "历史未记录"} ·
                  现金流 {detail.data.receipt?.cashFlows ?? "历史未记录"} · 跳过{" "}
                  {detail.data.receipt?.duplicate ?? "历史未记录"}
                </p>
                <details>
                  <summary>文件指纹、映射与统计</summary>
                  <p>
                    {detail.data.format ?? "历史未记录格式"} ·{" "}
                    {detail.data.encoding ?? "历史未记录编码"}
                  </p>
                  {detail.data.mapping && (
                    <DeliveryMapping
                      mapping={detail.data.mapping}
                      sourceHeader={detail.data.sourceHeader}
                    />
                  )}
                  <TradeEvidence
                    text={JSON.stringify(
                      {
                        hash: detail.data.fileHash,
                        mapping: detail.data.mapping,
                        counts: detail.data.counts,
                        statementOpeningCash: detail.data.statementOpeningCash,
                      },
                      null,
                      2,
                    )}
                  />
                </details>
                <DeliverySelect
                  label="证据类别"
                  value={section}
                  options={{
                    rawRows: "脱敏原始行",
                    unresolved: "待核对行",
                    diagnostics: "诊断信息",
                  }}
                  onChange={(value) => {
                    setSection(value as typeof section);
                    setOffset(0);
                  }}
                />
                <TradeError
                  error={evidence.error?.message}
                  onRetry={() => void evidence.refetch()}
                />
                {evidence.isFetching && <p role="status">正在读取证据…</p>}
                {evidence.data && !evidence.error && (
                  <>
                    <p>
                      从第 {offset + 1} 条开始，本页{" "}
                      {evidence.data.items.length} 条；完整证据可导出。
                    </p>
                    <TradeEvidence
                      key={`${id}-${section}-${offset}`}
                      text={JSON.stringify(evidence.data.items, null, 2)}
                    />
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        disabled={!offset || evidence.isFetching}
                        onClick={() => setOffset(offset - 20)}
                      >
                        上一页证据
                      </Button>
                      <Button
                        variant="outline"
                        disabled={
                          evidence.data.nextOffset === null ||
                          evidence.isFetching
                        }
                        onClick={() => setOffset(evidence.data!.nextOffset!)}
                      >
                        下一页证据
                      </Button>
                    </div>
                  </>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    disabled={exporting}
                    onClick={() => void exportBatch()}
                  >
                    导出本批完整 JSON
                  </Button>
                  <Button
                    id="delivery-revoke-impact"
                    variant="outline"
                    disabled={revoke.isPending}
                    onClick={() => void openConfirm()}
                  >
                    核对撤销影响
                  </Button>
                </div>
              </>
            )}
          </section>
        )}
      </div>
      <Dialog
        open={!!confirm}
        onOpenChange={(open) => {
          if (!open && !revoke.isPending) setConfirm(null);
        }}
      >
        <DialogContent
          showCloseButton={!revoke.isPending}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const trigger = document.getElementById("delivery-revoke-impact");
            (trigger ?? listFocus.current)?.focus({ preventScroll: true });
          }}
        >
          <DialogTitle>确认撤销导入批次</DialogTitle>
          <DialogDescription>
            {confirm?.fileName} · {confirm?.account}。将删除当前拥有的成交{" "}
            {confirm?.ownedFills} 笔、现金流 {confirm?.ownedCashFlows}{" "}
            笔及本批证据。其它批次保留，但曾因重复跳过的记录不会自动补回，账户复盘将变化。需要保留依据时请先导出。
          </DialogDescription>
          <TradeError error={error} />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={revoke.isPending || exporting}
              onClick={() => void exportBatch()}
            >
              先导出本批证据
            </Button>
            <Button
              variant="outline"
              disabled={revoke.isPending}
              onClick={() => setConfirm(null)}
            >
              取消
            </Button>
            <Button disabled={revoke.isPending} onClick={() => void remove()}>
              {revoke.isPending ? "正在撤销…" : "确认撤销"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
