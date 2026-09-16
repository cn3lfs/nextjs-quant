import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  knownSourceDrift,
  compareSourceDrift,
} from "../scripts/lib/source-drift";
import type { SkillInventory } from "../scripts/lib/trading-skill-inventory";
import locked from "../docs/trading-skills-source-lock.json";

const inventory = (hash: string): SkillInventory => ({
  version: "trading-skill-inventory-1",
  skills: [
    {
      id: "skill",
      sources: [{ path: "SKILL.md", hash, bytes: 1, headings: [] }],
      excluded: [],
    },
  ],
  missing: [],
  otherSkills: [],
});
const before = inventory("a".repeat(64));
const current = inventory("b".repeat(64));
const registered = [
  {
    path: "skill/SKILL.md",
    change: "changed" as const,
    hash: "b".repeat(64),
    methods: ["NW01"],
    reason: "semantic drift",
    reviewWhen: "B6",
  },
];
it("accepts only the exact path, change and current hash; empty registration requires no drift", () => {
  expect(compareSourceDrift(before, current, registered)).toEqual([]);
  expect(compareSourceDrift(before, before, [])).toEqual([]);
  expect(compareSourceDrift(before, current, [])).not.toEqual([]);
  expect(compareSourceDrift(before, before, registered)).not.toEqual([]);
  for (const value of [
    { ...registered[0]!, hash: "c".repeat(64) },
    { ...registered[0]!, path: "other/SKILL.md" },
    { ...registered[0]!, change: "added" as const },
  ])
    expect(compareSourceDrift(before, current, [value])).not.toEqual([]);
  expect(
    compareSourceDrift(before, current, [...registered, ...registered]),
  ).not.toEqual([]);
  expect(
    compareSourceDrift(
      before,
      { ...current, missing: ["x"], otherSkills: ["new"] },
      registered,
    ),
  ).toHaveLength(2);
});
it("validates the registry and detects added and removed sources", () => {
  expect(knownSourceDrift("```json\n[]\n```")).toEqual([]);
  expect(() => knownSourceDrift("no block")).toThrow();
  expect(() => knownSourceDrift('```json\n[{"path":"x"}]\n```')).toThrow();
  const empty = { ...before, skills: [] };
  expect(
    compareSourceDrift(empty, current, [
      { ...registered[0]!, change: "added" },
    ]),
  ).toEqual([]);
  expect(
    compareSourceDrift(before, empty, [
      { ...registered[0]!, change: "removed", hash: null },
    ]),
  ).toEqual([]);
});
it("preserves snapshot bytes and distinguishes unaligned observations from locked rules", () => {
  const root = "docs/trading-skills-source-snapshots/";
  const manifest = JSON.parse(readFileSync(root + "manifest.json", "utf8")) as {
    source: string;
    snapshot: string;
    status: string;
    hash: string;
    lockedHash: string | null;
    bytes: number;
  }[];
  const drift = knownSourceDrift(
    readFileSync("docs/known-source-drift.md", "utf8"),
  );
  const lockedHashes = new Map<string, string>(
    locked.skills.flatMap((skill) =>
      skill.sources.map(
        (source) => [`${skill.id}/${source.path}`, source.hash] as const,
      ),
    ),
  );
  expect(new Set(manifest.map((file) => file.source)).size).toBe(
    manifest.length,
  );
  for (const file of manifest) {
    const bytes = readFileSync(root + file.snapshot);
    expect(bytes.length).toBe(file.bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.hash);
    expect(file.lockedHash).toBe(lockedHashes.get(file.source) ?? null);
    if (file.status === "locked") expect(file.hash).toBe(file.lockedHash);
    else
      expect(drift.find((e) => e.path === file.source)?.hash).toBe(file.hash);
  }
  expect(manifest.filter((f) => f.status === "locked")).toHaveLength(21);
  expect(manifest.filter((f) => f.status === "unaligned-current")).toHaveLength(
    6,
  );
});
