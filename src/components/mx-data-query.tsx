"use client";

import { useState } from "react";
import { mxKinds, mxTableSchema, type MxKind } from "~/lib/mx-data";
import { api } from "~/trpc/react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Table } from "./ui/table";

export function MxDataQuery() {
  const status = api.mxDataStatus.useQuery(undefined, { staleTime: 60000 });
  const query = api.mxDataQuery.useMutation();
  const [kind, setKind] = useState<MxKind>("ashare");
  const [subjects, setSubjects] = useState("宁德时代（300750.SZ）");
  const [timeRange, setTimeRange] = useState("最近3个交易日");
  const [request, setRequest] = useState(
    "查询每日开盘价、最高价、最低价、收盘价、成交量和成交额，注明单位及复权口径",
  );
  const reset = () => query.reset();
  return (
    <section className="panel p-5">
      <details>
        <summary className="cursor-pointer font-semibold">
          东方财富 MCP 数据查询
        </summary>
        <p className="my-3 text-sm text-muted-foreground">
          自然语言资料查询，独立于图表数据源。每次选择一个品种或场景；不同场景请分别查询。结果可能取整或包含额外指标，不进入图表及策略计算。
        </p>
        <p role="status" className="mb-3 text-sm">
          {status.isPending
            ? "检查本地配置…"
            : status.data?.configured
              ? "已读取 Codex 本地配置，授权有效性以查询结果为准"
              : "本地配置不可用，请检查 Codex 的 mx-ds-mcp 配置与授权"}
        </p>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            query.mutate({
              kind,
              subjects: subjects
                .split(/[,，;；\n]/)
                .map((s) => s.trim())
                .filter(Boolean),
              timeRange,
              request,
            });
          }}
        >
          <fieldset
            disabled={query.isPending}
            className="grid gap-3 sm:grid-cols-2"
          >
            <label className="grid gap-1 text-sm">
              查询类别
              <Select
                value={kind}
                disabled={query.isPending}
                onValueChange={(value) => {
                  setKind(value as MxKind);
                  setSubjects("");
                  reset();
                }}
              >
                <SelectTrigger aria-label="查询类别" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(mxKinds).map(([value, item]) => (
                    <SelectItem key={value} value={value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="grid gap-1 text-sm">
              时间范围
              <Input
                required
                maxLength={120}
                value={timeRange}
                onChange={(e) => {
                  setTimeRange(e.target.value);
                  reset();
                }}
              />
            </label>
            <label className="grid gap-1 text-sm sm:col-span-2">
              标的或范围（同品种多标的用逗号分隔，最多500个）
              <Input
                required
                maxLength={50000}
                placeholder="证券名称及代码；筛选填A股等单一品种，宏观填指标及地区"
                value={subjects}
                onChange={(e) => {
                  setSubjects(e.target.value);
                  reset();
                }}
              />
            </label>
            <label className="grid gap-1 text-sm sm:col-span-2">
              查询内容
              <Textarea
                required
                maxLength={2000}
                value={request}
                onChange={(e) => {
                  setRequest(e.target.value);
                  reset();
                }}
              />
            </label>
          </fieldset>
          <Button
            type="submit"
            className="justify-self-start"
            disabled={query.isPending || !status.data?.configured}
          >
            {query.isPending
              ? "查询中…"
              : query.error
                ? "重试查询"
                : "查询东方财富 MCP"}
          </Button>
        </form>
        {query.error && (
          <p role="alert" className="mt-3 text-sm">
            {query.error.message}
          </p>
        )}
        {query.data && (
          <div className="mt-4 space-y-3" aria-live="polite">
            <p className="text-sm">
              来源：东方财富 mx-ds-mcp · 查询时间：
              {new Date(query.data.fetchedAt).toLocaleString("zh-CN")}
              （不是数据时点）
            </p>
            <p className="text-sm text-muted-foreground">{query.data.query}</p>
            {query.data.message && (
              <p role="alert" className="text-sm">
                来源提示：{query.data.message}
              </p>
            )}
            {query.data.scopeWarnings.map((warning) => (
              <p key={warning} role="alert" className="text-sm">
                范围核验：{warning}
              </p>
            ))}
            {!query.data.data.length && <p>未返回数据，不代表指标为零。</p>}
            {query.data.data.map((raw, index) => {
              const parsed = mxTableSchema.safeParse(raw);
              if (!parsed.success)
                return (
                  <pre
                    key={index}
                    className="max-h-80 overflow-auto whitespace-pre-wrap text-xs"
                  >
                    {JSON.stringify(raw, null, 2)}
                  </pre>
                );
              const table = parsed.data;
              return (
                <div
                  key={index}
                  className="max-h-96 overflow-auto rounded-md border"
                >
                  <Table className="w-full text-left text-sm">
                    <caption className="p-2 text-left font-medium">
                      {table.sheetName}
                    </caption>
                    <thead>
                      <tr>
                        {table.columns.map((column, i) => (
                          <th
                            key={i}
                            className="whitespace-nowrap border-b p-2"
                          >
                            {column}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {table.items.map((row, i) => (
                        <tr key={i}>
                          {row.map((cell, j) => (
                            <td
                              key={j}
                              className="whitespace-nowrap border-b p-2"
                            >
                              {cell === null ? "未提供" : String(cell)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              );
            })}
            <details>
              <summary className="cursor-pointer text-sm">
                查看原始结果与查询记录
              </summary>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs">
                {JSON.stringify(query.data, null, 2)}
              </pre>
            </details>
          </div>
        )}
      </details>
    </section>
  );
}
