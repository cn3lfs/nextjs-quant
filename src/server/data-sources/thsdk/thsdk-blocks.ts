import { z } from "zod";
import type {
  ThsdkBlockConstituentsResult,
  ThsdkConceptTag,
  ThsdkSecurityBlocksProfile,
} from "~/lib/market/thsdk-sentiment";
import {
  readThsdk,
  thsdkFailure,
  THSDK_ADAPTER_VERSION,
  type ThsdkInvoker,
} from "./thsdk-adapter";
import {
  fromThsdkSecurity,
  ThsdkError,
  toThsdkSecurity,
} from "./thsdk-contract";

const security = z.object({ code: z.string(), market: z.string() });
const index = z.object({ security: security.nullish(), name: z.string() });
const industryResult = z.object({ industry: index.nullish() });
const conceptResult = z.object({
  tags: z
    .array(
      z.object({
        concept: z.object({ name: z.string() }),
        kind: z.string().nullish(),
        score: z.number().finite().nullish().catch(null),
        order: z.number().int().nullish().catch(null),
      }),
    )
    .nullish(),
});
const memberships = z
  .array(
    z.object({
      block: z.object({ id: z.number().int().positive(), name: z.string() }),
      index: index.nullish(),
      count: z.number().int().nonnegative().nullish().catch(null),
      kind: z.string().nullish(),
    }),
  )
  .nullable();
const constituents = z
  .array(
    z.object({
      security,
      name: z.string().trim().min(1).nullish().catch(null),
    }),
  )
  .nullable();
const blockIdentity = z.object({ id: z.number().int().positive() });
const resolvedBlock = z.union([
  blockIdentity,
  z.object({ block: blockIdentity }).transform(({ block }) => block),
]);

function parse<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  raw: unknown,
): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw thsdkFailure("invalid_response");
  return result.data;
}

export async function thsdkSecurityBlocks(
  symbol: string,
  signal?: AbortSignal,
  invoke?: ThsdkInvoker,
): Promise<ThsdkSecurityBlocksProfile> {
  const params = { security: toThsdkSecurity(symbol) };
  const industryRead = readThsdk(
    "get_security_industry",
    params,
    signal,
    invoke,
  );
  // Let the first read establish authentication before starting more reads.
  const ready = industryRead.catch((error: unknown) => {
    if (!(error instanceof ThsdkError) || error.code !== "no_data") throw error;
  });
  const reads = [
    industryRead,
    ready.then(() =>
      readThsdk("get_security_concept_tags", params, signal, invoke),
    ),
    ready.then(() =>
      readThsdk("list_security_block_memberships", params, signal, invoke),
    ),
  ] as const;
  // Collect optional misses, but surface any other read failure as it arrives.
  const [[industry, tags, blocks]] = await Promise.all([
    Promise.allSettled(reads),
    Promise.all(
      reads.map((request) =>
        request.catch((error: unknown) => {
          if (!(error instanceof ThsdkError) || error.code !== "no_data")
            throw error;
        }),
      ),
    ),
  ]);
  const rawIndustry =
    industry.status === "fulfilled"
      ? parse(industryResult, industry.value).industry
      : null;
  const rawTags =
    tags.status === "fulfilled" ? parse(conceptResult, tags.value).tags : null;
  const rawBlocks =
    blocks.status === "fulfilled" ? parse(memberships, blocks.value) : null;
  const conceptTags = (rawTags ?? []).map((row): ThsdkConceptTag => ({
    name: row.concept.name,
    kind: row.kind === "bond" || row.kind === "normal" ? row.kind : "other",
    score: row.score ?? null,
    order: row.order ?? null,
  }));
  return {
    version: THSDK_ADAPTER_VERSION,
    source: "thsdk-hq",
    symbol,
    fetchedAt: Date.now(),
    industry: rawIndustry
      ? { code: rawIndustry.security?.code ?? null, name: rawIndustry.name }
      : null,
    conceptTags,
    memberships: (rawBlocks ?? []).map((row) => ({
      blockId: row.block.id,
      blockName: row.block.name,
      indexCode: row.index?.security?.code ?? null,
      count: row.count ?? null,
      kind: row.kind ?? null,
    })),
  };
}

export async function thsdkBlockConstituents(
  {
    blockId,
    blockName,
    limit,
  }: { blockId: number; blockName?: string; limit: number },
  signal?: AbortSignal,
  invoke?: ThsdkInvoker,
): Promise<ThsdkBlockConstituentsResult> {
  let constituentBlockId = blockId;
  const name = blockName?.trim();
  if (name) {
    try {
      const resolved = parse(
        resolvedBlock,
        await readThsdk("resolve_block", { name }, signal, invoke),
      );
      constituentBlockId = resolved.id;
    } catch (error) {
      if (
        !(error instanceof ThsdkError) ||
        (error.code !== "no_data" &&
          error.code !== "invalid_request" &&
          error.code !== "invalid_response")
      ) {
        throw error;
      }
    }
  }
  const raw = await readThsdk(
    "list_block_constituents",
    {
      block: { id: constituentBlockId },
      sort_begin: 0,
      sort_count: limit,
    },
    signal,
    invoke,
  );
  return {
    version: THSDK_ADAPTER_VERSION,
    source: "thsdk-hq",
    blockId,
    blockName: blockName ?? null,
    fetchedAt: Date.now(),
    // The native constituent method returns identity and name only.
    items: (parse(constituents, raw) ?? []).slice(0, limit).map((row) => ({
      symbol: fromThsdkSecurity(row.security),
      ...row.security,
      name: row.name ?? null,
      price: null,
      changePct: null,
    })),
  };
}
