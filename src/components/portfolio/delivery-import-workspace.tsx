"use client";
import { useEffect, useRef, useState } from "react";
import { api, type RouterInputs, type RouterOutputs } from "~/trpc/react";
import {
  emptyDeliveryDraft,
  restoreDeliveryDraft,
  type DeliveryDraft,
  type DeliveryRecovery,
} from "~/lib/portfolio/delivery-draft";
import { DeliveryMapping, DeliveryConfirm } from "./delivery-mapping";
import { Button } from "../ui/button";
import { DataTable } from "../ui/data-table";
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
  deliveryStatusText,
} from "./delivery-workspace-fields";

const sessionKey = "delivery-import-draft-v1";
type Preview = RouterOutputs["deliveryPreviewStart"];
type Row = RouterOutputs["deliveryPreviewPage"]["items"][number];
export function DeliveryImportWorkspace({
  active,
  batchChange,
  onSaved,
  onBatch,
  onReview,
}: {
  active: boolean;
  batchChange: { account: string; revision: number };
  onSaved: (account: string) => Promise<void>;
  onBatch: (id: string) => void;
  onReview: (account: string) => void;
}) {
  const utils = api.useUtils();
  const detailFocus = useRef<HTMLElement | null>(null);
  const previewFocus = useRef<HTMLElement | null>(null),
    receiptFocus = useRef<HTMLElement | null>(null),
    configFocus = useRef<HTMLDivElement | null>(null);
  const returnFocus = useRef<string | null>(null);
  const listScroll = useRef(0);
  const closeEvidence = () => {
    setSelected(null);
    requestAnimationFrame(() => {
      if (returnFocus.current)
        document
          .getElementById(returnFocus.current)
          ?.focus({ preventScroll: true });
      window.scrollTo({ top: listScroll.current });
    });
  };

  const [draft, setDraft] = useState<DeliveryDraft>(emptyDeliveryDraft),
    [directory, setDirectory] = useState("");
  const [pending, setPending] = useState<DeliveryRecovery | null>(null),
    [ready, setReady] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null),
    [receipt, setReceipt] = useState<RouterOutputs["deliveryReceipt"]>(null);
  useEffect(() => {
    const target = receipt ? receiptFocus : preview ? previewFocus : null;
    if (!target) return;
    const frame = requestAnimationFrame(() => {
      target.current?.focus({ preventScroll: true });
      target.current?.scrollIntoView({ block: "start" });
    });
    return () => cancelAnimationFrame(frame);
  }, [preview, receipt]);
  const [fileInput, setFileInput] = useState<RouterInputs["deliveryFilePage"]>({
      directory: "",
      keyword: "",
      offset: 0,
    }),
    [fileKeyword, setFileKeyword] = useState("");
  const [status, setStatus] = useState<keyof typeof deliveryStatusText>("all"),
    [keyword, setKeyword] = useState(""),
    [offset, setOffset] = useState(0),
    [selected, setSelected] = useState<Row | null>(null);
  useEffect(() => {
    if (!selected) return;
    const frame = requestAnimationFrame(() => {
      detailFocus.current?.focus({ preventScroll: true });
      if (window.innerWidth < 1280)
        detailFocus.current?.scrollIntoView({ block: "start" });
    });
    return () => cancelAnimationFrame(frame);
  }, [selected]);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [checking, setChecking] = useState(false),
    [exporting, setExporting] = useState(false);
  const revision = useRef(0),
    confirmLock = useRef(false);
  const observedChange = useRef(0);
  useEffect(() => {
    if (observedChange.current === batchChange.revision) return;
    observedChange.current = batchChange.revision;
    if (receipt?.account === batchChange.account) {
      setPending({
        account: receipt.account,
        hash: receipt.fileHash,
        source: receipt.source,
        scope: receipt.scope,
      });
      setReceipt(null);
      setNotice(
        "账户批次已变化，请重新核对收据。原收据不代表当前仍有这些记录。",
      );
    }
    if (preview?.identity.account === batchChange.account) {
      setPreview(null);
      setSelected(null);
      setNotice("账户批次已变化，请重新预览。");
    }
  }, [batchChange, receipt, preview]);
  const start = api.deliveryPreviewStart.useMutation(),
    confirm = api.deliveryPreviewConfirm.useMutation();
  useEffect(() => {
    const saved = restoreDeliveryDraft(sessionStorage.getItem(sessionKey));
    if (saved) {
      setDirectory(saved.directory);
      setDraft(saved.draft);
      setPending(saved.pending);
      if (saved.pending) setNotice("上次提交结果待核对，请先查询收据。");
    }
    setReady(true);
  }, []);
  useEffect(() => {
    if (ready)
      sessionStorage.setItem(
        sessionKey,
        JSON.stringify({ directory, draft, pending }),
      );
  }, [ready, directory, draft, pending]);
  const files = api.deliveryFilePage.useQuery(fileInput, {
    ...deliveryReadOptions,
    enabled: active && !!fileInput.directory,
  });
  const rows = api.deliveryPreviewPage.useQuery(
    {
      token: preview?.token ?? "00000000-0000-4000-8000-000000000000",
      status,
      keyword,
      offset,
    },
    {
      ...deliveryReadOptions,
      enabled: active && !!preview && !pending && !receipt,
    },
  );
  const locked = confirm.isPending || !!pending;
  const edit = (patch: Partial<DeliveryDraft>) => {
    revision.current++;
    setDraft((value) => ({ ...value, ...patch }));
    setPreview(null);
    setReceipt(null);
    setSelected(null);
    setError("");
    setNotice("");
  };
  const begin = async () => {
    if (locked || start.isPending) return;
    const current = ++revision.current;
    setError("");
    setNotice("");
    setPreview(null);
    setSelected(null);
    try {
      const value = await start.mutateAsync(draft);
      if (revision.current === current) {
        setPreview(value);
        setOffset(0);
        setStatus(
          value.summary.conflict
            ? "conflict"
            : value.summary.unresolved
              ? "unresolved"
              : "all",
        );
      }
    } catch (e) {
      if (revision.current === current)
        setError(e instanceof Error ? e.message : String(e));
    }
  };
  const acknowledge = async (
    value: NonNullable<RouterOutputs["deliveryReceipt"]>,
  ) => {
    setReceipt(value);
    setPending(null);
    setPreview(null);
    setNotice("已核对入库结果。");
    try {
      await onSaved(value.account);
    } catch {
      setNotice("已入库；列表刷新失败，请在历史批次中重新检索。");
    }
  };
  const lookup = async () => {
    if (!pending || checking) return;
    setChecking(true);
    setError("");
    try {
      const value = await utils.deliveryReceipt.fetch(
        { account: pending.account, fileHash: pending.hash },
        { staleTime: 0, gcTime: 0 },
      );
      if (value) {
        const mismatch =
          value.source !== pending.source || value.scope !== pending.scope;
        await acknowledge(value);
        if (mismatch)
          setNotice(
            "找到同文件既有批次，但来源或范围与本次配置不同。请核对实际收据，不表示新配置已保存。",
          );
      } else {
        setPending(null);
        setPreview(null);
        setNotice(
          "目前未找到批次。不能据此断定从未提交；请重新预览并核对后再导入。",
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  };
  const submit = async () => {
    if (!preview || confirmLock.current || pending || preview.summary.conflict)
      return;
    confirmLock.current = true;
    const identity: DeliveryRecovery = {
      account: preview.identity.account,
      source: preview.identity.source,
      scope: preview.identity.scope ?? "all",
      hash: preview.identity.hash,
    };
    setPending(identity);
    sessionStorage.setItem(
      sessionKey,
      JSON.stringify({ directory, draft, pending: identity }),
    );
    setError("");
    try {
      const result = await confirm.mutateAsync(preview.token);
      setNotice(
        `已入库：本次新增成交 ${result.fills} 笔、现金流 ${result.cashFlows} 笔，跳过 ${result.duplicate} 笔${result.alreadyImported ? "；文件此前已导入" : ""}。`,
      );
      const value = await utils.deliveryReceipt.fetch(
        { account: identity.account, fileHash: identity.hash },
        { staleTime: 0, gcTime: 0 },
      );
      if (value) await acknowledge(value);
      else setNotice("提交已返回成功，但当前未找到批次，请继续核对。");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setNotice("结果待核对，请查询收据；不要更换文件重复导入。");
    } finally {
      confirmLock.current = false;
    }
  };
  const exportPreview = async () => {
    if (!preview || exporting) return;
    setExporting(true);
    try {
      const value = await utils.deliveryPreviewExport.fetch(preview.token, {
        staleTime: 0,
        gcTime: 0,
      });
      downloadTradeFile(
        "交割单核对证据.json",
        "application/json",
        JSON.stringify(value, null, 2),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };
  return (
    <div className="space-y-4" aria-label="交割单导入工作区">
      <p className="text-sm">① 文件与目标 → ② 核对预览 → ③ 导入结果</p>
      <TradeError error={error} />
      {notice && (
        <p role="status" className="break-words text-sm">
          {notice}
        </p>
      )}
      {pending && (
        <div className="space-y-2 rounded border p-3">
          <p>
            待核对账户：{pending.account} · {deliveryScopeText[pending.scope]}
          </p>
          <Button
            disabled={confirm.isPending || checking}
            onClick={() => void lookup()}
          >
            {checking ? "正在核对…" : "核对提交结果"}
          </Button>
        </div>
      )}
      {receipt && (
        <section
          ref={receiptFocus}
          tabIndex={-1}
          aria-label="导入收据"
          className="space-y-2 rounded border p-3"
        >
          <h3 className="font-medium">已入库 · {receipt.fileName}</h3>
          <p>
            {receipt.account} · {deliverySourceText[receipt.source]} ·{" "}
            {deliveryScopeText[receipt.scope]}
          </p>
          <p>
            首次新增成交 {receipt.receipt?.fills ?? "历史未记录"} · 现金流{" "}
            {receipt.receipt?.cashFlows ?? "历史未记录"} · 跳过{" "}
            {receipt.receipt?.duplicate ?? "历史未记录"}
          </p>
          <p>
            当前拥有成交 {receipt.ownedFills} · 现金流 {receipt.ownedCashFlows}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => onBatch(receipt.id)}>查看该批次</Button>
            <Button variant="outline" onClick={() => onReview(receipt.account)}>
              进入该账户复盘
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                edit({});
              }}
            >
              继续导入
            </Button>
          </div>
        </section>
      )}
      {!receipt && (
        <>
          <div
            ref={configFocus}
            tabIndex={-1}
            hidden={!!preview}
            className="space-y-4"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <DeliveryField
                label="交割单目录（只读）"
                value={directory}
                disabled={locked}
                onChange={(value) => {
                  setDirectory(value);
                  setFileInput({ directory: "", keyword: "", offset: 0 });
                  edit({ path: "" });
                }}
              />
              <DeliveryField
                label="文件名关键词"
                value={fileKeyword}
                disabled={locked}
                onChange={setFileKeyword}
              />
            </div>
            <Button
              variant="outline"
              disabled={locked || !directory.trim()}
              onClick={() =>
                setFileInput({
                  directory: directory.trim(),
                  keyword: fileKeyword,
                  offset: 0,
                })
              }
            >
              检索文件
            </Button>
            <TradeError
              error={files.error?.message}
              onRetry={() => void files.refetch()}
            />
            {files.isFetching && <p role="status">正在读取目录…</p>}
            {files.data && !files.error && (
              <section aria-label="候选文件" className="space-y-2">
                <p>{files.data.count} 个匹配文件</p>
                {files.data.items.map((file) => (
                  <div
                    key={file.path}
                    className="flex flex-wrap items-center justify-between gap-2 rounded border p-2"
                  >
                    <div className="min-w-0 break-all">
                      <p>{file.name}</p>
                      <p className="text-xs">
                        {file.size ?? "未知"} 字节 ·{" "}
                        {file.modifiedAt
                          ? new Date(file.modifiedAt).toLocaleString("zh-CN")
                          : "时间未知"}
                      </p>
                      {file.error && <p>{file.error}</p>}
                    </div>
                    <Button
                      variant="outline"
                      disabled={locked || !!file.error}
                      onClick={() => edit({ path: file.path })}
                    >
                      {draft.path === file.path ? "已选择" : "选择文件"}
                    </Button>
                  </div>
                ))}
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    disabled={!fileInput.offset || files.isFetching || locked}
                    onClick={() =>
                      setFileInput((value) => ({
                        ...value,
                        offset: Math.max(0, (value.offset ?? 0) - 20),
                        version: files.data!.version,
                      }))
                    }
                  >
                    上一页文件
                  </Button>
                  <Button
                    variant="outline"
                    disabled={
                      files.data.nextOffset === null ||
                      files.isFetching ||
                      locked
                    }
                    onClick={() =>
                      setFileInput((value) => ({
                        ...value,
                        offset: files.data!.nextOffset!,
                        version: files.data!.version,
                      }))
                    }
                  >
                    下一页文件
                  </Button>
                </div>
              </section>
            )}
            <div className="grid gap-3 sm:grid-cols-3">
              <DeliveryField
                label="账户别名"
                value={draft.account}
                disabled={locked}
                onChange={(account) => edit({ account })}
              />
              <DeliverySelect
                label="来源"
                value={draft.source}
                options={deliverySourceText}
                disabled={locked}
                onChange={(source) =>
                  edit({ source: source as DeliveryDraft["source"] })
                }
              />
              <DeliverySelect
                label="导入范围"
                value={draft.scope}
                options={deliveryScopeText}
                disabled={locked}
                onChange={(scope) =>
                  edit({ scope: scope as DeliveryDraft["scope"] })
                }
              />
            </div>
            <p className="break-all text-sm">
              已选文件：{draft.path || "尚未选择"}。支持 CSV/TXT 与文本或 HTML
              形式的
              XLS；不支持二进制工作簿。请使用账户别名，勿填写真实资金账号。
            </p>
            <Button
              disabled={
                !ready ||
                locked ||
                start.isPending ||
                !draft.path ||
                !draft.account.trim()
              }
              onClick={() => void begin()}
            >
              {start.isPending ? "正在读取并解析核对…" : "预览并核对"}
            </Button>
          </div>
          {preview && !pending && (
            <section
              ref={previewFocus}
              tabIndex={-1}
              aria-label="冻结导入预览"
              className="space-y-3"
            >
              <Button
                variant="outline"
                onClick={() => {
                  edit({});
                  requestAnimationFrame(() => configFocus.current?.focus());
                }}
              >
                返回修改文件与目标
              </Button>
              <p className="break-all text-sm">文件：{preview.identity.path}</p>
              <h3 className="font-medium">
                核对：{preview.identity.account} ·{" "}
                {deliverySourceText[preview.identity.source]} ·{" "}
                {deliveryScopeText[preview.identity.scope ?? "all"]}
              </h3>
              <p>
                将写入 {preview.summary.new} 行 · 已存在{" "}
                {preview.summary.duplicate} 行 · 冲突 {preview.summary.conflict}{" "}
                行 · 待核对 {preview.summary.unresolved} 行 · 异常{" "}
                {preview.summary.anomalies} 笔（可能与前项重叠）
              </p>
              <details>
                <summary>列映射、诊断与范围统计</summary>
                <p>
                  {preview.format.toUpperCase()} · {preview.encoding}
                </p>
                <DeliveryMapping
                  mapping={preview.mapping}
                  sourceHeader={preview.sourceHeader}
                  diagnostics={preview.diagnostics}
                />
                <TradeEvidence
                  text={JSON.stringify(preview.summary.counts ?? {}, null, 2)}
                />
              </details>
              <div className="grid gap-3 sm:grid-cols-2">
                <DeliverySelect
                  label="核对状态"
                  value={status}
                  options={deliveryStatusText}
                  onChange={(value) => {
                    setStatus(value as typeof status);
                    setOffset(0);
                    setSelected(null);
                  }}
                />
                <DeliveryField
                  label="核对关键词"
                  value={keyword}
                  onChange={(value) => {
                    setKeyword(value);
                    setOffset(0);
                    setSelected(null);
                  }}
                />
              </div>
              <div
                className={
                  selected ? "grid items-start gap-4 xl:grid-cols-2" : ""
                }
              >
                <div
                  className={selected ? "hidden min-w-0 xl:block" : "min-w-0"}
                >
                  <DataTable<Row>
                    label="预览核对行"
                    columns={[
                      {
                        id: "index",
                        header: "解析后行号",
                        cell: ({ row }) => row.original.rowIndex,
                      },
                      {
                        id: "status",
                        header: "状态",
                        cell: ({ row }) =>
                          deliveryStatusText[
                            row.original
                              .status as keyof typeof deliveryStatusText
                          ] ?? row.original.status,
                      },
                      {
                        id: "value",
                        header: "内容",
                        cell: ({ row }) =>
                          row.original.value && "code" in row.original.value
                            ? row.original.value.code
                            : row.original.reason,
                      },
                      {
                        id: "detail",
                        header: "依据",
                        cell: ({ row }) => (
                          <Button
                            variant="outline"
                            size="sm"
                            id={`delivery-preview-row-${row.original.type}-${row.original.rowIndex}`}
                            onClick={(event) => {
                              returnFocus.current = event.currentTarget.id;
                              listScroll.current = window.scrollY;
                              setSelected(row.original);
                            }}
                          >
                            核对第 {row.original.rowIndex} 行
                          </Button>
                        ),
                      },
                    ]}
                    data={rows.error ? [] : (rows.data?.items ?? [])}
                    rowCount={rows.data?.count ?? 0}
                    pagination={{ pageIndex: offset / 20, pageSize: 20 }}
                    sorting={[]}
                    onPaginationChange={() => {}}
                    onSortingChange={() => {}}
                    getRowId={(row) => `${row.type}-${row.rowIndex}`}
                    showPagination={false}
                    loading={rows.isFetching}
                    error={rows.error?.message}
                    onRetry={() => void rows.refetch()}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      disabled={!offset || rows.isFetching}
                      onClick={() => {
                        setOffset(offset - 20);
                        setSelected(null);
                      }}
                    >
                      上一页核对
                    </Button>
                    <Button
                      variant="outline"
                      disabled={
                        rows.data?.nextOffset == null || rows.isFetching
                      }
                      onClick={() => {
                        setOffset(rows.data!.nextOffset!);
                        setSelected(null);
                      }}
                    >
                      下一页核对
                    </Button>
                    <Button
                      variant="outline"
                      disabled={exporting}
                      onClick={() => void exportPreview()}
                    >
                      导出完整核对证据
                    </Button>
                  </div>
                </div>
                {selected && (
                  <section
                    ref={detailFocus}
                    tabIndex={-1}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        closeEvidence();
                      }
                    }}
                    aria-label="单行证据"
                    className="min-w-0 space-y-2"
                  >
                    <Button variant="outline" onClick={closeEvidence}>
                      返回核对列表
                    </Button>
                    <TradeEvidence
                      key={`${selected.type}-${selected.rowIndex}`}
                      text={JSON.stringify(selected, null, 2)}
                    />
                  </section>
                )}
              </div>
              <p className="text-sm">
                仅写入核对后的成交与现金流；待核对行保留为证据，重复记录保留先导入版本。冲突必须处理后重新预览。
              </p>
              <DeliveryConfirm
                account={preview.identity.account}
                conflicts={preview.summary.conflict}
                busy={rows.isFetching || !!rows.error}
                onConfirm={() => void submit()}
              />
            </section>
          )}
        </>
      )}
    </div>
  );
}
