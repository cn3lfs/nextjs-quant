"use client";
import { useState } from "react";
import { api } from "~/trpc/react";
import { commonIndices } from "~/lib/market-indices";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function IndexBrowser({
  onSelect,
  disabled,
}: {
  onSelect: (symbol: string) => void;
  disabled: boolean;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const catalog = api.indexDirectory.useQuery(undefined, { staleTime: 60000 });
  const matches = query.trim()
    ? (catalog.data ?? commonIndices).filter((row) =>
        `${row.symbol} ${row.name}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
      )
    : commonIndices;
  const rows = matches.slice(page * 50, (page + 1) * 50);
  return (
    <div className="space-y-2 border-b pb-3" aria-label="指数浏览">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="font-semibold">指数行情</h3>
        <Input
          className="max-w-64"
          aria-label="搜索指数"
          placeholder="搜索更多指数名称或代码"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
          }}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        {rows.map((row) => (
          <Button
            key={row.symbol}
            variant="outline"
            disabled={disabled}
            onClick={() => onSelect(row.symbol)}
          >
            {row.name} · {row.symbol.toUpperCase()}
          </Button>
        ))}
      </div>
      {query && !rows.length && !catalog.isPending && (
        <p className="text-sm">未找到此指数，请尝试完整名称或代码。</p>
      )}
      {catalog.isPending && (
        <p role="status" className="text-sm">
          正在读取指数名录…
        </p>
      )}
      {catalog.error && (
        <p role="alert" className="text-sm">
          指数名录读取失败：{catalog.error.message}
          <Button variant="ghost" onClick={() => void catalog.refetch()}>
            重试
          </Button>
        </p>
      )}
      {matches.length > 50 && (
        <div className="flex items-center gap-3 text-sm">
          <span>
            匹配{matches.length}个，第{page + 1}页
          </span>
          <Button
            variant="outline"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            上一页
          </Button>
          <Button
            variant="outline"
            disabled={(page + 1) * 50 >= matches.length}
            onClick={() => setPage(page + 1)}
          >
            下一页
          </Button>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        名录共{catalog.data?.length ?? commonIndices.length}
        个指数；无需本地行情文件也可在线读取。常用指数之外可按名称或代码搜索。
      </p>
    </div>
  );
}
