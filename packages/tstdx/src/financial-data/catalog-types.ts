export type FinancialSourceRow = {
  code: string;
  section: string;
  label: string;
};

export type FinancialSourceEntry = readonly [
  code: string,
  section: string,
  label: string,
];
