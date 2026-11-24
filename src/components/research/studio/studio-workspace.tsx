"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "~/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { BacktestView } from "~/components/workbench/backtest-view";
import { activeJobPoll } from "~/components/workbench/job-poll";
import {
  PanelVisibility,
  usePanelVisible,
} from "~/components/workbench/keep-alive";
import type { DiagnoseArchiveSummary } from "~/lib/research/diagnose-contract";
import {
  parseStudioEntry,
  studioTemplateLabels,
  studioViewOptions,
  type StudioRunReference,
} from "~/lib/research/studio-entry";
import type {
  ResearchStudioDraftInput,
  StudioTemplateKind,
} from "~/lib/research/studio-result";
import { useMarketSession } from "~/lib/stores/market-session";
import { api } from "~/trpc/react";
import {
  DiagnoseWorkspacePanel,
  type DiagnoseRunPrefill,
  type DiagnoseRunRequest,
} from "../diagnose/diagnose-workspace-panel";
import { LabBacktest } from "../lab-backtest";
import { StudioArchives } from "./studio-archives";
import { StudioComposeForm } from "./studio-compose-form";
import {
  StudioDiagnoseResult,
  StudioJobResult,
  StudioSessionResult,
} from "./studio-result-panel";
import {
  readSessionRuns,
  saveSessionRun,
  type StudioSessionRun,
} from "./studio-session";

const studioPath = "/lab/backtest";
const directTemplates = [
  "etf-rotation",
  "alpha-formula",
  "exit-family",
] as const;
type DirectDraft = Extract<
  ResearchStudioDraftInput,
  { template: (typeof directTemplates)[number] }
>;

function updateStudioUrl(update: (params: URLSearchParams) => void) {
  const { pathname, search, hash } = window.location;
  if (pathname !== studioPath) return;
  const params = new URLSearchParams(search);
  update(params);
  const nextSearch = params.toString();
  if (nextSearch !== search.slice(1))
    window.history.pushState(null, "", `${pathname}?${nextSearch}${hash}`);
}

export function StudioWorkspace() {
  const visible = usePanelVisible();
  const currentSearch = useSearchParams().toString();
  const [retainedSearch, setRetainedSearch] = useState(currentSearch);
  if (visible && currentSearch !== retainedSearch)
    setRetainedSearch(currentSearch);
  const search = visible ? currentSearch : retainedSearch;
  const entry = useMemo(() => parseStudioEntry(search), [search]);
  const loaded = useMarketSession((state) => state.loaded);
  const [batchKey, setBatchKey] = useState(entry.batchKey);
  const [diagnoseRequest, setDiagnoseRequest] =
    useState<DiagnoseRunRequest | null>(() =>
      entry.batchPrefill ? { handoff: entry.batchPrefill } : null,
    );
  if (batchKey !== entry.batchKey) {
    setBatchKey(entry.batchKey);
    if (entry.batchPrefill) setDiagnoseRequest({ handoff: entry.batchPrefill });
  }
  const [rerun, setRerun] = useState<DirectDraft | null>(null);
  const [runs, setRuns] = useState<StudioSessionRun[] | null>(null);
  const [latest, setLatest] = useState<StudioRunReference | null>(null);
  const [storageError, setStorageError] = useState(false);
  useEffect(() => setRuns(readSessionRuns()), []);

  const compose = entry.view === "compose";
  const viewingResult = entry.view === "result";
  const objectActive = compose && entry.template === "single" && entry.object;
  const diagnoseActive =
    compose &&
    (entry.template === "multi-book" ||
      (entry.template === "single" && !entry.object));
  const [diagnoseTemplate, setDiagnoseTemplate] = useState<
    "single" | "multi-book"
  >(entry.template === "multi-book" ? "multi-book" : "single");
  if (diagnoseActive && entry.template !== diagnoseTemplate) {
    setDiagnoseTemplate(
      entry.template === "multi-book" ? "multi-book" : "single",
    );
  }
  const catalog = api.studioTemplates.useQuery(undefined, {
    enabled:
      visible &&
      compose &&
      !objectActive &&
      entry.template !== "ma-baseline-5m",
  });

  const reference =
    entry.reference?.kind === "run" && latest?.id === entry.reference.id
      ? latest
      : (entry.reference ?? latest);
  const sessionRun =
    reference?.kind === "run"
      ? runs?.find((run) => run.id === reference.id)
      : undefined;
  const jobId =
    reference?.kind === "run" &&
    !reference.id.startsWith("studio-") &&
    runs &&
    !sessionRun
      ? reference.id
      : reference?.kind === "object"
        ? reference.id
        : null;
  const job = api.jobSummary.useQuery(
    { id: jobId ?? "" },
    {
      enabled: visible && viewingResult && jobId !== null,
      refetchInterval: (query) =>
        visible && viewingResult ? activeJobPoll(query.state.data) : false,
    },
  );
  const archiveId =
    reference?.kind === "diagnose"
      ? reference.id
      : job.data?.resultLink?.href.startsWith(`${studioPath}?archive=`)
        ? parseStudioEntry(job.data.resultLink.href.split("?")[1] ?? "")
            .archiveId
        : null;
  const maResultId =
    reference?.kind === "ma"
      ? reference.id
      : job.data?.type === "backtest" &&
          !job.data.localEvidence &&
          job.data.sourceLink?.href === studioPath
        ? job.data.id
        : null;
  const maCompose = compose && entry.template === "ma-baseline-5m";
  const maResult = viewingResult && !!maResultId;

  function openResult(next: StudioRunReference) {
    setLatest(next);
    updateStudioUrl((params) => {
      params.set("view", "result");
      params.delete("archive");
      params.delete("run");
      params.set(next.kind === "diagnose" ? "archive" : "run", next.id);
    });
  }

  function openTemplate(
    template: StudioTemplateKind,
    mode?: "object" | "diagnose",
  ) {
    updateStudioUrl((params) => {
      params.set("view", "compose");
      params.set("template", template);
      if (mode) params.set("mode", mode);
    });
  }

  function applyHandoff(handoff: DiagnoseRunPrefill) {
    setDiagnoseRequest({ handoff });
    openTemplate(handoff.bookPreset ? "multi-book" : "single", "diagnose");
  }

  function rerunDiagnosis(archive: DiagnoseArchiveSummary) {
    const book =
      archive.run?.book ??
      archive.run?.bookPreset ??
      archive.book ??
      archive.bookPreset;
    setDiagnoseRequest({ archive });
    openTemplate(book ? "multi-book" : "single", "diagnose");
  }

  const run = api.studioRun.useMutation();
  function runStudio(draft: ResearchStudioDraftInput) {
    if (run.isPending) return;
    const submittedSearch = window.location.search;
    run.mutate(draft, {
      onSuccess(result) {
        const saved = saveSessionRun(draft, result);
        setStorageError(!saved.persisted);
        setRuns((previous) => [
          saved.run,
          ...(previous ?? []).filter(({ id }) => id !== saved.run.id),
        ]);
        const next = { kind: "run", id: saved.run.id } as const;
        if (
          window.location.pathname === studioPath &&
          window.location.search === submittedSearch
        )
          openResult(next);
        else setLatest(next);
      },
    });
  }

  return (
    <section aria-label="研究工作室" className="min-w-0 space-y-3">
      <h2 className="text-xl font-semibold">研究工作室</h2>
      <Tabs
        value={entry.view}
        onValueChange={(view) =>
          updateStudioUrl((params) => params.set("view", view))
        }
      >
        <TabsList aria-label="研究工作室视图">
          {studioViewOptions.map(({ value, label }) => (
            <TabsTrigger key={value} value={value}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value={entry.view} className="min-w-0 space-y-3">
          <div hidden={!compose} className="space-y-3">
            <label className="block max-w-xs text-sm">
              研究模板
              <select
                className="mt-1 block w-full"
                value={entry.template}
                onChange={(event) => {
                  const value = event.target.value;
                  if (Object.hasOwn(studioTemplateLabels, value))
                    openTemplate(value as StudioTemplateKind);
                }}
              >
                {Object.entries(studioTemplateLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {entry.template === "single" && (
              <label className="block max-w-xs text-sm">
                单策略引擎
                <select
                  className="mt-1 block w-full"
                  value={entry.object ? "object" : "diagnose"}
                  onChange={(event) =>
                    openTemplate(
                      "single",
                      event.target.value === "object" ? "object" : "diagnose",
                    )
                  }
                >
                  <option value="diagnose">策略目录与诊断</option>
                  <option value="object">策略对象组合回测</option>
                </select>
              </label>
            )}
            <LabBacktest
              entry={entry}
              search={search}
              active={objectActive}
              showHandoff={compose}
              onApply={() => openTemplate("single", "object")}
              onDiagnose={applyHandoff}
              onResult={(id) => openResult({ kind: "object", id })}
            />
            <div hidden={!diagnoseActive}>
              <PanelVisibility visible={diagnoseActive}>
                <section aria-label="诊断工作台">
                  <DiagnoseWorkspacePanel
                    request={diagnoseRequest}
                    template={diagnoseTemplate}
                    catalog={catalog.data}
                    onStudioRun={runStudio}
                    studioBusy={run.isPending}
                    onViewArchive={(id) => openResult({ kind: "diagnose", id })}
                  />
                </section>
              </PanelVisibility>
            </div>
            {directTemplates.map((template) => (
              <div key={template} hidden={entry.template !== template}>
                <StudioComposeForm
                  template={template}
                  alphaId={template === "alpha-formula" ? entry.alphaId : null}
                  active={visible && compose && entry.template === template}
                  catalog={catalog.data}
                  busy={run.isPending}
                  rerun={rerun}
                  onRun={runStudio}
                />
              </div>
            ))}
          </div>
          <BacktestView
            loaded={loaded}
            studio={{
              view: maCompose ? "compose" : maResult ? "result" : "inactive",
              resultId: maResult ? maResultId : null,
              onResult: (id) => openResult({ kind: "ma", id }),
              onReuse: () => openTemplate("ma-baseline-5m"),
            }}
          />
          {run.isPending && <p role="status">正在运行研究回测…</p>}
          {run.error && (
            <p role="alert" className="text-sm text-nc-warn">
              研究回测失败：{run.error.message}
            </p>
          )}
          <div hidden={!viewingResult || maResult}>
            {sessionRun ? (
              <StudioSessionResult
                key={sessionRun.id}
                run={sessionRun}
                storageError={storageError}
                onViewArchive={(id) => openResult({ kind: "diagnose", id })}
                onRerun={(draft) => {
                  setRerun({ ...draft });
                  openTemplate(draft.template);
                }}
              />
            ) : archiveId ? (
              <StudioDiagnoseResult
                key={archiveId}
                id={archiveId}
                active={visible && viewingResult}
                onRerun={rerunDiagnosis}
              />
            ) : jobId ? (
              <StudioJobResult
                key={jobId}
                id={jobId}
                job={job}
                active={visible && viewingResult}
              />
            ) : reference && !runs ? (
              <p role="status">正在恢复研究结果…</p>
            ) : (
              <div className="space-y-2">
                <p>
                  {reference
                    ? "此浏览器会话中找不到该次研究结果。"
                    : "请选择归档或运行回测以查看结果。"}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    updateStudioUrl((params) => params.set("view", "archive"))
                  }
                >
                  查看研究归档
                </Button>
              </div>
            )}
          </div>
          <div hidden={entry.view !== "archive"}>
            <StudioArchives
              active={visible && entry.view === "archive"}
              runs={runs ?? []}
              onOpen={openResult}
            />
          </div>
        </TabsContent>
      </Tabs>
    </section>
  );
}
