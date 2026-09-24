import { rateGate } from "../../infra/rate-gate";

/**
 * Every Eastmoney request goes through here. Eastmoney bans IPs (reported
 * 20h+ for push2/push2his) after bursty or parallel scans, so requests are
 * serialised per WAF group with spacing and a per-minute cap. The quote hosts
 * and the datacenter hosts sit behind different WAFs, so a ban on one group
 * does not pause the other.
 */
export type EmGroup = "quote" | "datacenter" | "other";

export const EM_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const COOLDOWN_MS = 10 * 60000;
const TIMEOUT_MS = 15000;

export class EastmoneyBlockedError extends Error {
  constructor(
    readonly group: EmGroup,
    readonly until: number,
    status?: number,
  ) {
    super(
      `东方财富${status ? ` HTTP ${status}` : ""}疑似限流，${new Date(until + 8 * 3600000).toISOString().slice(11, 16)} 前暂停请求`,
    );
  }
}

export function emGroup(url: string | URL): EmGroup {
  const host = new URL(url).hostname;
  if (/^push2(his|ex)?\.eastmoney\.com$/.test(host)) return "quote";
  if (/^datacenter(-web)?\.eastmoney\.com$/.test(host)) return "datacenter";
  return "other";
}

const makeGate = () =>
  rateGate({ minIntervalMs: 500, jitterMs: 500, perMinute: 60 });
const gates: Record<EmGroup, ReturnType<typeof makeGate>> = {
  quote: makeGate(),
  datacenter: makeGate(),
  other: makeGate(),
};
const cooldowns = new Map<EmGroup, number>();

/** Run `task` inside the group's gate; refuses early while the group cools down. */
export async function emThrottle<T>(
  url: string | URL,
  task: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const group = emGroup(url);
  const check = () => {
    const until = cooldowns.get(group);
    if (until && until > Date.now()) throw new EastmoneyBlockedError(group, until);
  };
  check();
  return gates[group](async () => {
    check();
    return task();
  }, signal);
}

/** Record a response status; 403/429 start the group's cooldown. */
export function emObserve(url: string | URL, status: number) {
  if (status !== 403 && status !== 429) return;
  const group = emGroup(url);
  const until = Date.now() + COOLDOWN_MS;
  cooldowns.set(group, until);
  throw new EastmoneyBlockedError(group, until, status);
}

export async function emFetch(
  url: string | URL,
  init: RequestInit = {},
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  return emThrottle(
    url,
    async () => {
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      const headers = new Headers(init.headers);
      if (!headers.has("user-agent")) headers.set("user-agent", EM_USER_AGENT);
      if (!headers.has("referer"))
        headers.set("referer", "https://quote.eastmoney.com/");
      const response = await fetcher(url, {
        ...init,
        headers,
        signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
      });
      if (response.status === 403 || response.status === 429) {
        await response.body?.cancel().catch(() => {});
        emObserve(url, response.status);
      }
      return response;
    },
    init.signal ?? undefined,
  );
}

/** Test seam. */
export function resetEastmoneyCooldowns() {
  cooldowns.clear();
}
