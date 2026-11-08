import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { big } from "trading-strategy-core/money";
import { z } from "zod";

if (process.argv.length !== 4 || process.argv[2] !== "--dir")
  throw new Error("使用 --dir 研究目录");
const dir = resolve(process.argv[3]!);
const read = async (name: string) =>
  JSON.parse(await readFile(join(dir, name), "utf8")) as unknown;
const manifest = z
  .object({ inputHash: z.string(), resultHash: z.string() })
  .parse(await read("manifest.json"));
for (const [name, expected] of [
  ["input.json", manifest.inputHash],
  ["results.json", manifest.resultHash],
]) {
  const actual = createHash("sha256")
    .update(await readFile(join(dir, name!)))
    .digest("hex");
  if (actual !== expected) throw new Error(`输入/结果哈希不符：${name}`);
}
const input = z
  .object({
    initial: z.number(),
    bars: z.array(z.object({ date: z.string(), close: z.number() })),
    dividends: z.array(z.object({ date: z.string(), perShare: z.number() })),
  })
  .parse(await read("input.json"));
const results = z
  .object({
    results: z.array(
      z.object({
        strategy: z.string(),
        name: z.string(),
        start: z.string(),
        end: z.string(),
        totalReturn: z.number(),
        cagr: z.number(),
        maxDrawdown: z.number(),
        fees: z.number(),
        coreShares: z.number(),
        fills: z.array(
          z.object({
            signalDate: z.string(),
            date: z.string(),
            side: z.enum(["buy", "sell"]),
            price: z.number(),
            shares: z.number(),
            fee: z.number(),
            cash: z.number(),
          }),
        ),
        curve: z.array(
          z.object({
            date: z.string(),
            equity: z.number(),
            dividends: z.number(),
            drawdown: z.number(),
          }),
        ),
      }),
    ),
  })
  .parse(await read("results.json")).results;
const prices = new Map(input.bars.map((b) => [b.date, b.close]));
const dividends = new Map(input.dividends.map((d) => [d.date, d.perShare]));
const closeEnough = (a: ReturnType<typeof big>, b: number) => {
  if (a.minus(b).abs().gt(0.000001))
    throw new Error(`独立账本不符：${a.toString()} / ${b}`);
};
for (const r of results) {
  let cash = big(input.initial),
    distributed = big(0),
    fees = big(0),
    shares = 0;
  const fills = new Map(r.fills.map((f) => [f.date, f]));
  if (fills.size !== r.fills.length) throw new Error("同日多笔成交");
  for (const row of r.curve) {
    distributed = distributed.plus(
      big(dividends.get(row.date) ?? 0).times(shares),
    );
    const f = fills.get(row.date);
    if (f) {
      if (f.signalDate >= f.date || f.shares <= 0 || f.shares % 100 !== 0)
        throw new Error("成交时序或整手错误");
      const amount = big(f.price).times(f.shares),
        commission = amount.times(0.0001),
        fee = (commission.gt(5) ? commission : big(5)).plus(
          f.side === "sell" ? amount.times(0.0005) : 0,
        );
      closeEnough(fee, f.fee);
      fees = fees.plus(fee);
      cash = cash.plus(f.side === "buy" ? amount.neg() : amount).minus(fee);
      shares += f.side === "buy" ? f.shares : -f.shares;
      if (
        cash.lt(0) ||
        shares < 0 ||
        (r.strategy === "grid" && shares < r.coreShares)
      )
        throw new Error("资金或持股约束错误");
      closeEnough(cash, f.cash);
    }
    closeEnough(
      cash.plus(big(shares).times(prices.get(row.date)!)).plus(distributed),
      row.equity,
    );
    closeEnough(distributed, row.dividends);
  }
  closeEnough(fees, r.fees);
}
await writeFile(
  join(dir, "ledger-verification.json"),
  JSON.stringify(
    {
      passed: true,
      implementation:
        "TypeScript independent fill ledger with decimal arithmetic",
      strategies: results.length,
      dailyValuations: results.reduce((s, r) => s + r.curve.length, 0),
    },
    null,
    2,
  ),
);
const library = await readFile(
  resolve(
    "node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js",
  ),
  "utf8",
);
const palette = [
  "#2563eb",
  "#d97706",
  "#059669",
  "#dc2626",
  "#7c3aed",
  "#475569",
  "#db2777",
];
const pct = (v: number) => (v * 100).toFixed(2) + "%";
const table = results
  .map(
    (r) =>
      `<tr><td>${r.name}</td><td>${pct(r.totalReturn)}</td><td>${pct(r.cagr)}</td><td>${pct(r.maxDrawdown)}</td><td>${r.fills.length}</td></tr>`,
  )
  .join("");
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>茅台十年策略比较</title><style>body{margin:0;background:#f7f8fb;color:#172033;font:15px "Microsoft YaHei",sans-serif}main{max-width:1360px;margin:auto;padding:28px}h1{margin:0 0 12px;font-size:25px}p{color:#536176;line-height:1.75}section{background:white;border:1px solid #e3e8ef;border-radius:12px;padding:16px;margin:16px 0}#legend{display:flex;flex-wrap:wrap;gap:16px}label{cursor:pointer}#equity{height:430px}#drawdown{height:220px}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}td,th{text-align:right;padding:10px;border-bottom:1px solid #e8edf3}td:first-child,th:first-child{text-align:left}.note{font-size:13px}</style><main><h1>贵州茅台 · 五类策略十年规则实验</h1><p>${results[0]!.start} 至 ${results[0]!.end} · 初始100万元 · 双边佣金万一/最低5元，卖出税费万五<br>主结果零额外滑点；分红隔离不复投；日线收盘决策、下一日开盘成交；100股整手、T+1。</p><section><div id="legend"></div><div id="equity"></div><div id="drawdown"></div></section><section><table><thead><tr><th>策略</th><th>累计收益</th><th>年化</th><th>日末最大回撤</th><th>成交笔数</th></tr></thead><tbody>${table}</tbody></table></section><p class="note">点击策略复选框切换显隐；滚轮缩放日期；拖动查看区间。网格包含长期底仓，固定锚点机动仓可能卖完后长期不再成交。历史交易状态与公司行动尚未全部独立核验，结果为规则实验，不能认证为可信策略业绩。</p><p class="note"><a href="report.md">完整报告与敏感性</a> · <a href="input.json">冻结输入</a> · <a href="manifest.json">哈希清单</a> · <a href="ledger-verification.json">独立账本核验</a></p></main><script>${library.replaceAll("</script", "<\\/script")}</script><script>
const results=${JSON.stringify(results.map((r) => ({ name: r.name, strategy: r.strategy, curve: r.curve }))).replaceAll("<", "\\u003c")};
const colors=${JSON.stringify(palette)};
const opts={autoSize:true,layout:{textColor:'#334155',background:{type:'solid',color:'#ffffff'}},grid:{vertLines:{color:'#eef1f5'},horzLines:{color:'#eef1f5'}},rightPriceScale:{borderColor:'#e3e8ef'},timeScale:{borderColor:'#e3e8ef'},localization:{locale:'zh-CN'}};
const equity=LightweightCharts.createChart(document.getElementById('equity'),opts),dd=LightweightCharts.createChart(document.getElementById('drawdown'),opts);
let syncing=false;for(const [from,to] of [[equity,dd],[dd,equity]])from.timeScale().subscribeVisibleLogicalRangeChange(range=>{if(range&&!syncing){syncing=true;to.timeScale().setVisibleLogicalRange(range);syncing=false;}});
results.forEach((r,i)=>{const settings={color:colors[i],lineWidth:2,title:r.name,lineStyle:r.strategy.startsWith('hold')?2:0,priceLineVisible:false,lastValueVisible:false};const top=equity.addSeries(LightweightCharts.LineSeries,settings),bottom=dd.addSeries(LightweightCharts.LineSeries,{...settings,priceFormat:{type:'percent'}});top.setData(r.curve.map(p=>({time:p.date,value:p.equity/1000000})));bottom.setData(r.curve.map(p=>({time:p.date,value:-p.drawdown*100})));const label=document.createElement('label'),checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=true;checkbox.addEventListener('change',()=>{top.applyOptions({visible:checkbox.checked});bottom.applyOptions({visible:checkbox.checked});});label.style.color=colors[i];label.append(checkbox,document.createTextNode(' '+r.name));document.getElementById('legend').append(label);});equity.timeScale().fitContent();dd.timeScale().fitContent();window.studyReady=true;
</script></html>`;
await writeFile(join(dir, "report.html"), html);
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1250 },
    deviceScaleFactor: 1,
  });
  await page.goto(pathToFileURL(join(dir, "report.html")).href);
  await page.waitForFunction(() =>
    Boolean((window as unknown as { studyReady?: boolean }).studyReady),
  );
  const toggles = page.locator('input[type="checkbox"]');
  if ((await toggles.count()) !== 7) throw new Error("策略显隐控件缺失");
  await toggles.first().uncheck();
  await toggles.first().check();
  await page.screenshot({ path: join(dir, "equity.png"), fullPage: true });
} finally {
  await browser.close();
}
console.log(
  JSON.stringify({
    verified: true,
    strategies: results.length,
    html: join(dir, "report.html"),
    chart: join(dir, "equity.png"),
  }),
);
