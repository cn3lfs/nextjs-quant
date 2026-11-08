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
    bars: z.array(
      z.object({ date: z.string(), open: z.number(), close: z.number() }),
    ),
    dividends: z.array(z.object({ date: z.string(), perShare: z.number() })),
  })
  .parse(await read("input.json"));
const dataset = z
  .object({
    coverageGaps: z
      .array(z.object({ family: z.string(), needs: z.string() }))
      .default([]),
    results: z.array(
      z.object({
        strategy: z.string(),
        name: z.string(),
        definition: z
          .object({ name: z.string(), family: z.string(), rule: z.string() })
          .optional(),
        start: z.string(),
        end: z.string(),
        totalReturn: z.number(),
        cagr: z.number(),
        maxDrawdown: z.number(),
        fees: z.number(),
        finalEquity: z.number(),
        averageExposure: z.number(),
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
            holding: z.number(),
          }),
        ),
        curve: z.array(
          z.object({
            date: z.string(),
            equity: z.number(),
            dividends: z.number(),
            drawdown: z.number(),
            shares: z.number(),
            cash: z.number(),
          }),
        ),
      }),
    ),
  })
  .parse(await read("results.json"));
const results = dataset.results;
const studyCoverageGaps = dataset.coverageGaps;
const prices = new Map(input.bars.map((b) => [b.date, b.close]));
const opens = new Map(input.bars.map((b) => [b.date, b.open]));
const dividends = new Map(input.dividends.map((d) => [d.date, d.perShare]));
const closeEnough = (a: ReturnType<typeof big>, b: number) => {
  if (a.minus(b).abs().gt(0.000001))
    throw new Error(`独立账本不符：${a.toString()} / ${b}`);
};
for (const r of results) {
  let cash = big(input.initial),
    distributed = big(0),
    fees = big(0),
    shares = 0,
    peak = input.initial,
    maxDrawdown = 0;
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
      if (f.price !== opens.get(f.date))
        throw new Error("主结果不是下一日开盘零滑点成交");
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
      if (f.holding !== shares) throw new Error("成交后持仓不符");
    }
    closeEnough(
      cash.plus(big(shares).times(prices.get(row.date)!)).plus(distributed),
      row.equity,
    );
    closeEnough(distributed, row.dividends);
    closeEnough(cash, row.cash);
    if (shares !== row.shares) throw new Error("日末持仓不符");
    peak = Math.max(peak, row.equity);
    const drawdown = 1 - row.equity / peak;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
    if (Math.abs(drawdown - row.drawdown) > 1e-12)
      throw new Error("逐日回撤不符");
  }
  closeEnough(fees, r.fees);
  closeEnough(big(r.curve.at(-1)!.equity), r.finalEquity);
  if (
    Math.abs(r.finalEquity / input.initial - 1 - r.totalReturn) > 1e-12 ||
    Math.abs(maxDrawdown - r.maxDrawdown) > 1e-12
  )
    throw new Error("累计收益或最大回撤不符");
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
const colors = results.map((_, i) =>
  i < palette.length ? palette[i]! : `hsl(${(i * 137.508) % 360},65%,40%)`,
);
const pct = (v: number) => (v * 100).toFixed(2) + "%";
const table = [...results]
  .sort((a, b) => b.totalReturn - a.totalReturn)
  .map(
    (r) =>
      `<tr><td>${r.name}<br><small>${r.definition?.family ?? "历史实验"} · ${r.definition?.rule ?? "完整规则见原冻结实验规格"}</small></td><td>${pct(r.totalReturn)}</td><td>${pct(r.cagr)}</td><td>${pct(r.maxDrawdown)}</td><td>${r.fills.length}</td><td>${pct(r.averageExposure)}</td></tr>`,
  )
  .join("");
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>茅台十年策略比较</title><style>body{margin:0;background:#f7f8fb;color:#172033;font:15px "Microsoft YaHei",sans-serif}main{max-width:1360px;margin:auto;padding:28px}h1{margin:0 0 12px;font-size:25px}p{color:#536176;line-height:1.75}section{background:white;border:1px solid #e3e8ef;border-radius:12px;padding:16px;margin:16px 0}small{display:inline-block;max-width:520px;color:#536176;text-align:left;font-size:12px}button,select{padding:7px;margin:4px}#legend{display:flex;flex-wrap:wrap;gap:16px}label{cursor:pointer}#equity{height:430px}#drawdown{height:220px}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}td,th{text-align:right;padding:10px;border-bottom:1px solid #e8edf3}td:first-child,th:first-child{text-align:left}.note{font-size:13px}</style><main><h1>贵州茅台 · ${results.length - 2}项主流策略十年规则实验</h1><p>${results[0]!.start} 至 ${results[0]!.end} · 初始100万元 · 双边佣金万一/最低5元，卖出税费万五<br>主结果零额外滑点；分红隔离不复投；日线收盘决策、下一日开盘成交；100股整手、T+1。</p><section><p><button id="show-all">显示全部</button> <button id="show-original">原五策略与两项对照</button> <button id="show-none">隐藏全部</button> <select id="family"><option value="">按流派显示</option>${[
  ...new Set(results.map((r) => r.definition?.family ?? "历史实验")),
]
  .filter((f) => f !== "基准")
  .map((f) => `<option>${f}</option>`)
  .join(
    "",
  )}</select></p><div id="legend"></div><div id="equity"></div><div id="drawdown"></div></section><section><table><thead><tr><th>策略</th><th>累计收益</th><th>年化</th><th>日末最大回撤</th><th>成交笔数</th><th>平均股票敞口</th></tr></thead><tbody>${table}</tbody></table></section><section><h2>其他主流流派的数据缺口</h2>${studyCoverageGaps.map((g) => `<p><b>${g.family}</b>：${g.needs}</p>`).join("")}</section><p class="note">默认显示原五策略与两项持有对照；可按流派或逐项选择，显示全部时线条可能重叠。滚轮缩放日期；拖动查看区间。各项固定规则见下表与完整报告。网格包含长期底仓，固定锚点机动仓可能卖完后长期不再成交。历史交易状态与公司行动尚未全部独立核验，结果为规则实验，不能认证为可信策略业绩。</p><p class="note"><a href="report.md">完整报告与敏感性</a> · <a href="input.json">冻结输入</a> · <a href="manifest.json">哈希清单</a> · <a href="ledger-verification.json">独立账本核验</a></p></main><script>${library.replaceAll("</script", "<\\/script")}</script><script>
const results=${JSON.stringify(results.map((r) => ({ name: r.name, strategy: r.strategy, curve: r.curve, family: r.definition?.family ?? "历史实验", rule: r.definition?.rule ?? "完整规则见原冻结实验规格" }))).replaceAll("<", "\\u003c")};
const colors=${JSON.stringify(colors)};
const opts={autoSize:true,layout:{textColor:'#334155',background:{type:'solid',color:'#ffffff'}},grid:{vertLines:{color:'#eef1f5'},horzLines:{color:'#eef1f5'}},rightPriceScale:{borderColor:'#e3e8ef'},timeScale:{borderColor:'#e3e8ef'},localization:{locale:'zh-CN'}};
const equity=LightweightCharts.createChart(document.getElementById('equity'),opts),dd=LightweightCharts.createChart(document.getElementById('drawdown'),opts);
let syncing=false;for(const [from,to] of [[equity,dd],[dd,equity]])from.timeScale().subscribeVisibleLogicalRangeChange(range=>{if(range&&!syncing){syncing=true;to.timeScale().setVisibleLogicalRange(range);syncing=false;}});
const toggles=[];results.forEach((r,i)=>{const original=['ma','breakout','pullback','range','grid','hold','hold80'].includes(r.strategy);const settings={visible:original,color:colors[i],lineWidth:2,title:r.name,lineStyle:r.strategy.startsWith('hold')?2:0,priceLineVisible:false,lastValueVisible:false};const top=equity.addSeries(LightweightCharts.LineSeries,settings),bottom=dd.addSeries(LightweightCharts.LineSeries,{...settings,priceFormat:{type:'percent'}});top.setData(r.curve.map(p=>({time:p.date,value:p.equity/1000000})));bottom.setData(r.curve.map(p=>({time:p.date,value:-p.drawdown*100})));const label=document.createElement('label'),checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=original;checkbox.addEventListener('change',()=>{top.applyOptions({visible:checkbox.checked});bottom.applyOptions({visible:checkbox.checked});});toggles.push({checkbox,top,bottom,r});label.title=r.rule;label.style.color=colors[i];label.append(checkbox,document.createTextNode(' '+r.name));document.getElementById('legend').append(label);});function select(predicate){toggles.forEach(({checkbox,top,bottom,r})=>{checkbox.checked=predicate(r);top.applyOptions({visible:checkbox.checked});bottom.applyOptions({visible:checkbox.checked});});}document.getElementById('show-all').onclick=()=>select(()=>true);document.getElementById('show-none').onclick=()=>select(()=>false);document.getElementById('show-original').onclick=()=>select(r=>['ma','breakout','pullback','range','grid','hold','hold80'].includes(r.strategy));document.getElementById('family').onchange=e=>{if(e.target.value)select(r=>r.family===e.target.value||r.family==='基准');};equity.timeScale().fitContent();dd.timeScale().fitContent();window.studyReady=true;
</script></html>`;
await writeFile(join(dir, "report.html"), html);
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1250 },
    deviceScaleFactor: 1,
  });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(pathToFileURL(join(dir, "report.html")).href);
  await page.waitForFunction(() =>
    Boolean((window as unknown as { studyReady?: boolean }).studyReady),
  );
  const toggles = page.locator('input[type="checkbox"]');
  if ((await toggles.count()) !== results.length)
    throw new Error("策略显隐控件缺失");
  await toggles.first().uncheck();
  await toggles.first().check();
  await page.locator("#show-all").click();
  if (
    (await page.locator('input[type="checkbox"]:checked').count()) !==
    results.length
  )
    throw new Error("全选失败");
  await page.locator("#show-original").click();
  if ((await page.locator('input[type="checkbox"]:checked').count()) !== 7)
    throw new Error("原策略对照失败");
  await page.locator("#show-none").click();
  if ((await page.locator('input[type="checkbox"]:checked').count()) !== 0)
    throw new Error("隐藏全部失败");
  const families = [
    ...new Set(
      results.map((r) => r.definition?.family).filter((f) => f && f !== "基准"),
    ),
  ];
  for (const family of families) {
    await page.locator("#family").selectOption(family!);
    const expected = results.filter(
      (r) => r.definition?.family === family || r.definition?.family === "基准",
    ).length;
    if (
      (await page.locator('input[type="checkbox"]:checked').count()) !==
      expected
    )
      throw new Error(`流派筛选失败：${family}`);
  }
  await page.locator("#show-original").click();
  await page.screenshot({ path: join(dir, "equity.png"), fullPage: true });
  await page
    .locator("section")
    .first()
    .screenshot({ path: join(dir, "comparison.png") });
  if (pageErrors.length)
    throw new Error(`报告页面错误：${pageErrors.join("; ")}`);
} finally {
  await browser.close();
}
const digest = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
await writeFile(
  join(dir, "report-manifest.json"),
  JSON.stringify(
    {
      resultHash: manifest.resultHash,
      exporterHash: await digest(resolve("scripts/export-classic-study.ts")),
      chartLibraryHash: await digest(
        resolve(
          "node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js",
        ),
      ),
      htmlHash: await digest(join(dir, "report.html")),
      browserChecks: {
        passed: true,
        strategyToggles: results.length,
        allNoneOriginalAndFamilies: true,
      },
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    verified: true,
    strategies: results.length,
    html: join(dir, "report.html"),
    chart: join(dir, "equity.png"),
  }),
);
