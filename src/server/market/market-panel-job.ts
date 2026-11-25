import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { relative } from "node:path";
import type { Job } from "~/lib/domain";
import {
  readJobByIdReadOnly,
  readJobByKeyReadOnly,
  readSettingsTdxRootReadOnly,
} from "../db/jobs";
import { dataDirectory } from "../infra/paths";
import { background, runWorker } from "../jobs/jobs";
import { openMarketPanel, type MarketPanelHandle } from "./market-panel";
import { effectiveMarketPanelRoot } from "./market-temperature-inputs";

export type MarketPanelStatus = {
  ready: boolean;
  snapshotId: string | null;
  lastDate: string | null;
  symbolsCount: number | null;
  job: {
    id: string;
    status: Job["status"];
    progress: number;
    phase: string;
    error: string | null;
    snapshotId: string | null;
    updatedAt: number;
  } | null;
};

// background() hashes [type, canonical(dedupe)]. Keep these keys in sorted order.
const buildInput = (root: string) => ({ kind: "market-panel-build", root });

export function startMarketPanelBuild(configuredRoot?: string) {
  const root = effectiveMarketPanelRoot(configuredRoot);
  const input = buildInput(root);
  return background(
    "scan",
    input,
    (job) => runWorker({ type: "market-panel-build", root }, job.id),
    input,
  );
}

// Settings belong to the host workspace, even when a query uses a different
// directory for its frozen panel files.
const hostDataDirectory = process.env.QUANT_DATA_DIR;
export function readMarketPanelRoot() {
  return readSettingsTdxRootReadOnly(hostDataDirectory ?? dataDirectory());
}

function latestBuildJob(root: string): Job | null {
  const key =
    "job-key-" +
    createHash("sha256")
      .update(JSON.stringify(["scan", buildInput(root)]))
      .digest("hex");
  return readJobByKeyReadOnly(key);
}

function buildJobStatus(job: Job | null): MarketPanelStatus["job"] {
  const input = job?.input as { kind?: unknown } | null | undefined;
  if (job?.type !== "scan" || input?.kind !== "market-panel-build") return null;
  const { id, status, progress, phase, error, result, updatedAt } = job;
  const snapshotId = (result as { snapshotId?: unknown } | null | undefined)
    ?.snapshotId;
  return {
    id,
    status,
    progress,
    phase: phase ?? "",
    error: error ?? null,
    snapshotId: typeof snapshotId === "string" ? snapshotId : null,
    updatedAt,
  };
}

export function getMarketPanelStatus(
  configuredRoot?: string,
  jobId?: string,
): MarketPanelStatus {
  const root = effectiveMarketPanelRoot(configuredRoot);
  const job =
    jobId === undefined ? latestBuildJob(root) : readJobByIdReadOnly(jobId);
  const status: MarketPanelStatus = {
    ready: false,
    snapshotId: null,
    lastDate: null,
    symbolsCount: null,
    job: buildJobStatus(job),
  };
  let handle: MarketPanelHandle | undefined;
  try {
    handle = openMarketPanel(undefined, root);
    if (relative(realpathSync.native(root), handle.manifest.root) === "") {
      status.snapshotId = handle.snapshotId;
      status.lastDate = handle.manifest.dates.at(-1) ?? null;
      status.symbolsCount = handle.manifest.symbols.length;
      status.ready = true;
    }
  } catch {
    // The current panel and the requested job report their snapshots separately.
  } finally {
    handle?.close();
  }
  return status;
}
