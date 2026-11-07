export const blockEligibilityVersion = "exclude-region-style-1" as const;
export type BlockExclusion = {
  name: string;
  code: string | null;
  kind: "region" | "style";
};
export type BlockEligibility = {
  version: typeof blockEligibilityVersion;
  sourceHash: string;
  hash: string;
  excluded: BlockExclusion[];
};

/** Exact metadata identities only: 上海国资 is not the 上海地区 board. */
export function excludedBlock(
  name: string,
  file: string,
  policy: BlockEligibility,
): BlockExclusion | undefined {
  const selected = /^通达信·(\d{6}|成分)·(.+)$/.exec(name);
  const code =
    selected?.[1] ??
    (/^\d{6}(?:\.txt)?$/i.test(file) ? file.slice(0, 6) : null);
  const label = selected?.[2] ?? name;
  return policy.excluded.find((item) => {
    if (code && item.code === code) return true;
    if (item.name === label) return true;
    if (item.kind !== "region") return false;
    const province = item.name.replace(/板块$/, "");
    return label === province || label === `${province}板块`;
  });
}
