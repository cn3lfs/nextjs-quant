"use client";

import { useState } from "react";
import type { PaginationState, SortingState } from "@tanstack/react-table";
import { api, type RouterInputs } from "~/trpc/react";
import {
  admissionParamsSchema,
  defaultAdmissionParams,
} from "~/lib/strategy-admission";
import { StrategyAdmissionResults } from "./strategy-admission-results";
import { Input } from "../ui/input";
import { Button } from "../ui/button";

const fields = [
  ["targetVol", "目标年化波动率"],
  ["maxDdThreshold", "逐年 / 近期回撤阈值"],
  ["maxAlphaDdThreshold", "全样本回撤阈值"],
  ["minFullSharpe", "全样本 Sharpe 下限"],
  ["minYearDays", "完整年最少交易日"],
  ["recentDays", "近期窗口交易日"],
  ["minHistoryDays", "历史段最少交易日（0关闭）"],
  ["yearlyDays", "年化天数"],
] as const;
export function StrategyAdmissionContainer({
  source,
}: {
  source:
    | { account: string }
    | { id: string; partition: "development" | "validation" };
}) {
  const utils = api.useUtils();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(defaultAdmissionParams).map(([key, value]) => [
        key,
        String(value),
      ]),
    ),
  );
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 10,
  });
  const [sorting, setSorting] = useState<SortingState>([
    { id: "year", desc: false },
  ]);
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState("");
  const parsed = admissionParamsSchema.safeParse(
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        value.trim() === "" ? NaN : Number(value),
      ]),
    ),
  );
  const account = "account" in source;
  // 无效编辑立即显示错误并停算，不使用默认值展示一个不同参数的判定。
  const page = {
    ...pagination,
    params: parsed.success ? parsed.data : defaultAdmissionParams,
    sort: (sorting[0]?.id ??
      "year") as RouterInputs["tradeReviewAdmission"]["sort"],
    desc: sorting[0]?.desc ?? false,
  };
  const trade = api.tradeReviewAdmission.useQuery(
    { ...page, account: account ? source.account : "" },
    { enabled: account && parsed.success, retry: false },
  );
  const research = api.strategyResearchAdmission.useQuery(
    {
      ...page,
      id: account ? "" : source.id,
      partition: account ? "development" : source.partition,
    },
    { enabled: !account && parsed.success, retry: false },
  );
  const query = account ? trade : research;
  async function download() {
    if (!parsed.success) return;
    setExporting(true);
    setMessage("");
    try {
      const result = account
        ? await utils.tradeReviewAdmissionExport.fetch({
            account: source.account,
            params: parsed.data,
          })
        : await utils.strategyResearchAdmissionExport.fetch({
            id: source.id,
            partition: source.partition,
            params: parsed.data,
          });
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(result, null, 2)], {
          type: "application/json",
        }),
      );
      const link = document.createElement("a");
      try {
        link.href = url;
        link.download = "strategy-admission.json";
        link.click();
        setMessage("已导出全部输入、参数和判定结果，可独立重放。");
      } finally {
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (error) {
      setMessage(
        `导出失败：${error instanceof Error ? error.message : "未知错误"}`,
      );
    } finally {
      setExporting(false);
    }
  }
  return (
    <section aria-label="策略准入判定" className="space-y-3">
      <details>
        <summary>准入参数（修改后即时重算；不代表完成标定）</summary>
        <div className="grid gap-3 pt-3 md:grid-cols-4">
          {fields.map(([key, label]) => (
            <label key={key} className="space-y-1 text-sm">
              {label}
              <Input
                type="number"
                step={key.endsWith("Days") ? 1 : "any"}
                value={values[key]}
                aria-invalid={
                  !parsed.success &&
                  parsed.error.issues.some((issue) => issue.path[0] === key)
                }
                onChange={(event) => {
                  setValues((previous) => ({
                    ...previous,
                    [key]: event.target.value,
                  }));
                  setPagination((p) => ({ ...p, pageIndex: 0 }));
                  setMessage("");
                }}
              />
            </label>
          ))}
        </div>
      </details>
      {!parsed.success ? (
        <p role="alert">
          参数无效：
          {parsed.error.issues
            .map((issue) => `${issue.path.join(".")}：${issue.message}`)
            .join("；")}
        </p>
      ) : (
        <>
          {query.isFetching && <p role="status">正在计算准入分指标…</p>}
          {query.error ? (
            <div role="alert">
              {query.error.message}
              <Button variant="outline" onClick={() => void query.refetch()}>
                重试准入判定
              </Button>
            </div>
          ) : (
            query.data && (
              <StrategyAdmissionResults
                data={query.data}
                table={{
                  pagination,
                  sorting,
                  onPaginationChange: setPagination,
                  onSortingChange: (value) => {
                    setSorting(value);
                    setPagination((p) => ({ ...p, pageIndex: 0 }));
                  },
                  loading: query.isFetching,
                }}
              />
            )
          )}
        </>
      )}
      <Button
        variant="outline"
        disabled={
          !parsed.success ||
          exporting ||
          query.isFetching ||
          !!query.error ||
          !query.data
        }
        onClick={() => void download()}
      >
        {exporting ? "正在导出…" : "导出准入 JSON（完整可重放）"}
      </Button>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
