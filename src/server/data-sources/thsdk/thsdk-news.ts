import { z } from "zod";
import type {
  ThsdkNewsFlashResult,
  ThsdkResearchReportsResult,
  thsdkNewsFlashInputSchema,
} from "~/lib/market/thsdk-extensions";
import {
  readThsdk,
  thsdkFailure,
  THSDK_ADAPTER_VERSION,
  type ThsdkInvoker,
} from "./thsdk-adapter";
import { toThsdkSecurity } from "./thsdk-contract";

const optionalText = z.string().trim().min(1).nullish().catch(null);
const flashResponse = z.object({
  total: z.unknown(),
  filters: z.array(z.object({ id: z.string(), name: z.string() })).nullish(),
  items: z
    .array(
      z.object({
        id: z.string().min(1),
        seq: optionalText,
        title: z.string().min(1),
        digest: optionalText,
        url: optionalText,
        tags: z.array(z.object({ name: z.string() })).nullish(),
        tag: optionalText,
        ctime: z.unknown(),
        import: optionalText,
      }),
    )
    .nullable(),
});
const researchResponse = z.object({
  items: z
    .array(
      z.object({
        item_id: optionalText,
        time: optionalText,
        published_at: optionalText,
        title: z.string().min(1),
        url: optionalText,
        abstract: optionalText,
        org: optionalText,
        researcher: optionalText,
      }),
    )
    .nullable(),
});

function parse<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  raw: unknown,
): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw thsdkFailure("invalid_response");
  return result.data;
}

function nonnegativeInteger(value: unknown): number | null {
  const numeric =
    typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value)
      : value;
  return typeof numeric === "number" &&
    Number.isSafeInteger(numeric) &&
    numeric >= 0
    ? numeric
    : null;
}

function httpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export async function thsdkNewsFlash(
  { page, pageSize, tag }: z.infer<typeof thsdkNewsFlashInputSchema>,
  signal?: AbortSignal,
  invoke?: ThsdkInvoker,
): Promise<ThsdkNewsFlashResult> {
  const raw = await readThsdk(
    "list_news_flash_items",
    {
      traversal: "page",
      page,
      page_size: pageSize,
      ...(tag ? { tag } : {}),
    },
    signal,
    invoke,
  );
  const result = parse(flashResponse, raw);
  return {
    version: THSDK_ADAPTER_VERSION,
    source: "thsdk-hq",
    page,
    pageSize,
    total: nonnegativeInteger(result.total),
    fetchedAt: Date.now(),
    filters: result.filters ?? [],
    items: (result.items ?? []).map((row) => {
      const seconds = nonnegativeInteger(row.ctime);
      return {
        id: row.id,
        seq: row.seq ?? null,
        title: row.title,
        digest: row.digest ?? null,
        url: httpUrl(row.url),
        tags:
          row.tags?.map(({ name }) => name) ??
          row.tag
            ?.split(",")
            .map((name) => name.trim())
            .filter(Boolean) ??
          [],
        publishedAt:
          seconds !== null && seconds <= 8_640_000_000_000
            ? seconds * 1000
            : null,
        important: row.import === "1",
      };
    }),
  };
}

export async function thsdkResearchReports(
  symbol: string,
  signal?: AbortSignal,
  invoke?: ThsdkInvoker,
): Promise<ThsdkResearchReportsResult> {
  const raw = await readThsdk(
    "list_security_research_reports",
    {
      security: toThsdkSecurity(symbol),
      traversal: { mode: "page" },
    },
    signal,
    invoke,
  );
  const result = parse(researchResponse, raw);
  return {
    version: THSDK_ADAPTER_VERSION,
    source: "thsdk-hq",
    symbol,
    fetchedAt: Date.now(),
    items: (result.items ?? []).map((row) => {
      const publishedAt = row.published_at ?? row.time ?? null;
      const url = httpUrl(row.url);
      return {
        id:
          row.item_id ??
          url ??
          JSON.stringify([row.title, publishedAt, row.org ?? null]),
        title: row.title,
        publishedAt,
        org: row.org ?? null,
        researcher: row.researcher ?? null,
        abstract: row.abstract ?? null,
        url,
      };
    }),
  };
}
