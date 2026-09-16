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

export function compareSourceDrift(
  before: SkillInventory,
  current: SkillInventory,
  registered: ReturnType<typeof knownSourceDrift>,
) {
  const diff = diffSkillInventory(before, current);
  const hashes = new Map(
    current.skills.flatMap((s) =>
      s.sources.map((f) => [`${s.id}/${f.path}`, f.hash] as const),
    ),
  );
  const key = (path: string, change: string, hash: string | null) =>
    JSON.stringify([path, change, hash]);
  const actual = (["added", "changed", "removed"] as const).flatMap((change) =>
    diff[change].map((path) => key(path, change, hashes.get(path) ?? null)),
  );
  const expected = registered.map((e) => key(e.path, e.change, e.hash));
  const errors: string[] = [];
  if (new Set(expected).size !== expected.length)
    errors.push("Duplicate registered source drift");
  for (const value of actual)
    if (!expected.includes(value))
      errors.push(`Unregistered source drift: ${value}`);
  for (const value of expected)
    if (!actual.includes(value))
      errors.push(`Registered source drift disappeared: ${value}`);
  errors.push(
    ...diff.missing.map((id) => `Missing skill: ${id}`),
    ...diff.newUnclassifiedSkills.map((id) => `Unclassified skill: ${id}`),
  );
  return errors;
}
