"use client";
import { useState } from "react";
import { api } from "~/trpc/react";
import type { z } from "zod";
import {
  ledgerRunsSchema,
  ledgerDecisionsSchema,
} from "~/lib/strategy-facts/signal-ledger-query";
import { tierLabels } from "~/lib/strategy-facts/notification-policy";
import { useTaskVisible } from "../workbench/use-task-visible";
import { Button } from "../ui/button";
import { ArchiveEvidence, ArchiveText } from "../research/archive-evidence";
import {
  LedgerInput,
  LedgerSelect,
  LedgerPaging,
  LedgerError,
  ledgerRunLabels,
  ledgerStrategyName,
} from "./ledger-fields";
import { SignalLedgerView, LedgerNotification } from "./signal-ledger-view";

type RunInput = z.input<typeof ledgerRunsSchema>;
type DecisionInput = z.input<typeof ledgerDecisionsSchema>;
export function LedgerHistoryPanels({ kind }: { kind: "runs" | "decisions" }) {
  return kind === "runs" ? <RunHistory /> : <DecisionHistory />;
}
function RunHistory() {
  const visible = useTaskVisible(),
    [draft, setDraft] = useState<RunInput>({}),
    [filter, setFilter] = useState<RunInput>({});
  const [pages, setPages] = useState<RunInput["cursor"][]>([undefined]),
    [selected, setSelected] = useState<string | null>(null),
    [error, setError] = useState("");
  const query = api.ledgerRuns.useQuery(
    { ...filter, cursor: pages.at(-1) },
    { enabled: visible },
  );
  const detail = api.ledgerRunDetail.useQuery(selected ?? "2000-01-01", {
    enabled: visible && !!selected,
    gcTime: 0,
    staleTime: 0,
  });
  return (
    <div className="space-y-3 text-sm">
      <form
        className="grid grid-cols-2 gap-3 md:grid-cols-4"
        onSubmit={(event) => {
          event.preventDefault();
          const result = ledgerRunsSchema.safeParse(draft);
          if (!result.success) {
            setError(result.error.issues[0]?.message ?? "无效条件");
            return;
          }
          setFilter(result.data);
          setPages([undefined]);
          setSelected(null);
          setError("");
        }}
      >
        <LedgerInput
          label="任务开始日期"
          type="date"
          value={draft.from}
          onChange={(value) => setDraft({ ...draft, from: value || undefined })}
        />
        <LedgerInput
          label="任务结束日期"
          type="date"
          value={draft.to}
          onChange={(value) => setDraft({ ...draft, to: value || undefined })}
        />
        <LedgerSelect
          label="任务状态"
          value={draft.status}
          onChange={(value) =>
            setDraft({
              ...draft,
              status: (value as RunInput["status"]) || undefined,
            })
          }
          options={[
            { value: "all", label: "全部状态" },
            ...Object.entries(ledgerRunLabels).map(([value, label]) => ({
              value,
              label,
            })),
          ]}
        />
        <Button type="submit" size="sm" className="self-end">
          查询台账任务
        </Button>
      </form>
      <LedgerError
        message={error || query.error?.message}
        stale={!!query.data}
        onRetry={() => void query.refetch()}
      />
      <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
        刷新任务历史
      </Button>
      {query.isLoading && <p>正在读取任务…</p>}
      {query.data?.total === 0 && <p>此范围没有任务记录。</p>}
      {query.data?.rows.map((run) => (
        <div
          key={run.date}
          className="flex flex-wrap items-center justify-between gap-3 rounded border border-nc-border p-2"
        >
          <span>
            {run.date} · {ledgerRunLabels[run.status]} · 已扫描{run.scanned}/
            {run.total} · 信号{run.signals}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setSelected(selected === run.date ? null : run.date)}
          >
            查看任务依据
          </Button>
        </div>
      ))}
      <LedgerPaging
        label="任务"
        page={pages.length}
        total={query.data?.total ?? 0}
        busy={query.isFetching}
        next={!!query.data?.nextCursor}
        onPrevious={() => setPages(pages.slice(0, -1))}
        onNext={() => {
          if (query.data?.nextCursor)
            setPages([...pages, query.data.nextCursor]);
        }}
      />
      {selected && (
        <section
          aria-label="任务依据"
          className="min-w-0 rounded border border-nc-border p-3"
        >
          <Button size="sm" onClick={() => setSelected(null)}>
            关闭任务依据
          </Button>
          <LedgerError
            message={detail.error?.message}
            onRetry={() => void detail.refetch()}
          />
          {detail.isLoading && <p>正在读取任务依据…</p>}
          {detail.data && (
            <>
              <SignalLedgerView rows={[]} runs={[detail.data]} />
              <ArchiveEvidence title="完整任务依据">
                {() => (
                  <ArchiveText text={JSON.stringify(detail.data, null, 2)} />
                )}
              </ArchiveEvidence>
            </>
          )}
        </section>
      )}
    </div>
  );
}
function DecisionHistory() {
  const visible = useTaskVisible(),
    [draft, setDraft] = useState<DecisionInput>({}),
    [filter, setFilter] = useState<DecisionInput>({});
  const [pages, setPages] = useState<DecisionInput["cursor"][]>([undefined]),
    [selected, setSelected] = useState<string | null>(null),
    [error, setError] = useState("");
  const query = api.ledgerDecisions.useQuery(
    { ...filter, cursor: pages.at(-1) },
    { enabled: visible },
  );
  const detail = api.ledgerDecisionDetail.useQuery(selected ?? "missing", {
    enabled: visible && !!selected,
    gcTime: 0,
    staleTime: 0,
  });
  return (
    <div className="space-y-3 text-sm">
      <p>
        包含尚未匹配台账的监控决策。投递档位不是实际发送结果；按投递编号到“信号与通知”核对。
      </p>
      <form
        className="grid grid-cols-2 gap-3 md:grid-cols-4"
        onSubmit={(event) => {
          event.preventDefault();
          const result = ledgerDecisionsSchema.safeParse(draft);
          if (!result.success) {
            setError(result.error.issues[0]?.message ?? "无效条件");
            return;
          }
          setFilter(result.data);
          setPages([undefined]);
          setSelected(null);
          setError("");
        }}
      >
        <LedgerInput
          label="决策开始日期"
          type="date"
          value={draft.from}
          onChange={(value) => setDraft({ ...draft, from: value || undefined })}
        />
        <LedgerInput
          label="决策结束日期"
          type="date"
          value={draft.to}
          onChange={(value) => setDraft({ ...draft, to: value || undefined })}
        />
        <LedgerInput
          label="决策证券代码"
          value={draft.symbol}
          onChange={(value) =>
            setDraft({ ...draft, symbol: value || undefined })
          }
        />
        <LedgerSelect
          label="投递档位"
          value={draft.tier}
          onChange={(value) =>
            setDraft({
              ...draft,
              tier: (value as DecisionInput["tier"]) || undefined,
            })
          }
          options={[
            { value: "all", label: "全部档位" },
            ...Object.entries(tierLabels).map(([value, label]) => ({
              value,
              label,
            })),
          ]}
        />
        <Button type="submit" size="sm">
          查询投递决策
        </Button>
      </form>
      <LedgerError
        message={error || query.error?.message}
        onRetry={() => void query.refetch()}
        stale={!!query.data}
      />
      <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
        刷新投递决策
      </Button>
      {query.isLoading && <p>正在读取决策…</p>}
      {query.data?.total === 0 && <p>此范围没有投递决策。</p>}
      {query.data?.rows.map((row) => (
        <div
          key={row.id}
          className="flex flex-wrap items-center justify-between gap-3 rounded border border-nc-border p-2"
        >
          <span>
            {row.date} · {row.symbol.toUpperCase()} ·{" "}
            {ledgerStrategyName(row.strategy)} · {tierLabels[row.tier]}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setSelected(selected === row.id ? null : row.id)}
          >
            查看决策依据
          </Button>
        </div>
      ))}
      <LedgerPaging
        label="决策"
        page={pages.length}
        total={query.data?.total ?? 0}
        busy={query.isFetching}
        next={!!query.data?.nextCursor}
        onPrevious={() => setPages(pages.slice(0, -1))}
        onNext={() => {
          if (query.data?.nextCursor)
            setPages([...pages, query.data.nextCursor]);
        }}
      />
      {selected && (
        <section
          aria-label="决策依据"
          className="min-w-0 rounded border border-nc-border p-3"
        >
          <Button size="sm" onClick={() => setSelected(null)}>
            关闭决策依据
          </Button>
          <LedgerError
            message={detail.error?.message}
            onRetry={() => void detail.refetch()}
          />
          {detail.isLoading && <p>正在读取决策依据…</p>}
          {detail.data && (
            <>
              <LedgerNotification decision={detail.data} />
              <ArchiveEvidence title="完整决策依据">
                {() => (
                  <ArchiveText text={JSON.stringify(detail.data, null, 2)} />
                )}
              </ArchiveEvidence>
            </>
          )}
        </section>
      )}
    </div>
  );
}
