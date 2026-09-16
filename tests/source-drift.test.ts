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
const errors = (...args: Parameters<typeof compareSourceDrift>) =>
  compareSourceDrift(...args).errors;

it("accepts the registered path and change; empty registration requires no drift", () => {
  expect(errors(before, current, registered)).toEqual([]);
  expect(errors(before, before, [])).toEqual([]);
  expect(errors(before, current, [])).not.toEqual([]);
  expect(errors(before, before, registered)).not.toEqual([]);
  for (const value of [
    { ...registered[0]!, path: "other/SKILL.md" },
    { ...registered[0]!, change: "added" as const },
  ])
    expect(errors(before, current, [value])).not.toEqual([]);
  expect(errors(before, current, [...registered, ...registered])).not.toEqual(
    [],
  );
  expect(
    errors(
      before,
      { ...current, missing: ["x"], otherSkills: ["new"] },
      registered,
    ),
  ).toHaveLength(2);
});

it("tolerates a further edit of a planned-only source but reports it as a notice", () => {
  const planned = [
    { id: "NW01", status: "planned", sources: ["skill/SKILL.md"] },
  ];
  const stale = [{ ...registered[0]!, hash: "c".repeat(64) }];
  // The recorded hash is deliberately not part of the match: the author keeps
  // editing these sources, and no implementation reads them yet.
  const result = compareSourceDrift(before, current, stale, planned);
  expect(result.errors).toEqual([]);
  expect(result.notices).toEqual([
    expect.stringContaining("edited again since review"),
  ]);
  expect(
    compareSourceDrift(before, current, registered, planned).notices,
  ).toEqual([]);
});

it("fails when a drifted source is already implemented, and when the registry disagrees with the map", () => {
  for (const status of ["implemented", "implemented-variant"]) {
    const result = compareSourceDrift(before, current, registered, [
      { id: "NW01", status, sources: ["skill/SKILL.md"] },
    ]);
    expect(result.errors).toEqual([expect.stringContaining(`NW01(${status})`)]);
  }
  // Missing the other direction is dangerous; over-declaring is conservative.
  expect(
    compareSourceDrift(before, current, registered, [
      { id: "NW01", status: "planned", sources: ["skill/SKILL.md"] },
      { id: "NW02", status: "planned", sources: ["skill/SKILL.md"] },
    ]).errors,
  ).toEqual([expect.stringContaining("omit dependants")]);
  const lenient = compareSourceDrift(before, current, registered, [
    { id: "NW00", status: "planned", sources: ["other/file.md"] },
  ]);
  expect(lenient.errors).toEqual([]);
  expect(lenient.notices).toEqual([
    expect.stringContaining("exceed the method map"),
  ]);
});
it("validates the registry and detects added and removed sources", () => {
  expect(knownSourceDrift("```json\n[]\n```")).toEqual([]);
  expect(() => knownSourceDrift("no block")).toThrow();
  expect(() => knownSourceDrift('```json\n[{"path":"x"}]\n```')).toThrow();
  const empty = { ...before, skills: [] };
  expect(
    errors(empty, current, [{ ...registered[0]!, change: "added" }]),
  ).toEqual([]);
  expect(
    errors(before, empty, [
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
