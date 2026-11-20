import { symbolSchema } from "trading-strategies/research/contracts/security";
import { z } from "zod";

export const DEFAULT_WATCHLIST_GROUP_ID = "default";
export const DEFAULT_WATCHLIST_GROUP_NAME = "默认自选";
export const DEFAULT_WATCHLIST_SYMBOLS = ["sh600519", "sz000001", "sz300750"];
export const MAX_WATCHLIST_GROUPS = 30;
export const MAX_WATCHLIST_SYMBOLS_PER_GROUP = 500;

export const watchlistGroupNameSchema = z
  .string()
  .trim()
  .min(1, "自选列表名称不能为空")
  .max(32, "自选列表名称不能超过 32 字");

const groupId = z.string().min(1);
const symbols = z.array(symbolSchema);
const capacityMessage = `每个自选列表最多包含 ${MAX_WATCHLIST_SYMBOLS_PER_GROUP} 个证券代码`;

export const watchlistGroupSymbolsSchema = symbols
  .transform((values) => [...new Set(values)])
  .refine(
    (values) => values.length <= MAX_WATCHLIST_SYMBOLS_PER_GROUP,
    capacityMessage,
  );

export const watchlistGroupSchema = z.object({
  id: groupId,
  name: watchlistGroupNameSchema,
  symbols: watchlistGroupSymbolsSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type WatchlistGroup = z.infer<typeof watchlistGroupSchema>;

export const watchlistGroupCreateSchema = z.object({
  name: watchlistGroupNameSchema,
  symbols: watchlistGroupSymbolsSchema.optional(),
});
export const watchlistGroupDeleteSchema = z.object({ groupId });
export const watchlistGroupRenameSchema = watchlistGroupDeleteSchema.extend({
  name: watchlistGroupNameSchema,
});
export const watchlistGroupSetSymbolsSchema = watchlistGroupDeleteSchema.extend(
  {
    symbols: watchlistGroupSymbolsSchema,
  },
);
// Keep repeated entries until the service has counted them against the group.
export const watchlistGroupAddSymbolsSchema = watchlistGroupDeleteSchema.extend(
  {
    symbols,
  },
);
export const watchlistGroupRemoveSymbolSchema =
  watchlistGroupDeleteSchema.extend({
    symbol: symbolSchema,
  });
