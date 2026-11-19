import { z } from "zod";
import type {
  ThsdkHotBlocksResult,
  ThsdkWencaiQueryResult,
  ThsdkWencaiRow,
  thsdkWencaiQueryInputSchema,
} from "~/lib/market/thsdk-extensions";
import {
  readThsdk,
  thsdkFailure,
  THSDK_ADAPTER_VERSION,
  type ThsdkInvoker,
} from "./thsdk-adapter";
import { fromThsdkSecurity } from "./thsdk-contract";

const security = z.object({ code: z.string(), market: z.string() });
const optionalText = z.string().trim().min(1).nullish().catch(null);
const field = z.object({
  query_key: z.string().min(1),
  index: z.number().int().nullish(),
  timestamp: optionalText,
  display_name: optionalText,
  show_name: optionalText,
  index_name: optionalText,
  unit: optionalText,
  type: optionalText,
});
const queryResult = z.object({
  fields: z.array(field).nullish(),
  securities: z.array(z.object({ security, name: optionalText })).nullish(),
  rows: z
    .array(
      z.object({
        security,
        cells: z
          .array(
            z.object({
              name: z.string(),
              key_index: z.number().int().nullish(),
              timestamp: optionalText,
              type: optionalText,
              value: z.unknown(),
            }),
          )
          .nullable(),
      }),
    )
    .nullish(),
});
const hotBlocksResult = z.object({
  items: z
    .array(
      z.object({
        block: z.object({ id: z.number().int().positive(), name: z.string() }),
        order: z.number().int().nullish().catch(null),
        rate: z.unknown(),
        tag: optionalText,
        hot_tag: optionalText,
        etf_name: optionalText,
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

function numberField(value: unknown): number | null {
  const numeric =
    typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof numeric === "number" && Number.isFinite(numeric)
    ? numeric
    : null;
}

function cellValue(
  value: unknown,
  type: string | null | undefined,
): ThsdkWencaiRow["values"][string] {
  if (
    /^(?:LONG|INT|INTEGER|FLOAT|DOUBLE|DECIMAL|NUMBER|NUMERIC)$/i.test(
      type ?? "",
    )
  )
    return numberField(value);
  if (typeof value === "number") return numberField(value);
  return typeof value === "string" || typeof value === "boolean" ? value : null;
}

export async function thsdkWencaiQuery(
  { query, markets, limit }: z.infer<typeof thsdkWencaiQueryInputSchema>,
  signal?: AbortSignal,
  invoke?: ThsdkInvoker,
): Promise<ThsdkWencaiQueryResult> {
  const raw = await readThsdk(
    "query_wencai",
    {
      query,
      ...(markets?.length ? { markets } : {}),
      limit,
    },
    signal,
    invoke,
  );
  const result = parse(queryResult, raw);
  const rawFields = result.fields ?? [];
  const keys = new Set<string>();
  const fields = rawFields.map((column, position) => {
    let key = column.query_key;
    if (keys.has(key)) {
      key = `${key}[${column.timestamp ?? column.index ?? position}]`;
      while (keys.has(key)) key += `[${position}]`;
    }
    keys.add(key);
    return {
      key,
      label:
        column.display_name ??
        column.show_name ??
        column.index_name ??
        column.query_key,
      type: column.type ?? null,
      unit: column.unit ?? null,
    };
  });
  const securityNames = new Map(
    result.securities?.map(({ security, name }) => [
      `${security.market}:${security.code}`,
      name,
    ]),
  );
  const seenIdentities = new Set<string>();
  const rows = (result.rows ?? []).map((row): ThsdkWencaiRow => {
    const identity = `${row.security.market}:${row.security.code}`;
    seenIdentities.add(identity);
    const cells = row.cells ?? [];
    const values = Object.fromEntries(
      fields.map(({ key, type }, position) => {
        const column = rawFields[position]!;
        const cell = cells.find(
          (candidate) =>
            (candidate.key_index != null && column.index != null
              ? candidate.key_index === column.index
              : candidate.name === column.query_key) &&
            (!candidate.timestamp ||
              !column.timestamp ||
              candidate.timestamp === column.timestamp),
        );
        return [key, cellValue(cell?.value, type ?? cell?.type)];
      }),
    );
    const name =
      securityNames.get(identity) ??
      optionalText.parse(cells.find((cell) => cell.name === "name")?.value) ??
      null;
    return {
      symbol: fromThsdkSecurity(row.security),
      ...row.security,
      name,
      values,
    };
  });
  for (const { security, name } of result.securities ?? []) {
    const identity = `${security.market}:${security.code}`;
    if (seenIdentities.has(identity)) continue;

    seenIdentities.add(identity);
    rows.push({
      symbol: fromThsdkSecurity(security),
      ...security,
      name: name ?? null,
      values: Object.fromEntries(fields.map(({ key }) => [key, null])),
    });
  }
  return {
    version: THSDK_ADAPTER_VERSION,
    source: "thsdk-hq",
    query,
    fetchedAt: Date.now(),
    fields,
    rows: rows.slice(0, limit),
  };
}

export async function thsdkWencaiHotBlocks(
  kind: ThsdkHotBlocksResult["kind"],
  signal?: AbortSignal,
  invoke?: ThsdkInvoker,
): Promise<ThsdkHotBlocksResult> {
  const result = parse(
    hotBlocksResult,
    await readThsdk("list_wencai_hot_blocks", { kind }, signal, invoke),
  );
  return {
    version: THSDK_ADAPTER_VERSION,
    source: "thsdk-hq",
    kind,
    fetchedAt: Date.now(),
    items: (result.items ?? []).map((row) => ({
      blockId: row.block.id,
      name: row.block.name,
      order: row.order ?? null,
      rate: numberField(row.rate),
      tag: row.tag ?? null,
      hotTag: row.hot_tag ?? null,
      etfName: row.etf_name ?? null,
    })),
  };
}
