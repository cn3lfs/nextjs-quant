import { poolMembersHref } from "~/lib/market/market-pool";
import type { poolCategorySchema } from "~/lib/market/market-pool";
import type { z } from "zod";

/**
 * A full navigation on purpose: the pool browser reads the deep-link parameters
 * once on mount, so a cached client-side panel would ignore a new selection.
 */
export function PoolMembersLink({
  category,
  name,
}: {
  category: z.infer<typeof poolCategorySchema>;
  name: string;
}) {
  return (
    <a
      className="text-primary underline underline-offset-2 hover:no-underline"
      href={poolMembersHref(category, name)}
      title={`查看 ${name} 的成分股`}
    >
      {name}
    </a>
  );
}
