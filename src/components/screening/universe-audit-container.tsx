"use client";
import { useState } from "react";
import { api } from "~/trpc/react";
import {
  universeAuditLabels,
  universeBiasWarning,
  type UniverseAuditMetric,
  type UniverseAuditSource,
} from "~/lib/screening/universe-audit";
import { historicalDateSchema } from "~/lib/screening/historical-screen";
import { UniverseAuditResults } from "./universe-audit-results";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

export function UniverseAuditContainer({
  source,
  start = "",
  end = "",
}: {
  source: UniverseAuditSource;
  start?: string;
  end?: string;
}) {
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState({ start, end });
  const [metric, setMetric] = useState<UniverseAuditMetric>("total");
  const [page, setPage] = useState(0);
  const valid =
    historicalDateSchema.safeParse(range.start).success &&
    historicalDateSchema.safeParse(range.end).success &&
    range.start <= range.end;
  const audit = api.universeAuditPage.useQuery(
    { source, ...range, metric, page },
    {
      enabled: valid && (open || source.kind === "research"),
      retry: false,
      staleTime: 60000,
    },
  );
  return (
    <section
      className="space-y-3 rounded-lg border border-border p-3"
      aria-label="证券池时点审计"
    >
      {(audit.data
        ? audit.data.summary.notListedAtStart > 0 ||
          audit.data.summary.unknowable.rosterIsCurrentSnapshot
        : true) && (
        <p className="text-sm text-muted-foreground">{universeBiasWarning}</p>
      )}
      <Button
        variant="outline"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        时点审计
      </Button>
      {open && (
        <>
          {source.kind !== "research" && (
            <div className="flex flex-wrap gap-3">
              <label>
                审计开始
                <Input
                  type="date"
                  value={range.start}
                  onChange={(e) => {
                    setRange({ ...range, start: e.target.value });
                    setPage(0);
                  }}
                />
              </label>
              <label>
                审计结束
                <Input
                  type="date"
                  value={range.end}
                  disabled={source.kind === "concept"}
                  onChange={(e) => {
                    setRange({ ...range, end: e.target.value });
                    setPage(0);
                  }}
                />
              </label>
              <p className="text-sm">
                自选审计区间；不按 RPS
                周期推算自然日起点。只读缓存与本地名单，不刷新证据。
              </p>
            </div>
          )}
          {!valid && (
            <p role="status">请选择有效审计区间，开始不能晚于结束。</p>
          )}
          <Select
            value={metric}
            onValueChange={(value) => {
              setMetric(value as UniverseAuditMetric);
              setPage(0);
            }}
          >
            <SelectTrigger aria-label="审计明细类别">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(universeAuditLabels).map(([key, label]) => (
                <SelectItem key={key} value={key}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {valid && audit.isFetching && (
            <p role="status">正在读取本地审计证据…</p>
          )}
          {valid && audit.error && (
            <p role="alert">
              {audit.error.message}
              <Button variant="ghost" onClick={() => void audit.refetch()}>
                重试审计
              </Button>
            </p>
          )}
          {valid && audit.data && (
            <UniverseAuditResults
              data={audit.data}
              page={page}
              onPage={setPage}
              loading={audit.isFetching}
            />
          )}
        </>
      )}
    </section>
  );
}
