import { createServer } from "node:http";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// Interactive fixed-input fixture: no application server, database, model,
// market download or outgoing order. Exercise the production strategy fields.
const bundle = await build({
  stdin: {
    contents: `import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
      import {ResearchStrategyFields} from './src/components/research-strategy-fields';
      import {researchSpecSchema} from './src/lib/strategy-research';
      function Fixture(){const [spec,setSpec]=useState(()=>researchSpecSchema.parse({strategy:'dual-breakout',start:'2024-01-01',end:'2024-12-31',validationStart:'2024-10-01'}));
        const [result,setResult]=useState('');return <main className="mx-auto max-w-2xl space-y-4 p-6"><h1>策略参数固定输入验收</h1>
          <ResearchStrategyFields spec={spec} onChange={setSpec}/>
          <button onClick={()=>{const parsed=researchSpecSchema.safeParse(spec);setResult(parsed.success?JSON.stringify(parsed.data,null,2):parsed.error.issues.map(i=>i.message).join('; '))}}>核验配置</button>
          <pre id="result" className="whitespace-pre-wrap break-all">{result}</pre></main>}; createRoot(document.getElementById('root')).render(<Fixture/>);`,
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});
const css = await postcss([tailwind()]).process(
  await readFile(resolve("src/styles/globals.css"), "utf8"),
  { from: resolve("src/styles/globals.css") },
);
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>策略参数验收</title><style>${css.css}</style><div id="root"></div><script>${bundle.outputFiles[0].text}</script></html>`;
const server = createServer((req, res) => {
  if (req.method !== "GET") {
    res.writeHead(405).end();
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
});
server.listen(0, "127.0.0.1", () =>
  console.log(`http://127.0.0.1:${server.address().port}`),
);
process.on("SIGINT", () => server.close(() => process.exit(0)));
