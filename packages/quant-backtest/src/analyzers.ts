/** Intrabar drawdown and daily closing equity are different observations. */
export class EquityAnalyzer {
  readonly equity: { date: string; value: number }[] = [];
  private peak: number;
  maxDrawdown = 0;
  constructor(private readonly initial: number) {
    this.peak = initial;
  }
  observe(day: string, value: number) {
    if (!Number.isFinite(value)) throw new Error("账户估值溢出");
    this.peak = Math.max(this.peak, value);
    this.maxDrawdown = Math.max(
      this.maxDrawdown,
      ((this.peak - value) / this.peak) * 100,
    );
    if (this.equity.at(-1)?.date === day)
      this.equity[this.equity.length - 1] = { date: day, value };
    else this.equity.push({ date: day, value });
  }
  get totalReturn() {
    return (this.equity.at(-1)!.value / this.initial - 1) * 100;
  }
}
