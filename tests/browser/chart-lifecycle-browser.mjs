/** Real canvas and drawing primitives; observe lifecycle without replacing them. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { chromium } from "@playwright/test";

const bundle = await build({
  stdin: {
    contents: `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {MarketChart} from './src/components/market/chart';
import {defaultChartView,drawingSchema} from './src/lib/chart/chart-view';
import {createCrosshairLink} from './src/lib/chart/crosshair-link';
const bars=Array.from({length:1800},(_,i)=>({date:new Date(Date.UTC(2020,0,i+1)).toISOString().slice(0,10),open:100+i/100,close:101+i/100,high:103+i/100,low:98+i/100,volume:1000,amount:100000}));
const anchor={date:bars.at(-5).date,price:117};const shared=[drawingSchema.parse({id:'77777777-7777-4777-8777-777777777777',kind:'horizontal',a:anchor,b:anchor,color:'#e87d23'})];
const hub=createCrosshairLink();const subscribe=hub.subscribe;window.links=0;
hub.subscribe=listener=>{window.links++;const off=subscribe(listener);return()=>{window.links--;off()}};
const link={id:'primary',hub};window.hub=hub;
function App(){const [mounted,setMounted]=useState(true),[precision,setPrecision]=useState(2),[data,setData]=useState(bars),[view,setView]=useState({...defaultChartView,subchart:['volume']}),[key,setKey]=useState('lifecycle-a');
window.controls={mount:value=>flushSync(()=>setMounted(value)),precision:value=>flushSync(()=>setPrecision(value)),data:()=>flushSync(()=>setData(bars.map(bar=>({...bar,close:bar.close+1})))),view:update=>flushSync(()=>setView(update)),key:value=>flushSync(()=>setKey(value))};
return mounted?<MarketChart bars={data} period='day' height={500} pricePrecision={precision} sharedDrawings={shared} view={view} onViewChange={setView} link={link} viewportKey={key} hotkeys/>:<div>unmounted</div>}
createRoot(document.getElementById('root')).render(<App/>);`,
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  jsx: "automatic",
  format: "iife",
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    {
      name: "observe-drawings",
      setup(b) {
        b.onResolve({ filter: /^~\/lib\/chart\/chart-drawings$/ }, () => ({
          path: "drawings",
          namespace: "probe",
        }));
        b.onLoad({ filter: /.*/, namespace: "probe" }, () => ({
          loader: "js",
          resolveDir: process.cwd(),
          contents: `
import {attachDrawings as actual} from './src/lib/chart/chart-drawings';
export * from './src/lib/chart/chart-drawings';
window.drawingUpdates=[];window.drawingLayers=[];
export function attachDrawings(...args){
 const update=actual(...args);window.drawingLayers.push(update);
 return Object.assign((...values)=>{window.drawingUpdates.push({ids:Array.isArray(values[0])?values[0].map(d=>d.id):[],preview:args[5]===true});return update(...values)},update);
}`,
        }));
      },
    },
  ],
});
const server = createServer((req, res) => {
  res.setHeader(
    "content-type",
    req.url === "/bundle.js" ? "text/javascript" : "text/html;charset=utf-8",
  );
  res.end(
    req.url === "/bundle.js"
      ? bundle.outputFiles[0].text
      : '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script>',
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.listeners = [];
    const add = window.addEventListener.bind(window),
      remove = window.removeEventListener.bind(window);
    const tracked = new Set([
      "pointermove",
      "pointerup",
      "pointercancel",
      "keydown",
    ]);
    window.addEventListener = (type, listener, options) => {
      const capture =
        typeof options === "boolean" ? options : !!options?.capture;
      // Playwright also installs a hit-target interceptor. Observe application-owned listeners only.
      const stack = new Error().stack ?? "";
      if (
        stack.includes("/bundle.js:") &&
        tracked.has(type) &&
        !window.listeners.some(
          (item) =>
            item.type === type &&
            item.listener === listener &&
            item.capture === capture,
        )
      )
        window.listeners.push({ type, listener, capture, stack });
      return add(type, listener, options);
    };
    window.removeEventListener = (type, listener, options) => {
      const capture =
        typeof options === "boolean" ? options : !!options?.capture;
      window.listeners = window.listeners.filter(
        (item) =>
          !(
            item.type === type &&
            item.listener === listener &&
            item.capture === capture
          ),
      );
      return remove(type, listener, options);
    };
    window.observers = [];
    const Original = window.ResizeObserver;
    window.ResizeObserver = class extends Original {
      constructor(callback) {
        super(callback);
        this.targets = new Set();
        window.observers.push(this);
      }
      observe(target, options) {
        this.targets.add(target);
        super.observe(target, options);
      }
      unobserve(target) {
        this.targets.delete(target);
        super.unobserve(target);
      }
      disconnect() {
        this.targets.clear();
        super.disconnect();
      }
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const paint = () =>
    page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
  await page.waitForFunction(() =>
    window.drawingUpdates?.some((update) =>
      update.ids.includes("77777777-7777-4777-8777-777777777777"),
    ),
  );
  await paint();
  assert.ok(
    await page.evaluate(() =>
      window.drawingLayers.some((layer) =>
        layer
          .geometries()
          .some(
            (item) =>
              item.id === "77777777-7777-4777-8777-777777777777" &&
              item.geometry,
          ),
      ),
    ),
    "shared drawing has real canvas geometry",
  );
  assert.equal(await page.evaluate(() => window.links), 1);
  assert.ok(await page.evaluate(() => window.listeners.length >= 4));
  const originalListeners = await page.evaluate(() => window.listeners.length);
  await page.evaluate(() => {
    window.originalCanvas = document.querySelector("canvas");
    window.drawingUpdates.length = 0;
    window.drawingLayers.length = 0;
    window.controls.precision(4);
  });
  await paint();
  assert.equal(
    await page.evaluate(
      () => window.originalCanvas === document.querySelector("canvas"),
    ),
    false,
    "price precision rebuilds the canvas",
  );
  assert.ok(
    await page.evaluate(() =>
      window.drawingUpdates.some((update) =>
        update.ids.includes("77777777-7777-4777-8777-777777777777"),
      ),
    ),
    "shared drawings must be restored after precision rebuild",
  );
  assert.ok(
    await page.evaluate(() =>
      window.drawingLayers.some((layer) =>
        layer
          .geometries()
          .some(
            (item) =>
              item.id === "77777777-7777-4777-8777-777777777777" &&
              item.geometry,
          ),
      ),
    ),
    "restored shared drawing has real canvas geometry",
  );
  assert.equal(
    await page.evaluate(() => window.listeners.length),
    originalListeners,
    "rebuild must not accumulate listeners",
  );
  await page.evaluate(() => {
    window.originalCanvas = document.querySelector("canvas");
    window.controls.data();
    window.controls.view((view) => ({
      ...view,
      subchart: ["volume", "rps"],
      dark: true,
    }));
  });
  await paint();
  assert.equal(
    await page.evaluate(
      () => window.originalCanvas === document.querySelector("canvas"),
    ),
    true,
    "data, theme and pane updates must reuse the canvas",
  );
  await page.evaluate(() => window.controls.key("lifecycle-b"));
  await paint();
  assert.equal(
    await page.evaluate(() => window.listeners.length),
    originalListeners,
  );
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.controls.mount(false));
    await paint();
    assert.equal(await page.locator("canvas").count(), 0);
    assert.equal(
      await page.evaluate(() => window.links),
      0,
      "unmount must release the crosshair subscription",
    );
    assert.deepEqual(
      await page.evaluate(() =>
        window.listeners.map((item) => ({
          type: item.type,
          name: item.listener.name,
          source: String(item.listener).slice(0, 150),
          stack: item.stack,
        })),
      ),
      [],
      "unmount must release window listeners",
    );
    assert.equal(
      await page.evaluate(() =>
        window.observers.reduce(
          (sum, observer) => sum + observer.targets.size,
          0,
        ),
      ),
      0,
      "unmount must release resize observations",
    );
    await page.keyboard.press("ArrowLeft");
    await page.evaluate(() => window.hub.publish("secondary", null));
    await page.evaluate(() => window.controls.mount(true));
    await paint();
    assert.equal(await page.evaluate(() => window.links), 1);
    assert.equal(
      await page.evaluate(() => window.listeners.length),
      originalListeners,
    );
  }
  assert.deepEqual(errors, []);
  console.log(
    "PASS: shared drawings on precision rebuild, in-place data/pane/theme updates, viewport identity rebuild, repeated unmount releases listeners/observers/crosshair link",
  );
} finally {
  await browser?.close();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
