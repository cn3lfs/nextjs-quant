"use client";
import { useRef, useState, useTransition } from "react";
import { feeLabel } from "~/lib/trade-ledger";
import { mockContract, mockMarketLabel } from "~/lib/mock-trading-contract";
import type { tradeDashboard } from "~/server/trade-ledger-service";
import type {
  reconcileMock,
  previewMockOrder,
} from "~/server/mock-trading-service";
import {
  readMockDiagnostics,
  readMockMarkets,
  readMockFunds,
  readMockTrades,
  recoverMockAccount,
  saveTrade,
  toggleMock,
  createMockAccount,
  reconcileAccount,
  previewOrder,
  confirmOrder,
  updateStop,
  saveBonusListing,
} from "~/app/trade-ledger/actions";
type Dashboard = Awaited<ReturnType<typeof tradeDashboard>>;
const number = (n: number | null | undefined) =>
  n == null ? "—" : n.toFixed(2);
export function TradeLedgerPanel({
  data,
  enabled,
}: {
  data: Dashboard;
  enabled: boolean;
}) {
  const [pending, start] = useTransition(),
    [message, setMessage] = useState("");
  const [diff, setDiff] = useState<Awaited<
    ReturnType<typeof reconcileMock>
  > | null>(null);
  const [preview, setPreview] = useState<Awaited<
    ReturnType<typeof previewMockOrder>
  > | null>(null);
  const [diagnostics, setDiagnostics] = useState<Awaited<ReturnType<typeof readMockDiagnostics>> | null>(null);
  const [markets, setMarkets] = useState<string[]>([]);
  const [remoteQuery, setRemoteQuery] = useState<unknown>(null);
  const form = useRef<HTMLFormElement>(null),
    tradeId = useRef<string | null>(null);
  const run = (work: () => Promise<void>) =>
    start(async () => {
      setMessage("");
      try {
        await work();
      } catch (e) {
        setMessage(e instanceof Error ? e.message : "操作失败，请重试");
      }
    });
  function input() {
    if (!form.current?.reportValidity())
      throw new Error("请填写完整有效的交易信息");
    const f = new FormData(form.current);
    tradeId.current ??= crypto.randomUUID();
    return {
      id: tradeId.current,
      symbol: String(f.get("symbol")).trim(),
      date: String(f.get("date")),
      side: String(f.get("side")),
      price: Number(f.get("price")),
      quantity: Number(f.get("quantity")),
      lowerLimit: Number(f.get("lowerLimit")),
      upperLimit: Number(f.get("upperLimit")),
      limitSource: String(f.get("limitSource")),
      signalId: String(f.get("signalId")) || null,
      stop: f.get("stop") ? Number(f.get("stop")) : null,
      note: String(f.get("note")),
    };
  }
  return (
    <main className="page">
      <div className="page-heading">
        <div>
          <h1>持仓与交易日志</h1>
          <p>本地账本为事实来源。人工录入、离线计算；模拟盘默认关闭。</p>
        </div>
        <a href="/">返回工作台</a>
      </div>
      <p role="status" aria-live="polite">
        {pending ? "正在处理…" : message}
      </p>
      <section className="panel">
        <h2>录入本地交易</h2>
        <p>
          {feeLabel}：cost-experiment-1，佣金3bp /
          最低5元、卖出印花税5bp、滑点5bp。成交价保留，滑点作为实验成本另计。
        </p>
        <form
          ref={form}
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              await saveTrade(input());
              tradeId.current = null;
              setMessage("交易已记入本地账本，未向外部下单");
            });
          }}
        >
          <fieldset disabled={pending}>
            <div className="form-grid">
              <label>
                股票代码（如sh600519）
                <input name="symbol" required pattern="(sh|sz|bj)[0-9]{6}" />
              </label>
              <label>
                成交日期
                <input
                  name="date"
                  type="date"
                  required
                  defaultValue={data.today}
                  max={data.today}
                />
              </label>
              <label>
                买卖
                <select name="side">
                  <option value="buy">买入</option>
                  <option value="sell">卖出</option>
                </select>
              </label>
              <label>
                成交价格
                <input
                  name="price"
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                />
              </label>
              <label>
                数量（100股整数倍）
                <input
                  name="quantity"
                  type="number"
                  step="100"
                  min="100"
                  required
                />
              </label>
              <label>
                当日跌停价
                <input
                  name="lowerLimit"
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                />
              </label>
              <label>
                当日涨停价
                <input
                  name="upperLimit"
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                />
              </label>
              <label>
                涨跌停依据（终端及日期）
                <input name="limitSource" required maxLength={200} />
              </label>
              <label>
                关联台账信号（可空）
                <select name="signalId">
                  <option value="">手动交易，不关联</option>
                  {data.signals.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.date} · {s.symbol} · {s.strategy} · {s.id.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                止损位（可空，可在持仓中更新）
                <input name="stop" type="number" min="0.01" step="0.01" />
              </label>
              <label>
                备注
                <input name="note" maxLength={500} />
              </label>
            </div>
            <p>
              涨跌停上下限按该交易日终端值录入；无普通涨跌幅限制或依据未知时暂不录入，避免套用常规比例。记录只追加，保存后可查原值。
            </p>
            <button type="submit">仅保存本地交易</button>
          </fieldset>
        </form>
      </section>
      <section className="panel">
        <h2>当前持仓</h2>
        <p>
          本地不复权已完成日线收盘价；日期见各行，非实时行情。止损距离＝（现价－止损位）/现价，负数表示已跌破，不自动卖出。日历：
          {data.calendarSource}
        </p>
        {!data.positions.length && <p>暂无持仓，请先录入一笔买入。</p>}
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                {[
                  "标的",
                  "持股",
                  "T+1可卖",
                  "核对后成本",
                  "参考成本",
                  "本地收盘/日期",
                  "浮动盈亏",
                  "止损距离",
                  "除权状态",
                ].map((s) => (
                  <th key={s}>{s}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.positions.map((p) => (
                <tr key={p.symbol}>
                  <td>{p.symbol}</td>
                  <td>{p.quantity}</td>
                  <td>{p.sellable}</td>
                  <td>{number(p.adjustedCost)}</td>
                  <td>{number(p.averageCost)}</td>
                  <td>
                    {number(p.quote?.price)} / {p.quote?.date ?? "行情缺失"}
                  </td>
                  <td>{number(p.floating)}</td>
                  <td>{number(p.stopDistancePct)}%</td>
                  <td>{p.adjustmentStatus}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data.positions
          .filter((p) => p.quantity > 0)
          .map((p) => (
            <form
              key={p.symbol}
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                run(async () => {
                  await updateStop(p.symbol, Number(f.get("stop")));
                  setMessage("止损位已更新，仅本地记录");
                });
              }}
            >
              <label>
                {p.symbol} 当前止损位
                <input
                  name="stop"
                  type="number"
                  step="0.01"
                  min="0.01"
                  defaultValue={p.stop ?? ""}
                  required
                />
              </label>
              <button disabled={pending}>更新止损位</button>
            </form>
          ))}
      </section>
      <section className="panel">
        <h2>除权调整依据（保留每次观察版本）</h2>
        <p>
          GBBQ不可用时：成本未按除权调整，浮盈留空。配股/缩股依据不足时留空；送转股到账日期未知时暂不计可卖，可按账户显示补录可卖日期。除权后尚无新收盘行情时浮盈留空。参考成本不可当作已核对成本。
        </p>
        {!data.adjustments.length && <p>暂无持仓期除权调整记录。</p>}
        {data.adjustments.map((a) => (
          <details key={a.id}>
            <summary>
              {a.symbol} · {a.event.date} · {a.event.name} · 成本{" "}
              {number(a.beforeCost)} → {number(a.afterCost)}
            </summary>
            <p>
              股数 {a.beforeQuantity} → {a.afterQuantity}；{a.basis}
            </p>
            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {JSON.stringify(a.event, null, 2)}
              {"\n"}
              {a.source}
            </pre>
            {(a.event.bonusRatio ?? 0) > 0 && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  run(async () => {
                    await saveBonusListing(
                      a.symbol,
                      a.event.date,
                      String(f.get("date")),
                      String(f.get("source")),
                    );
                    setMessage("送转股可卖依据已记录，不修改原交易");
                  });
                }}
              >
                <label>
                  账户确认的送转股可卖日期
                  <input
                    type="date"
                    name="date"
                    min={a.event.date}
                    max={data.today}
                    required
                  />
                </label>
                <label>
                  到账依据
                  <input name="source" maxLength={200} required />
                </label>
                <button disabled={pending}>保存可卖依据（只记录一次）</button>
              </form>
            )}
          </details>
        ))}
      </section>
      <section className="panel">
        <h2>交易日志</h2>
        {!data.trades.length && <p>暂无交易。</p>}
        {data.trades.map((t) => (
          <details key={t.id}>
            <summary>
              {t.date} · {t.symbol} · {t.side === "buy" ? "买入" : "卖出"}{" "}
              {t.quantity}股 × {t.price}
            </summary>
            <p>
              关联信号：{t.signalId ?? "无（手动交易）"}；{t.note}
            </p>
            <p>
              实验费用合计 {number(t.fees.total)}：佣金{" "}
              {number(t.fees.commission)} / 税 {number(t.fees.tax)} / 滑点{" "}
              {number(t.fees.slippage)}；{feeLabel}
            </p>
            <p>
              涨跌停 {t.lowerLimit}–{t.upperLimit}；依据：{t.limitSource}
            </p>
            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {JSON.stringify(t.methods, null, 2)}
            </pre>
          </details>
        ))}
      </section>
      <section className="panel">
        <h2>做过与没做的信号</h2>
        <p>
          按是否关联任一交易分组，比较同口径 N1
          向前收益，非实际交易盈亏、非策略业绩，不代表跟随信号的因果效果。含除权/未到期沿用台账留空规则。
        </p>
        {!data.comparison.length && <p>暂无可比较台账信号。</p>}
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                {[
                  "分组",
                  "策略/质量",
                  "期限",
                  "样本/有效",
                  "中位收益%",
                  "胜率%",
                  "留空",
                ].map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.comparison.map((c) => (
                <tr key={`${c.group}-${c.strategy}-${c.quality}-${c.horizon}`}>
                  <td>{c.group}</td>
                  <td>
                    {c.strategy} / {c.quality}
                  </td>
                  <td>T+{c.horizon}</td>
                  <td>
                    {c.samples}/{c.valid}
                  </td>
                  <td>{number(c.median)}</td>
                  <td>{number(c.winRate)}</td>
                  <td>{c.blanks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel">
        <h2>同花顺模拟盘（可选同步层）</h2>
        <details><summary>文档契约与实测契约差异</summary><table><thead><tr><th>文档契约</th><th>实测契约</th><th>差异与处理</th></tr></thead><tbody>{mockContract.map(c => <tr key={c.documented}><td>{c.documented}</td><td>{c.observed}</td><td>{c.difference}</td></tr>)}</tbody></table></details>
        <button disabled={pending || !enabled} onClick={() => run(async () => setMarkets(await readMockMarkets()))}>查看已保存市场代码（本地）</button>
        {markets.map(code => <p key={code}>{code}：{mockMarketLabel(code)}</p>)}
        <button disabled={pending || !enabled} onClick={() => run(async () => setRemoteQuery(await readMockFunds()))}>查询远程资金</button>
        <button disabled={pending || !enabled} onClick={() => run(async () => setRemoteQuery(await readMockTrades()))}>查询当日成交</button>
        {remoteQuery !== null && <pre className="overflow-auto">{JSON.stringify(remoteQuery, null, 2)}</pre>}
        <p>
          当前{enabled ? "已开启" : "关闭"}
          。关闭时不读取远程账户、不发送任何远程请求。开启本身也不开户；所有远程操作需点击。
        </p>
        <button
          disabled={pending}
          onClick={() =>
            run(async () => {
              await toggleMock(!enabled);
              setDiff(null);
              setPreview(null);
              setMessage(
                enabled ? "模拟盘已关闭" : "模拟盘已开启，尚未开户或下单",
              );
            })
          }
        >
          {enabled ? "关闭模拟盘" : "开启模拟盘"}
        </button>
        <button disabled={pending} onClick={() => run(async () => { setDiagnostics(await readMockDiagnostics()); })}>查看最近20次脱敏响应（本地）</button>
        {diagnostics && <div aria-live="polite">{diagnostics.length === 0 ? "尚无响应记录" : diagnostics.map((entry, i) => <details key={i}><summary>{entry.path} · {new Date(entry.envelope.fetchedAt).toLocaleString()} · HTTP {entry.httpStatus ?? "未收到"}</summary><pre className="overflow-auto">{JSON.stringify(entry, null, 2)}</pre></details>)}</div>}
        {enabled && (
          <>
            <p>
              开户将在第三方建立持久账户，用户名以DPAPI加密保存。服务使用HTTP。委托与本地交易互不自动覆盖。
            </p>
            <button
              disabled={pending}
              onClick={() =>
                run(async () => {
                  await createMockAccount();
                  setMessage("账户已准备，可手动对账");
                })
              }
            >
              确认创建或使用模拟账户
            </button>
            <button disabled={pending} onClick={() => run(async () => { await recoverMockAccount(); setMessage("既有账户股东账号已核验"); })}>查询既有账户股东账号（不开户）</button>
            <button
              disabled={pending}
              onClick={() =>
                run(async () => {
                  setDiff(await reconcileAccount());
                  setMessage("对账完成，未覆盖任何一侧");
                })
              }
            >
              查询远程并对账
            </button>
            <button
              disabled={pending}
              onClick={() =>
                run(async () => {
                  setPreview(await previewOrder(input()));
                  setMessage("请核对委托后点击确认；预览60秒过期");
                })
              }
            >
              用上方输入预览模拟委托
            </button>
            {preview && (
              <div role="group" aria-label="确认模拟委托">
                <p>
                  {preview.input.symbol} ·{" "}
                  {preview.input.side === "buy" ? "买入" : "卖出"} ·{" "}
                  {preview.input.quantity}股 × {preview.input.price}
                  元；确认后发送远程委托。
                </p>
                <button
                  disabled={pending}
                  onClick={() =>
                    run(async () => {
                      const id = preview.id;
                      setPreview(null);
                      setMessage(await confirmOrder(id));
                    })
                  }
                >
                  确认发送这笔模拟委托
                </button>
                <button onClick={() => setPreview(null)}>取消</button>
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
        <p>同花顺问财提供模拟炒股服务</p>
      </section>
    </main>
  );
}
