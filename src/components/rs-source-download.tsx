"use client";
import { useState } from "react";
import { api } from "~/trpc/react";
import { Button } from "./ui/button";
import type { Evidence } from "~/lib/domain";
export function RsSourceDownload({
  reportId,
  evidence,
}: {
  reportId: string;
  evidence: Evidence;
}) {
  const utils = api.useUtils(),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  let available = false;
  try {
    available = /^rs-(?:universe|prices)-[a-f0-9]{64}$/.test(
      JSON.parse(evidence.text).snapshotId ?? "",
    );
  } catch {}
  if (!available) return null;
  async function download() {
    setPending(true);
    setError("");
    try {
      const data = await utils.rsSourceExport.fetch({
        reportId,
        evidenceId: evidence.id,
      });
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], {
          type: "application/json;charset=utf-8",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `RS来源-${data.range}-${data.hash.slice(0, 12)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "来源导出失败");
    } finally {
      setPending(false);
    }
  }
  return (
    <div>
      <Button size="sm" variant="outline" disabled={pending} onClick={download}>
        {pending ? "正在导出…" : "下载完整 RS 来源列表"}
      </Button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
