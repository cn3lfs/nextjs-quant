import { poolMembersHref } from "~/lib/market/market-pool";
import type { poolCategorySchema } from "~/lib/market/market-pool";
import type { z } from "zod";
import Link from "next/link";

/**
 * The destination reads the current URL, so client navigation updates membership.
 */
export function PoolMembersLink({
  category,
  name,
  label = name,
}: {
  category: z.infer<typeof poolCategorySchema>;
  name: string;
  /** Optional shorter link text while the target stays the full pool name. */
  label?: string;
}) {
  return (
    <Link
      className="text-primary underline underline-offset-2 hover:no-underline"
      href={poolMembersHref(category, name)}
      title={`查看 ${name} 的成分股`}
    >
      {label}
    </Link>
  );
}
