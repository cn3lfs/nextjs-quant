"use client";
import { useState } from "react";
import { api } from "~/trpc/react";
import { useScreenSession } from "~/lib/stores/screen-session";
import { useTaskVisible } from "../workbench/use-task-visible";
import { activeJobPoll } from "../workbench/job-poll";
import { useRecentJobs } from "../workbench/use-recent-jobs";

/** Query ownership stays inside the screening panel; controls survive eviction. */
export function useScreenResults(notify: (text: string) => void) {
  const jobs = useRecentJobs().data;
  const visible = useTaskVisible();
  const session = useScreenSession();
  const {
    screenId,
    screenPage,
    excludedPage,
    errorPage,
    screenQuery,
    screenSort,
    screenDirection,
  } = session;
  const utils = api.useUtils();
  function selectJob(id: string) {
    if (id === screenId) return;
    session.selectJob(id);
    void utils.jobs.invalidate();
    void utils.taskOverview.invalidate();
  }
  const selectedScreen = api.jobSummary.useQuery(
    { id: screenId, screenFirstPage: true },
    {
      enabled: visible && !!screenId,
      refetchInterval: (query) =>
        visible ? activeJobPoll(query.state.data) : false,
    },
  );
  // An explicit task must never fall back to an unrelated recent result.
  // A null response is authoritative, even if the recent-jobs cache still has it.
  const requestedScreen = screenId
    ? selectedScreen.data !== undefined
      ? selectedScreen.data
      : jobs?.find((j) => j.id === screenId)
    : jobs?.find((j) => j.isFormulaScreen);
  const screenJob = requestedScreen?.isFormulaScreen
    ? requestedScreen
    : undefined;
  const firstScreenPage =
    screenPage === 0 &&
    excludedPage === 0 &&
    errorPage === 0 &&
    screenQuery === "" &&
    screenSort === "original"
      ? selectedScreen.data?.screenFirstPage
      : null;
  const screened = api.screenResults.useQuery(
    {
      id: screenJob?.id ?? "",
      version: screenJob?.updatedAt,
      page: screenPage,
      excludedPage,
      errorPage,
      query: screenQuery,
      sort: screenSort,
      direction: screenDirection,
    },
    {
      enabled:
        visible &&
        !!screenJob?.id &&
        screenJob.status === "completed" &&
        !firstScreenPage,
      placeholderData: (previous) =>
        previous?.jobId === screenJob?.id ? previous : undefined,
    },
  );
  const [exportingScreen, setExportingScreen] = useState(false);
  async function exportScreen() {
    if (!screenJob?.id) return;
    setExportingScreen(true);
    try {
      const data = await utils.screenExport.fetch(screenJob.id);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `本地选股-${data.asOf?.replaceAll(":", "-") ?? "未记录基准日"}-${data.jobId}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      notify(error instanceof Error ? error.message : "导出失败");
    } finally {
      setExportingScreen(false);
    }
  }
  const screenResult =
    screenJob?.status === "completed"
      ? (firstScreenPage ??
        (screened.data?.jobId === screenJob.id ? screened.data : undefined))
      : undefined;
  return {
    ...session,
    selectJob,
    utils,
    notify,
    selectedScreen,
    screenJob,
    firstScreenPage,
    screened,
    exportingScreen,
    exportScreen,
    screenResult,
  };
}
