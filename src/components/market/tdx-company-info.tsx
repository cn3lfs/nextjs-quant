"use client";
import { useState } from "react";
import { api } from "~/trpc/react";
import { Button } from "../ui/button";

/**
 * F10 公司资料是公共服务器上的 GBK 文本栏目，取一次要走 TCP，所以两级按需加载：
 * 展开折叠区才拉栏目清单，点某个栏目才拉它的正文。默认什么都不请求。
 */
export function TdxCompanyInfo({ symbol }: { symbol: string }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const categories = api.tdxCompanyInfo.useQuery(symbol, {
    enabled: open,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 3600000,
  });
  const category = categories.data?.find((row) => row.filename === selected);
  const content = api.tdxCompanyInfoContent.useQuery(
    {
      symbol,
      filename: category?.filename ?? "",
      start: category?.start ?? 0,
      length: category?.length ?? 1,
    },
    {
      enabled: Boolean(category?.length),
      retry: false,
      refetchOnWindowFocus: false,
      staleTime: 3600000,
    },
  );
  return (
    <details
      data-testid="tdx-company-info"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm">
        公司资料 F10（展开后按需读取）
      </summary>
      {categories.isFetching && !categories.data && (
        <p role="status" className="text-sm">
          正在读取 F10 栏目清单…
        </p>
      )}
      {categories.error && (
        <div role="alert" className="text-sm">
          F10 栏目读取失败：{categories.error.message}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void categories.refetch()}
          >
            重试栏目
          </Button>
        </div>
      )}
      {categories.data?.length === 0 && (
        <p className="text-sm">该证券在当前节点没有 F10 栏目。</p>
      )}
      {categories.data && categories.data.length > 0 && (
        <div className="flex flex-wrap gap-2 py-1" role="toolbar">
          {categories.data.map((row) => (
            <Button
              key={row.filename}
              size="sm"
              variant="outline"
              aria-pressed={selected === row.filename}
              disabled={!row.length}
              onClick={() => setSelected(row.filename)}
            >
              {row.name}
              {row.length ? "" : "（空）"}
            </Button>
          ))}
        </div>
      )}
      {category && (
        <>
          {content.isFetching && !content.data && (
            <p role="status" className="text-sm">
              正在读取「{category.name}」正文…
            </p>
          )}
          {content.error && (
            <div role="alert" className="text-sm">
              正文读取失败：{content.error.message}
              <Button
                size="sm"
                variant="outline"
                onClick={() => void content.refetch()}
              >
                重试正文
              </Button>
            </div>
          )}
          {content.data !== undefined && (
            <pre className="max-h-96 overflow-auto text-xs whitespace-pre-wrap">
              {content.data}
            </pre>
          )}
        </>
      )}
      <p className="text-xs text-muted-foreground">
        F10
        是公共服务器上的文本资料，内容与更新时点由节点决定，不同节点长度可能不同；
        只作阅读参考，不参与任何指标计算，也不作为财报依据。
      </p>
    </details>
  );
}
