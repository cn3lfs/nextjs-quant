import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from "undici";
import { socksDispatcher } from "fetch-socks";
import { settings } from "./settings";

/**
 * Outbound HTTP for overseas sources: try a direct connection first and fall
 * back to the configured proxy only when the direct route fails. The route that
 * worked is remembered per host for ten minutes, then direct is retried.
 */
export type OutboundRoute = "direct" | "proxy";
export type OutboundResult = { response: Response; route: OutboundRoute };

const DIRECT_TIMEOUT_MS = 3000;
const REQUEST_TIMEOUT_MS = 15000;
const ROUTE_TTL_MS = 10 * 60000;

const routes = new Map<string, { route: OutboundRoute; at: number }>();
const dispatchers = new Map<string, Dispatcher>();

/** Undici dispatcher for `socks5://`, `socks4://` or `http(s)://` proxies. */
export function proxyDispatcher(address: string): Dispatcher {
  const cached = dispatchers.get(address);
  if (cached) return cached;
  const url = new URL(address);
  const dispatcher = url.protocol.startsWith("socks")
    ? socksDispatcher({
        type: url.protocol.startsWith("socks4") ? 4 : 5,
        host: url.hostname,
        port: Number(url.port || 1080),
        ...(url.username
          ? {
              userId: decodeURIComponent(url.username),
              password: decodeURIComponent(url.password),
            }
          : {}),
      })
    : new ProxyAgent(address);
  dispatchers.set(address, dispatcher);
  return dispatcher;
}

type Fetcher = (
  url: string,
  init: RequestInit & { dispatcher?: Dispatcher },
) => Promise<Response>;

/** Test seam: the clock, fetch implementation and proxy address are injectable. */
export type OutboundOptions = {
  now?: () => number;
  fetcher?: Fetcher;
  proxy?: string;
  directTimeoutMs?: number;
  /** Direct responses with these statuses count as a failed direct route
   *  (e.g. Yahoo answers 403 to mainland IPs) and are retried via the proxy. */
  proxyOnStatus?: readonly number[];
};

const defaultFetcher: Fetcher = (url, init) =>
  undiciFetch(
    url,
    init as Parameters<typeof undiciFetch>[1],
  ) as unknown as Promise<Response>;

function withTimeout(init: RequestInit, ms: number) {
  const timeout = AbortSignal.timeout(ms);
  return {
    ...init,
    signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
  };
}

export async function outboundFetch(
  url: string,
  init: RequestInit = {},
  options: OutboundOptions = {},
): Promise<OutboundResult> {
  const now = options.now ?? Date.now;
  const fetcher = options.fetcher ?? defaultFetcher;
  const proxy = options.proxy ?? settings().outboundProxy;
  const host = new URL(url).host;
  const remembered = routes.get(host);
  const preferProxy =
    !!proxy &&
    remembered?.route === "proxy" &&
    now() - remembered.at < ROUTE_TTL_MS;
  const viaProxy = async () => {
    const response = await fetcher(url, {
      ...withTimeout(init, REQUEST_TIMEOUT_MS),
      dispatcher: proxyDispatcher(proxy),
    });
    routes.set(host, { route: "proxy", at: now() });
    return { response, route: "proxy" as const };
  };
  if (preferProxy) return viaProxy();
  // The short limit covers connecting and headers only; the body may stream
  // for as long as the request timeout allows.
  const probe = new AbortController();
  const timer = setTimeout(
    () => probe.abort(new Error("直连超时")),
    remembered?.route === "direct"
      ? REQUEST_TIMEOUT_MS
      : (options.directTimeoutMs ?? DIRECT_TIMEOUT_MS),
  );
  try {
    const base = withTimeout(init, REQUEST_TIMEOUT_MS);
    const response = await fetcher(url, {
      ...base,
      signal: AbortSignal.any([base.signal, probe.signal]),
    });
    clearTimeout(timer);
    if (proxy && options.proxyOnStatus?.includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`直连 HTTP ${response.status}`);
    }
    routes.set(host, { route: "direct", at: now() });
    return { response, route: "direct" };
  } catch (error) {
    clearTimeout(timer);
    if (init.signal?.aborted || !proxy) throw error;
    try {
      return await viaProxy();
    } catch (proxyError) {
      throw new Error(
        `直连失败（${error instanceof Error ? error.message : "未知错误"}），代理 ${proxy} 也失败（${proxyError instanceof Error ? proxyError.message : "未知错误"}）`,
      );
    }
  }
}

export const routeLabel = (route: OutboundRoute) =>
  route === "direct" ? "直连" : "经代理";

/** Forget remembered routes (settings change, tests). */
export function resetOutboundRoutes() {
  routes.clear();
}
