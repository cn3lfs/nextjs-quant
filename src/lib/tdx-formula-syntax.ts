export type FormulaIssue = {
  line: number;
  name?: string;
  kind: "syntax" | "future" | "unsupported" | "parameter";
  reason: string;
};
export class FormulaError extends Error {
  constructor(readonly issues: FormulaIssue[]) {
    super(issues.map(i => `第${i.line}行${i.name ? ` ${i.name}` : ""}：${i.reason}`).join("\n"));
    this.name = "FormulaError";
  }
}
export type Expr =
  | { kind: "string"; value: string; line: number }
  | { kind: "number"; value: number; line: number }
  | { kind: "name"; name: string; line: number }
  | { kind: "call"; name: string; args: Expr[]; line: number }
  | { kind: "unary"; op: string; value: Expr; line: number }
  | { kind: "binary"; op: string; left: Expr; right: Expr; line: number };
export type Statement = { name?: string; output: boolean; expr: Expr; line: number };
type Token = { text: string; kind: "number" | "name" | "symbol" | "string" | "end"; line: number };
const fail = (line: number, reason: string): never => { throw new FormulaError([{line, kind: "syntax", reason}]); };

function lex(source: string): Token[] {
  if (source.length > 100000) fail(1, "公式超过100000字符限制");
  const tokens: Token[] = [];
  let i = 0, line = 1;
  while (i < source.length) {
    const c = source[i]!;
    if (/\s/.test(c)) { if (c === "\n") line++; i++; continue; }
    if (c === "{") {
      const start = line; i++;
      while (i < source.length && source[i] !== "}") { if (source[i] === "\n") line++; i++; }
      if (i === source.length) fail(start, "注释缺少 }");
      i++; continue;
    }
    if (c === "#") throw new FormulaError([{line, name: "#", kind: "future", reason: "跨周期引用可能使用未来数据，拒绝执行"}]);
    const rest = source.slice(i);
    // Tokenize quoted arguments for precise unsupported-function diagnostics.
    // Strings remain forbidden by the checker; this does not add string execution.
    if (c === "'" || c === '"') {
      const start = line; let value = ""; i++;
      while (i < source.length && source[i] !== c) {if (source[i] === "\n") line++; value += source[i++];}
      if (i === source.length) fail(start, "字符串缺少结束引号");
      i++; tokens.push({text:value,kind:"string",line:start}); continue;
    }
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest)?.[0];
    if (number) {
      if (!Number.isFinite(Number(number))) fail(line, "数值超出有限范围");
      tokens.push({text: number, kind: "number", line}); i += number.length; continue;
    }
    const name = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(rest)?.[0];
    if (name) { tokens.push({text: name.toUpperCase(), kind: "name", line}); i += name.length; continue; }
    const symbol = /^(?::=|>=|<=|<>|!=|&&|\|\||[+\-*/><=():;,])/.exec(rest)?.[0];
    if (!symbol) return fail(line, `不支持的字符 ${c}`);
    tokens.push({text: symbol, kind: "symbol", line}); i += symbol.length;
  }
  if (tokens.length > 2048) fail(line, "公式超过2048词法单元限制");
  tokens.push({text: "", kind: "end", line});
  return tokens;
}

// tdx-doc 操作符.md defines operators/aliases but no full precedence table.
// Local explicit choice: unary > */ > +- > comparisons > AND > OR; left associative.
const precedence: Record<string, number> = {
  OR: 1, "||": 1, AND: 2, "&&": 2,
  ">": 3, "<": 3, ">=": 3, "<=": 3, "=": 3, "<>": 3, "!=": 3,
  "+": 4, "-": 4, "*": 5, "/": 5,
};
export function parseFormula(source: string): Statement[] {
  const tokens = lex(source);
  let at = 0, depth = 0;
  const peek = () => tokens[at]!;
  const take = () => tokens[at++]!;
  const expect = (text: string) => { if (peek().text !== text) fail(peek().line, `缺少 ${text}，实际为 ${peek().text || "结尾"}`); take(); };
  function expression(min = 0): Expr {
    if (++depth > 200) fail(peek().line, "表达式嵌套超过200层");
    const token = take();
    let left: Expr;
    if (token.kind === "number") left = {kind: "number", value: Number(token.text), line: token.line};
    else if (token.kind === "string") left = {kind: "string", value: token.text, line: token.line};
    else if (["+", "-", "NOT"].includes(token.text)) left = {kind: "unary", op: token.text, value: expression(6), line: token.line};
    else if (token.text === "(") { left = expression(); expect(")"); }
    else if (token.kind === "name") {
      if (peek().text === "(") {
        take(); const args: Expr[] = [];
        if (peek().text !== ")") { args.push(expression()); while (peek().text === ",") { take(); args.push(expression()); } }
        expect(")"); left = {kind: "call", name: token.text, args, line: token.line};
      } else left = {kind: "name", name: token.text, line: token.line};
    } else return fail(token.line, `需要表达式，实际为 ${token.text || "结尾"}`);
    while ((precedence[peek().text] ?? -1) >= min) {
      const op = take();
      left = {kind: "binary", op: op.text, left, right: expression(precedence[op.text]! + 1), line: op.line};
    }
    depth--; return left;
  }
  const statements: Statement[] = [];
  while (peek().kind !== "end") {
    let name: string | undefined, output = true;
    const line = peek().line;
    if (peek().kind === "name" && [":", ":="].includes(tokens[at + 1]!.text)) {
      name = take().text; output = take().text === ":";
    }
    statements.push({name, output, expr: expression(), line});
    if (peek().kind !== "end") expect(";");
  }
  if (!statements.length) fail(1, "公式为空");
  return statements;
}
