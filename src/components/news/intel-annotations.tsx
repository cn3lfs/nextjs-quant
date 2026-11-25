"use client";

import {
  createElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { DidFailLoadEvent, WebviewTag } from "electron";
import type { Bar } from "~/lib/domain";
import type { IntelEvent } from "~/lib/news/intel-events";
import {
  buildClsSearchUrl,
  defaultClsSearchKeyword,
} from "~/lib/news/cls-search-url";
import { usePanelVisible } from "../workbench/keep-alive";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function IntelAnnotations({
  symbol,
  name,
  render,
}: {
  symbol: string;
  name?: string | null;
  bars: readonly Bar[];
  render: (events: IntelEvent[], select: (id: string) => void) => ReactNode;
}) {
  const visible = usePanelVisible();
  const defaultKeyword = defaultClsSearchKeyword(symbol, name);
  const [keyword, setKeyword] = useState(defaultKeyword);
  const [activeKeyword, setActiveKeyword] = useState(defaultKeyword);
  const url = buildClsSearchUrl(activeKeyword);
  const [desktop, setDesktop] = useState<boolean | null>(null);
  const [expanded, setExpanded] = useState(false);
  const panelHeight = expanded ? 780 : 560;
  const webviewRef = useRef<WebviewTag>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<"loading" | "loaded" | "failed">(
    "loading",
  );
  const [history, setHistory] = useState({ back: false, forward: false });
  const [externalError, setExternalError] = useState(false);

  useEffect(() => {
    setDesktop(Boolean(window.quantDesktop?.supportsWebview));
  }, []);

  useEffect(() => {
    setKeyword(defaultKeyword);
    setActiveKeyword(defaultKeyword);
  }, [symbol, defaultKeyword]);

  useLayoutEffect(() => {
    const view = webviewRef.current;
    if (!view) return;
    setStatus("loading");
    setHistory({ back: false, forward: false });
    const start = () => setStatus("loading");
    const stop = () =>
      setStatus((current) => (current === "failed" ? "failed" : "loaded"));
    const fail = (event: DidFailLoadEvent) => {
      // Chromium cancels a superseded navigation with ERR_ABORTED.
      if (event.isMainFrame && event.errorCode !== -3) setStatus("failed");
    };
    const updateHistory = () => {
      setHistory({ back: view.canGoBack(), forward: view.canGoForward() });
    };
    view.addEventListener("did-start-loading", start);
    view.addEventListener("did-stop-loading", stop);
    view.addEventListener("did-fail-load", fail);
    view.addEventListener("dom-ready", updateHistory);
    view.addEventListener("did-navigate-in-page", updateHistory);
    return () => {
      view.removeEventListener("did-start-loading", start);
      view.removeEventListener("did-stop-loading", stop);
      view.removeEventListener("did-fail-load", fail);
      view.removeEventListener("dom-ready", updateHistory);
      view.removeEventListener("did-navigate-in-page", updateHistory);
    };
  }, [desktop, visible]);

  function search(value: string) {
    const next = value.trim();
    setKeyword(next);
    setActiveKeyword(next);
    // An article may have replaced the results for the same keyword.
    if (next === activeKeyword) {
      if (webviewRef.current) webviewRef.current.src = url;
      if (iframeRef.current) iframeRef.current.src = url;
    }
  }

  async function openExternal() {
    const opened = await window.quantDesktop
      ?.openExternalClsUrl(url)
      .catch(() => false);
    setExternalError(!opened);
  }

  return (
    <>
      {render([], () => {})}
      <section
        aria-label="图表新闻事件"
        className="space-y-2 rounded border p-3"
      >
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">图表新闻事件 · 财联社</h3>
          <form
            className="flex flex-wrap items-center gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              search(keyword);
            }}
          >
            <Input
              aria-label="财联社搜索关键词"
              className="h-8 w-36"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
            <Button size="sm" type="submit">
              搜索
            </Button>
            {(keyword !== defaultKeyword ||
              activeKeyword !== defaultKeyword) && (
              <Button
                size="sm"
                variant="ghost"
                type="button"
                onClick={() => search(defaultKeyword)}
              >
                恢复标的
              </Button>
            )}
          </form>
          {desktop === true && (
            <div className="ml-auto flex flex-wrap items-center gap-1">
              <Button
                size="sm"
                variant="outline"
                disabled={!history.back}
                onClick={() => webviewRef.current?.goBack()}
              >
                后退
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!history.forward}
                onClick={() => webviewRef.current?.goForward()}
              >
                前进
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={status === "loading"}
                onClick={() => webviewRef.current?.reload()}
              >
                刷新
              </Button>
              <Button
                size="sm"
                variant="outline"
                aria-expanded={expanded}
                onClick={() => setExpanded(!expanded)}
              >
                {expanded ? "收起" : "展开"}
              </Button>
              <Button size="sm" variant="outline" onClick={openExternal}>
                浏览器打开
              </Button>
            </div>
          )}
          {desktop === false && (
            <a
              className="ml-auto text-sm underline"
              href={url}
              target="_blank"
              rel="noreferrer"
            >
              在新标签页打开 ↗
            </a>
          )}
        </div>
        {desktop && visible && (
          <>
            {status !== "loaded" && (
              <div
                role="status"
                className="flex items-center gap-2 text-xs text-nc-text-3"
              >
                {status === "loading" ? (
                  "正在加载财联社页面…"
                ) : (
                  <>
                    财联社页面加载失败。
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => webviewRef.current?.reload()}
                    >
                      重试
                    </Button>
                  </>
                )}
              </div>
            )}
            {externalError && (
              <p role="status" className="text-xs">
                未能打开系统浏览器，请重试。
              </p>
            )}
            {createElement("webview", {
              ref: webviewRef,
              partition: "persist:cls-news",
              // Forward target="_blank" requests to the main process's deny-and-navigate handler.
              allowpopups: "true",
              src: url,
              title: "财联社搜索",
              style: { width: "100%", height: `${panelHeight}px` },
              className: "flex w-full rounded border bg-white",
            })}
          </>
        )}
        {desktop === false && visible && (
          <>
            <p className="text-xs text-nc-text-3">
              桌面客户端使用原生 WebView
              直接加载财联社页面；若浏览器拦截嵌入，请点击右上角「在新标签页打开」
            </p>
            <iframe
              ref={iframeRef}
              src={url}
              title="财联社搜索"
              height={panelHeight}
              className="block w-full rounded border bg-white"
              sandbox="allow-forms allow-scripts allow-same-origin allow-popups"
            />
          </>
        )}
      </section>
    </>
  );
}
