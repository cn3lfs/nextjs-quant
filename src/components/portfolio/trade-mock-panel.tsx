"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { Robot } from "@phosphor-icons/react/ssr";
import { Panel } from "../panels";
import { Button } from "../ui/button";
import { DataTable } from "../ui/data-table";
import {
  mockContract,
  mockMarketLabel,
} from "~/lib/contracts/mock-trading-contract";
import type { TradeInput } from "~/lib/portfolio/trade-ledger";
import type {
  reconcileMock,
  previewMockOrder,
} from "~/server/portfolio/mock/mock-trading-service";
import {
  readMockDiagnostics,
  readMockMarkets,
  readMockFunds,
  readMockTrades,
  recoverMockAccount,
  toggleMock,
  createMockAccount,
  reconcileAccount,
  previewOrder,
  confirmOrder,
} from "~/app/trade-ledger/actions";
const number = (value: number | null | undefined) =>
  value == null ? "—" : value.toFixed(2);
export function TradeMockPanel({
  enabled,
  input,
  onChanged,
}: {
  enabled: boolean;
  input: () => TradeInput;
  onChanged: () => void;
}) {
  const [pending, start] = useTransition(),
    [message, setMessage] = useState("");
  const [diff, setDiff] = useState<Awaited<
    ReturnType<typeof reconcileMock>
  > | null>(null);
  const [preview, setPreview] = useState<Awaited<
    ReturnType<typeof previewMockOrder>
  > | null>(null);
  const [diagnostics, setDiagnostics] = useState<Awaited<
    ReturnType<typeof readMockDiagnostics>
  > | null>(null);
  const previewTrigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!preview) return;
    previewTrigger.current = document.activeElement as HTMLElement;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setPreview(null);
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      requestAnimationFrame(() => {
        if (previewTrigger.current?.isConnected) previewTrigger.current.focus();
      });
    };
  }, [preview]);
  const [markets, setMarkets] = useState<string[]>([]),
    [remoteQuery, setRemoteQuery] = useState<unknown>(null);
  const run = (work: () => Promise<void>) =>
    start(async () => {
      setMessage("");
      try {
        await work();
      } catch (error) {
        setMessage(
          error instanceof Error ? error.message : "操作失败，请核对结果",
        );
      }
    });
  return (
    <>
      <p role="status">{pending ? "正在处理模拟盘操作…" : message}</p>
      <Panel
        className="min-w-0"
        span={12}
        icon={Robot}
        title="同花顺模拟盘（可选同步层）"
        tag={enabled ? "已开启" : "已关闭"}
        note="同花顺问财提供模拟炒股服务"
      >
        <details>
          <summary>文档契约与实测契约差异</summary>
          <DataTable
            label="文档契约与实测契约差异"
            data={[...mockContract]}
            columns={[
              {
                id: "column-0",
                header: "文档契约",
                enableSorting: false,
                cell: ({ row }) => {
                  const c = row.original;
                  return <>{c.documented}</>;
                },
              },
              {
                id: "column-1",
                header: "实测契约",
                enableSorting: false,
                cell: ({ row }) => {
                  const c = row.original;
                  return <>{c.observed}</>;
                },
              },
              {
                id: "column-2",
                header: "差异与处理",
                enableSorting: false,
                cell: ({ row }) => {
                  const c = row.original;
                  return <>{c.difference}</>;
                },
              },
            ]}
            getRowId={(c) => String(c.documented)}
            rowCount={mockContract.length}
            pagination={{
              pageIndex: 0,
              pageSize: Math.max(1, mockContract.length),
            }}
            sorting={[]}
            onPaginationChange={() => {}}
            onSortingChange={() => {}}
            showPagination={false}
            emptyMessage={null}
          />
        </details>
        <div className="button-row">
          <Button
            size="sm"
            variant="outline"
            disabled={pending || !enabled}
            onClick={() => run(async () => setMarkets(await readMockMarkets()))}
          >
            查看已保存市场代码（本地）
          </Button>
          {markets.map((code) => (
            <p key={code}>
              {code}：{mockMarketLabel(code)}
            </p>
          ))}
          <Button
            size="sm"
            variant="outline"
            disabled={pending || !enabled}
            onClick={() =>
              run(async () => setRemoteQuery(await readMockFunds()))
            }
          >
            查询远程资金
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending || !enabled}
            onClick={() =>
              run(async () => setRemoteQuery(await readMockTrades()))
            }
          >
            查询当日成交
          </Button>
        </div>
        {remoteQuery !== null && (
          <pre className="overflow-auto">
            {JSON.stringify(remoteQuery, null, 2)}
          </pre>
        )}
        <p className="muted">
          当前{enabled ? "已开启" : "关闭"}
          。关闭时不读取远程账户、不发送任何远程请求。开启本身也不开户；所有远程操作需点击。
        </p>
        <div className="button-row">
          <Button
            size="sm"
            variant={enabled ? "danger" : "default"}
            disabled={pending}
            onClick={() =>
              run(async () => {
                await toggleMock(!enabled);
                onChanged();
                setDiff(null);
                setPreview(null);
                setMessage(
                  enabled ? "模拟盘已关闭" : "模拟盘已开启，尚未开户或下单",
                );
              })
            }
          >
            {enabled ? "关闭模拟盘" : "开启模拟盘"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() =>
              run(async () => {
                setDiagnostics(await readMockDiagnostics());
              })
            }
          >
            查看最近20次脱敏响应（本地）
          </Button>
        </div>
        {diagnostics && (
          <div aria-live="polite">
            {diagnostics.length === 0
              ? "尚无响应记录"
              : diagnostics.map((entry, i) => (
                  <details key={i}>
                    <summary>
                      {entry.path} ·{" "}
                      {new Date(entry.envelope.fetchedAt).toLocaleString()} ·
                      HTTP {entry.httpStatus ?? "未收到"}
                    </summary>
                    <pre className="overflow-auto">
                      {JSON.stringify(entry, null, 2)}
                    </pre>
                  </details>
                ))}
          </div>
        )}
        {enabled && (
          <>
            <p className="notice">
              开户将在第三方建立持久账户，用户名以DPAPI加密保存。服务使用HTTP。委托与本地交易互不自动覆盖。
            </p>
            <div className="button-row">
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  run(async () => {
                    await createMockAccount();
                    setMessage("账户已准备，可手动对账");
                  })
                }
              >
                确认创建或使用模拟账户
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  run(async () => {
                    await recoverMockAccount();
                    setMessage("既有账户股东账号已核验");
                  })
                }
              >
                查询既有账户股东账号（不开户）
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  run(async () => {
                    setDiff(await reconcileAccount());
                    setMessage("对账完成，未覆盖任何一侧");
                  })
                }
              >
                查询远程并对账
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  run(async () => {
                    setPreview(await previewOrder(input()));
                    setMessage("请核对委托后点击确认；预览60秒过期");
                  })
                }
              >
                用当前本地草稿预览模拟委托
              </Button>
            </div>
            {preview && (
              <div
                role="group"
                aria-label="确认模拟委托"
                className="notice mt-3"
              >
                <p>
                  {preview.input.symbol} ·{" "}
                  {preview.input.side === "buy" ? "买入" : "卖出"} ·{" "}
                  {preview.input.quantity}股 × {preview.input.price}
                  元；确认后发送远程委托。
                </p>
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    run(async () => {
                      const id = preview.id;
                      setPreview(null);
                      try {
                        setMessage(await confirmOrder(id));
                      } catch (error) {
                        throw new Error(
                          `委托结果未确认，请先查询当日成交或对账；不要直接新建委托重试。${error instanceof Error ? error.message : ""}`,
                        );
                      }
                    })
                  }
                >
                  确认发送这笔模拟委托
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setPreview(null)}
                >
                  取消
                </Button>
              </div>
            )}
            {diff && (
              <>
                <h3>对账差异（本地减远程）</h3>
                <p>两侧成本参数可能不同，差异不会触发同步覆盖。</p>
                {!diff.length && <p>两侧均无持仓。</p>}
                {diff.map((d) => (
                  <p key={d.symbol}>
                    {d.symbol}：持股 本地{d.localQuantity} / 远程
                    {d.remoteQuantity} / 差{d.quantityDifference}；可卖 本地
                    {d.localSellable} / 远程{d.remoteSellable}；成本 本地
                    {number(d.localCost)} / 远程{number(d.remoteCost)} / 差
                    {number(d.costDifference)}
                  </p>
                ))}
              </>
            )}
          </>
        )}
      </Panel>
    </>
  );
}
