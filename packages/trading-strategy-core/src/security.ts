export const instrumentKinds = [
  "stock",
  "convertible",
  "fund",
  "reverseRepo",
  "other",
] as const;
export type InstrumentKind = (typeof instrumentKinds)[number];

/** Market and instrument from the 6-digit code. Shanghai and Shenzhen share the
 * leading `1`/`2` digits, so the full prefix decides; anything unrecognized
 * returns null market and is excluded from per-security analysis upstream. */
export function classifySecurityCode(code: string) {
  if (!/^\d{6}$/.test(code))
    return { code, market: null, instrument: "other" as const };
  const three = code.slice(0, 3);
  const two = code.slice(0, 2);
  const table: [string[], "sh" | "sz" | "bj", InstrumentKind][] = [
    [["600", "601", "603", "605", "688", "689", "900"], "sh", "stock"],
    [["000", "001", "002", "003", "300", "301", "200"], "sz", "stock"],
    [["110", "111", "112", "113", "118", "119"], "sh", "convertible"],
    [["123", "127", "128", "120"], "sz", "convertible"],
    [
      [
        "510",
        "511",
        "512",
        "513",
        "515",
        "516",
        "517",
        "518",
        "560",
        "561",
        "562",
        "563",
        "588",
        "501",
        "502",
        "506",
        "508",
      ],
      "sh",
      "fund",
    ],
    [
      [
        "159",
        "150",
        "160",
        "161",
        "162",
        "163",
        "164",
        "165",
        "166",
        "167",
        "168",
        "169",
        "184",
      ],
      "sz",
      "fund",
    ],
    [["204"], "sh", "reverseRepo"],
    [["131"], "sz", "reverseRepo"],
  ];
  for (const [prefixes, market, instrument] of table)
    if (prefixes.includes(three)) return { code, market, instrument };
  if (["43", "83", "87", "88", "92"].includes(two))
    return { code, market: "bj" as const, instrument: "stock" as const };
  return { code, market: null, instrument: "other" as const };
}
