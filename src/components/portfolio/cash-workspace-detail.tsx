"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "~/trpc/react";
import { Button } from "../ui/button";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
} from "../ui/table";
import { TradeError } from "./trade-workspace-fields";
import { cashReconciliationLabels } from "./cash-reconciliation-results";
import { CashPager, cashMoney, cashReadOptions } from "./cash-workspace-fields";

export type CashSelection = { version: string } & (
  { kind: "date"; date: string } | { kind: "opening" | "diagnostics" }
);
type Props = {
  account: string;
  selection: CashSelection;
  active: boolean;
  onBack: () => void;
  onBatch: (id: string) => void;
  onRefresh: () => void;
};

export function CashWorkspaceDetail(props: Props) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({
      block: window.innerWidth < 1280 ? "start" : "nearest",
    });
  }, []);
  return (
    <section
      aria-label="现金核对详情"
      className="min-w-0 scroll-mt-24 space-y-4 rounded-lg border border-border p-4"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          props.onBack();
        }
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3
          ref={heading}
          tabIndex={-1}
          className="scroll-mt-24 text-base font-semibold"
        >
          {props.selection.kind === "date"
            ? `${props.selection.date} 现金核对`
            : props.selection.kind === "opening"
              ? "期初现金依据"
              : "导入证据待核对"}
        </h3>
        <Button variant="outline" onClick={props.onBack}>
          返回日期列表
        </Button>
        <Button variant="outline" onClick={props.onRefresh}>
          刷新并保留日期
        </Button>
      </div>
      {props.selection.kind === "date" ? (
        <DateDetail {...props} date={props.selection.date} />
      ) : (
        <AdditionalEvidence {...props} kind={props.selection.kind} />
      )}
    </section>
  );
}

function DateDetail({
  account,
  selection,
  date,
  active,
  onBatch,
}: Props & { date: string }) {
  const [pageIndex, setPage] = useState(0),
    [batchId, setBatch] = useState<string | null>(null);
  const sourceReturn = useRef({ id: "", scroll: 0 });
  const query = api.cashWorkspaceDate.useQuery(
    { account, version: selection.version, date, pageIndex },
    { ...cashReadOptions, enabled: active },
  );
  const data = query.data;
  const closeSource = () => {
    setBatch(null);
    requestAnimationFrame(() => {
      document
        .getElementById(sourceReturn.current.id)
        ?.focus({ preventScroll: true });
      window.scrollTo({ top: sourceReturn.current.scroll });
    });
  };
  return (
    <>
      {query.isFetching && <p role="status">正在读取日期来源…</p>}
      <TradeError
        error={query.error?.message}
        onRetry={() => void query.refetch()}
      />
      {data && !query.error && (
        <>
          <p className="font-medium">
            {cashReconciliationLabels[data.status]} · 人民币 / 元
          </p>
          <dl className="grid grid-cols-1 gap-3 rounded bg-muted/40 p-3 text-sm sm:grid-cols-3">
            {(
              [
                ["柜台日末", data.statementCash],
                ["独立推算", data.projectedCash],
                ["柜台 − 推算", data.difference],
              ] as const
            ).map(([label, value], i) => (
              <div key={label}>
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="mt-1 text-right font-mono tabular-nums">
                  {cashMoney(value, i === 2)}
                </dd>
              </div>
            ))}
          </dl>
          <p className="text-sm">
            {data.reason ?? "日末现金相等不代表流水完整。"}
          </p>
          {batchId ? (
            <SourceRows
              key={batchId}
              account={account}
              version={selection.version}
              date={date}
              batchId={batchId}
              active={active}
              onBack={closeSource}
              onBatch={onBatch}
            />
          ) : (
            <>
              <h4 className="font-medium">
                柜台来源 · {data.sources.total} 份
              </h4>
              {!data.sources.total && (
                <p className="text-sm text-muted-foreground">
                  该日无已导入柜台余额证据，未沿用前日余额。
                </p>
              )}
              <ul className="space-y-3">
                {data.sources.rows.map((source) => (
                  <li
                    key={source.batchId}
                    className="space-y-2 rounded border border-border p-3 text-sm"
                  >
                    <p className="break-all">批次 {source.batchId}</p>
                    <p className="break-all text-muted-foreground">
                      文件摘要 {source.fileHash}
                    </p>
                    <p>
                      日末 {cashMoney(source.statementCash)} 元 ·{" "}
                      {source.rowCount} 行 ·{" "}
                      {source.order === "single-row"
                        ? "单行余额"
                        : source.order === "balance-chain"
                          ? "余额链"
                          : source.order === "timestamp-chain"
                            ? "时间与余额链"
                            : "顺序未确认"}
                    </p>
                    {source.reason && <p>{source.reason}</p>}
                    <Button
                      id={`cash-source-${source.batchId}`}
                      variant="outline"
                      size="sm"
                      onClick={(event) => {
                        sourceReturn.current = {
                          id: event.currentTarget.id,
                          scroll: window.scrollY,
                        };
                        setBatch(source.batchId);
                      }}
                    >
                      查看逐行证据
                    </Button>
                  </li>
                ))}
              </ul>
              <CashPager
                label="柜台来源分页"
                page={data.sources}
                onPage={setPage}
                busy={query.isFetching}
              />
            </>
          )}
        </>
      )}
    </>
  );
}

function SourceRows({
  account,
  version,
  date,
  batchId,
  active,
  onBack,
  onBatch,
}: {
  account: string;
  version: string;
  date: string;
  batchId: string;
  active: boolean;
  onBack: () => void;
  onBatch: (id: string) => void;
}) {
  const [pageIndex, setPage] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: "nearest" });
  }, []);
  const query = api.cashWorkspaceRows.useQuery(
    { account, version, date, batchId, pageIndex },
    { ...cashReadOptions, enabled: active },
  );
  return (
    <section
      aria-label="结构化余额证据"
      className="space-y-3"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onBack();
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h4 ref={heading} tabIndex={-1} className="font-medium">
          逐行余额证据
        </h4>
        <Button variant="outline" size="sm" onClick={onBack}>
          返回来源列表
        </Button>
      </div>
      {query.isFetching && <p role="status">正在读取逐行证据…</p>}
      <TradeError
        error={query.error?.message}
        onRetry={() => void query.refetch()}
      />
      {query.data && !query.error && (
        <>
          <p className="break-all text-sm">
            批次 {batchId} · 文件摘要 {query.data.source.fileHash}
          </p>
          <p className="text-sm">
            期初 {cashMoney(query.data.source.openingCash)}{" "}
            元；余额链只证明收尾，不证明真实盘中时序。
          </p>
          <Button
            id={`cash-batch-${batchId}`}
            variant="outline"
            onClick={() => onBatch(batchId)}
          >
            打开交割单批次
          </Button>
          <div className="overflow-x-auto">
            <Table className="w-full text-sm">
              <TableCaption className="sr-only">
                结构化余额证据，金额单位元
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead className="p-2 text-left">原始行</TableHead>
                  <TableHead className="p-2 text-left">时间</TableHead>
                  <TableHead className="p-2 text-right">发生额（元）</TableHead>
                  <TableHead className="p-2 text-right">余额（元）</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.rows.map((row) => (
                  <TableRow
                    key={row.rowIndex}
                    className="border-t border-border"
                  >
                    <TableCell className="p-2">{row.rowIndex}</TableCell>
                    <TableCell className="p-2">{row.time ?? "未知"}</TableCell>
                    <TableCell className="p-2 text-right tabular-nums">
                      {cashMoney(row.netAmount, true)}
                    </TableCell>
                    <TableCell className="p-2 text-right tabular-nums">
                      {cashMoney(row.balanceCash)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <CashPager
            label="逐行证据分页"
            page={query.data}
            onPage={setPage}
            busy={query.isFetching}
          />
        </>
      )}
    </section>
  );
}

function AdditionalEvidence({
  account,
  selection,
  kind,
  active,
  onBatch,
}: Props & { kind: "opening" | "diagnostics" }) {
  const [pageIndex, setPage] = useState(0);
  const input = { account, version: selection.version, pageIndex };
  const opening = api.cashWorkspaceOpening.useQuery(input, {
    ...cashReadOptions,
    enabled: active && kind === "opening",
  });
  const diagnostics = api.cashWorkspaceDiagnostics.useQuery(input, {
    ...cashReadOptions,
    enabled: active && kind === "diagnostics",
  });
  const query = kind === "opening" ? opening : diagnostics;
  return (
    <>
      {query.isFetching && (
        <p role="status">正在读取{kind === "opening" ? "期初依据" : "诊断"}…</p>
      )}
      <TradeError
        error={query.error?.message}
        onRetry={() => void query.refetch()}
      />
      {!query.error && (
        <>
          {kind === "opening" && opening.data && (
            <>
              <p>
                推算起点 {opening.data.date ?? "未知"} ·{" "}
                {cashMoney(opening.data.cash)} 元
              </p>
              <ul className="space-y-3">
                {opening.data.rows.map((row, index) => (
                  <li
                    key={`${row.batchId}:${index}`}
                    className="space-y-1 rounded border border-border p-3 text-sm"
                  >
                    <p>
                      批次起点 {row.date ?? "未知"} · 期初{" "}
                      {cashMoney(row.value)} 元 · 差额{" "}
                      {cashMoney(row.difference, true)} 元
                    </p>
                    <p>{row.reason ?? "同日起点比较"}</p>
                    <p className="break-all">文件摘要 {row.fileHash}</p>
                    <Button
                      id={`cash-opening-${row.batchId}`}
                      className="h-auto max-w-full whitespace-normal break-all py-2 text-left"
                      variant="outline"
                      size="sm"
                      onClick={() => onBatch(row.batchId)}
                    >
                      打开批次 {row.batchId}
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {kind === "diagnostics" && diagnostics.data && (
            <ul className="space-y-3">
              {diagnostics.data.rows.map((row, index) => (
                <li
                  key={`${row.batchId}:${index}`}
                  className="space-y-1 rounded border border-border p-3 text-sm"
                >
                  <p>
                    原始行 {row.rowIndex ?? "未知"} · {row.reason}
                  </p>
                  <Button
                    id={`cash-diagnostic-${row.batchId}-${index}`}
                    className="h-auto max-w-full whitespace-normal break-all py-2 text-left"
                    variant="outline"
                    size="sm"
                    onClick={() => onBatch(row.batchId)}
                  >
                    打开批次 {row.batchId}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {query.data && (
            <>
              {!query.data.total && (
                <p className="text-sm text-muted-foreground">
                  {kind === "opening"
                    ? "未保留可用的批次期初余额证据。"
                    : "没有待核对诊断。"}
                </p>
              )}
              <CashPager
                label={kind === "opening" ? "期初依据分页" : "诊断分页"}
                page={query.data}
                onPage={setPage}
                busy={query.isFetching}
              />
            </>
          )}
        </>
      )}
    </>
  );
}
