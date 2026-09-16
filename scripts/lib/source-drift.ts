import { z } from "zod";
import {
  diffSkillInventory,
  type SkillInventory,
} from "./trading-skill-inventory";

const entry = z
  .object({
    path: z.string().min(1),
    change: z.enum(["added", "changed", "removed"]),
    hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    methods: z.array(z.string().min(1)).min(1),
    reason: z.string().min(1),
    reviewWhen: z.string().min(1),
  })
  .strict()
  .refine((v) => (v.change === "removed") === (v.hash === null));

export function knownSourceDrift(markdown: string) {
  const block = /```json\s*([\s\S]*?)```/.exec(markdown);
  if (!block) throw new Error("Missing source-drift JSON block");
  return z.array(entry).parse(JSON.parse(block[1]!));
}

/** A drifted source only threatens work that already depends on it. Matching on
 * the exact content hash proved unusable: the author keeps editing these skills,
 * so every batch failed for a re-edit of a file no implementation reads yet.
 * Match on (path, change) and gate on dependency instead — a drift is fatal when
 * any method sourcing that file is no longer `planned`, because a rule we already
 * implemented may have moved under us. Re-edits of planned-only sources surface as
 * notices, which never relaxes the rule that matters.
 */
export function compareSourceDrift(
  before: SkillInventory,
  current: SkillInventory,
  registered: ReturnType<typeof knownSourceDrift>,
  methods: readonly { id: string; status: string; sources?: string[] }[] = [],
) {
  const diff = diffSkillInventory(before, current);
  const hashes = new Map<string, string>(
    current.skills.flatMap((s) =>
      s.sources.map((f) => [`${s.id}/${f.path}`, f.hash] as const),
    ),
  );
  const dependants = new Map<string, { id: string; status: string }[]>();
  for (const method of methods)
    for (const source of method.sources ?? [])
      dependants.set(source, [
        ...(dependants.get(source) ?? []),
        { id: method.id, status: method.status },
      ]);
  const key = (path: string, change: string) => JSON.stringify([path, change]);
  const actual = (["added", "changed", "removed"] as const).flatMap((change) =>
    diff[change].map((path) => key(path, change)),
  );
  const expected = registered.map((e) => key(e.path, e.change));
  const errors: string[] = [];
  const notices: string[] = [];
  if (new Set(expected).size !== expected.length)
    errors.push("Duplicate registered source drift");
  for (const value of actual)
    if (!expected.includes(value))
      errors.push(`Unregistered source drift: ${value}`);
  for (const value of expected)
    if (!actual.includes(value))
      errors.push(`Registered source drift disappeared: ${value}`);
  for (const path of [...diff.added, ...diff.changed, ...diff.removed]) {
    const active = (dependants.get(path) ?? []).filter(
      (m) => m.status !== "planned",
    );
    if (active.length)
      errors.push(
        `Drifted source is already implemented by ${active
          .map((m) => `${m.id}(${m.status})`)
          .join(", ")}: ${path}`,
      );
  }
  for (const value of registered) {
    const now = hashes.get(value.path) ?? null;
    if (value.change !== "removed" && now !== value.hash)
      notices.push(
        `Registered source edited again since review: ${value.path} ${value.hash?.slice(0, 12)} -> ${now?.slice(0, 12)}`,
      );
    // Only the missing direction is dangerous: a dependant the registry does not
    // know about escapes review. Declaring more than the map derives is the
    // conservative direction and merely worth noting.
    const declared = new Set(value.methods);
    const derived = (dependants.get(value.path) ?? []).map((m) => m.id);
    const unknown = derived.filter((id) => !declared.has(id));
    if (unknown.length)
      errors.push(
        `Registered methods omit dependants of ${value.path}: ${unknown.sort().join(",")}`,
      );
    const extra = [...declared].filter((id) => !derived.includes(id));
    if (methods.length && extra.length)
      notices.push(
        `Registered methods exceed the method map for ${value.path}: ${extra.sort().join(",")} not attributed to this source`,
      );
  }
  errors.push(
    ...diff.missing.map((id) => `Missing skill: ${id}`),
    ...diff.newUnclassifiedSkills.map((id) => `Unclassified skill: ${id}`),
  );
  return { errors, notices };
}
