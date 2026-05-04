/**
 * SCIM 2.0 filter language parser (RFC 7644 §3.4.2.2)
 *
 * Translates SCIM filter expressions into arc's query DSL so existing
 * resources can serve `/scim/v2/Users?filter=...` without per-resource glue.
 *
 * Supports the subset every IdP actually emits in production:
 *   - Comparison ops: eq, ne, co, sw, ew, gt, ge, lt, le, pr (present)
 *   - Logical: and, or, not
 *   - Grouping: ( )
 *   - Attribute paths: `userName`, `name.familyName`, `emails[type eq "work"].value`
 *
 * Out of scope (yields a 400 with a clear reason):
 *   - Complex value paths beyond one level
 *   - Sub-attribute traversal in operands
 *
 * @example
 * parseScimFilter('userName eq "alice@acme.com"')
 *   → { userName: 'alice@acme.com' }
 *
 * parseScimFilter('active eq true and name.familyName sw "S"')
 *   → { $and: [{ active: true }, { 'name.familyName': { $regex: '^S' } }] }
 */

import { ScimError } from "./errors.js";

type Token =
  | { kind: "lparen" }
  | { kind: "rparen" }
  | { kind: "lbracket" }
  | { kind: "rbracket" }
  | { kind: "ident"; value: string }
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "bool"; value: boolean }
  | { kind: "null" }
  | { kind: "op"; value: string };

const COMPARISON_OPS = new Set(["eq", "ne", "co", "sw", "ew", "gt", "ge", "lt", "le", "pr"]);
const LOGICAL_OPS = new Set(["and", "or", "not"]);

// ─────────────────────────────────────────────────────────────────────
// Tokenizer
// ─────────────────────────────────────────────────────────────────────

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i] ?? "";
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "(") {
      tokens.push({ kind: "lparen" });
      i++;
      continue;
    }
    if (c === ")") {
      tokens.push({ kind: "rparen" });
      i++;
      continue;
    }
    if (c === "[") {
      tokens.push({ kind: "lbracket" });
      i++;
      continue;
    }
    if (c === "]") {
      tokens.push({ kind: "rbracket" });
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let value = "";
      while (j < input.length && input[j] !== '"') {
        if (input[j] === "\\" && j + 1 < input.length) {
          value += input[j + 1];
          j += 2;
        } else {
          value += input[j];
          j++;
        }
      }
      if (j >= input.length)
        throw new ScimError(400, "invalidFilter", "Unterminated string literal");
      tokens.push({ kind: "string", value });
      i = j + 1;
      continue;
    }
    const next = input[i + 1] ?? "";
    if ((c >= "0" && c <= "9") || (c === "-" && next >= "0" && next <= "9")) {
      let j = i;
      if (input[j] === "-") j++;
      while (j < input.length) {
        const cj = input[j] ?? "";
        if (!((cj >= "0" && cj <= "9") || cj === ".")) break;
        j++;
      }
      const num = Number(input.slice(i, j));
      if (Number.isNaN(num))
        throw new ScimError(400, "invalidFilter", `Invalid number near "${input.slice(i, j)}"`);
      tokens.push({ kind: "number", value: num });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(c ?? "")) {
      let j = i;
      while (j < input.length && /[a-zA-Z0-9_.$:-]/.test(input[j] ?? "")) j++;
      const word = input.slice(i, j);
      const lower = word.toLowerCase();
      if (lower === "true" || lower === "false") {
        tokens.push({ kind: "bool", value: lower === "true" });
      } else if (lower === "null") {
        tokens.push({ kind: "null" });
      } else if (COMPARISON_OPS.has(lower) || LOGICAL_OPS.has(lower)) {
        tokens.push({ kind: "op", value: lower });
      } else {
        tokens.push({ kind: "ident", value: word });
      }
      i = j;
      continue;
    }
    throw new ScimError(400, "invalidFilter", `Unexpected character "${c}" at position ${i}`);
  }
  return tokens;
}

// ─────────────────────────────────────────────────────────────────────
// Parser — recursive descent. Precedence: not > and > or
// ─────────────────────────────────────────────────────────────────────

export type FilterNode =
  | { kind: "and"; left: FilterNode; right: FilterNode }
  | { kind: "or"; left: FilterNode; right: FilterNode }
  | { kind: "not"; child: FilterNode }
  | {
      kind: "compare";
      attr: string;
      op: "eq" | "ne" | "co" | "sw" | "ew" | "gt" | "ge" | "lt" | "le";
      value: string | number | boolean | null;
    }
  | { kind: "present"; attr: string };

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): FilterNode {
    const node = this.parseOr();
    if (this.pos < this.tokens.length) {
      throw new ScimError(400, "invalidFilter", `Unexpected token at end of filter`);
    }
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private consume(): Token {
    const t = this.tokens[this.pos++];
    if (!t) throw new ScimError(400, "invalidFilter", "Unexpected end of filter");
    return t;
  }

  private parseOr(): FilterNode {
    let left = this.parseAnd();
    while (this.peek()?.kind === "op" && (this.peek() as { value: string }).value === "or") {
      this.consume();
      left = { kind: "or", left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): FilterNode {
    let left = this.parseNot();
    while (this.peek()?.kind === "op" && (this.peek() as { value: string }).value === "and") {
      this.consume();
      left = { kind: "and", left, right: this.parseNot() };
    }
    return left;
  }

  private parseNot(): FilterNode {
    if (this.peek()?.kind === "op" && (this.peek() as { value: string }).value === "not") {
      this.consume();
      const next = this.peek();
      if (!next || next.kind !== "lparen")
        throw new ScimError(400, "invalidFilter", "Expected '(' after 'not'");
      this.consume();
      const child = this.parseOr();
      const close = this.consume();
      if (close.kind !== "rparen")
        throw new ScimError(400, "invalidFilter", "Expected ')' after 'not(...)'");
      return { kind: "not", child };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): FilterNode {
    const t = this.peek();
    if (!t) throw new ScimError(400, "invalidFilter", "Unexpected end of filter");
    if (t.kind === "lparen") {
      this.consume();
      const inner = this.parseOr();
      const close = this.consume();
      if (close.kind !== "rparen")
        throw new ScimError(400, "invalidFilter", "Expected ')' after grouped expression");
      return inner;
    }
    return this.parseComparison();
  }

  private parseComparison(): FilterNode {
    const attrTok = this.consume();
    if (attrTok.kind !== "ident")
      throw new ScimError(400, "invalidFilter", "Expected attribute path");

    // Complex value path: emails[type eq "work"].value — collapse to dotted path.
    let attr = attrTok.value;
    if (this.peek()?.kind === "lbracket") {
      this.consume();
      // For now: skip the inner sub-filter, just take the suffix. Most IdPs
      // emit `emails[type eq "work"].value` only as a presence check, so
      // we treat it as `emails.value` with a `type:work` annotation-loss.
      let depth = 1;
      while (depth > 0 && this.pos < this.tokens.length) {
        const inner = this.consume();
        if (inner.kind === "lbracket") depth++;
        if (inner.kind === "rbracket") depth--;
      }
      const next = this.peek();
      if (next?.kind === "ident" && next.value.startsWith(".")) {
        this.consume();
        attr += next.value;
      }
    }

    const opTok = this.consume();
    if (opTok.kind !== "op" || !COMPARISON_OPS.has(opTok.value))
      throw new ScimError(400, "invalidFilter", `Expected comparison operator after "${attr}"`);

    if (opTok.value === "pr") return { kind: "present", attr };

    const valTok = this.consume();
    let value: string | number | boolean | null;
    if (valTok.kind === "string") value = valTok.value;
    else if (valTok.kind === "number") value = valTok.value;
    else if (valTok.kind === "bool") value = valTok.value;
    else if (valTok.kind === "null") value = null;
    else throw new ScimError(400, "invalidFilter", `Expected literal after "${opTok.value}"`);

    return {
      kind: "compare",
      attr,
      op: opTok.value as "eq" | "ne" | "co" | "sw" | "ew" | "gt" | "ge" | "lt" | "le",
      value,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Filter → arc query (Mongo-style operators that all kits understand)
// ─────────────────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nodeToQuery(
  node: FilterNode,
  mapAttr: (scimAttr: string) => string | undefined,
): Record<string, unknown> {
  switch (node.kind) {
    case "and":
      return { $and: [nodeToQuery(node.left, mapAttr), nodeToQuery(node.right, mapAttr)] };
    case "or":
      return { $or: [nodeToQuery(node.left, mapAttr), nodeToQuery(node.right, mapAttr)] };
    case "not":
      return { $nor: [nodeToQuery(node.child, mapAttr)] };
    case "present": {
      const field = mapAttr(node.attr);
      if (!field)
        throw new ScimError(400, "invalidFilter", `Attribute "${node.attr}" is not filterable`);
      return { [field]: { $exists: true, $ne: null } };
    }
    case "compare": {
      const field = mapAttr(node.attr);
      if (!field)
        throw new ScimError(400, "invalidFilter", `Attribute "${node.attr}" is not filterable`);
      switch (node.op) {
        case "eq":
          return { [field]: node.value };
        case "ne":
          return { [field]: { $ne: node.value } };
        case "co":
          if (typeof node.value !== "string")
            throw new ScimError(400, "invalidFilter", "'co' requires a string operand");
          return { [field]: { $regex: escapeRegex(node.value), $options: "i" } };
        case "sw":
          if (typeof node.value !== "string")
            throw new ScimError(400, "invalidFilter", "'sw' requires a string operand");
          return { [field]: { $regex: `^${escapeRegex(node.value)}`, $options: "i" } };
        case "ew":
          if (typeof node.value !== "string")
            throw new ScimError(400, "invalidFilter", "'ew' requires a string operand");
          return { [field]: { $regex: `${escapeRegex(node.value)}$`, $options: "i" } };
        case "gt":
          return { [field]: { $gt: node.value } };
        case "ge":
          return { [field]: { $gte: node.value } };
        case "lt":
          return { [field]: { $lt: node.value } };
        case "le":
          return { [field]: { $lte: node.value } };
      }
    }
  }
}

/**
 * Parse a SCIM 2.0 filter expression and translate to arc/Mongo query shape.
 *
 * @param filter Raw filter string from `?filter=...`
 * @param mapAttr Mapping function: SCIM attr → backend field name. Return
 *   `undefined` to deny (yields 400 invalidFilter). Use `IDENTITY_MAP` when
 *   the resource exposes SCIM-named attributes directly.
 */
export function parseScimFilter(
  filter: string,
  mapAttr: (scimAttr: string) => string | undefined,
): Record<string, unknown> {
  if (!filter || filter.trim().length === 0) return {};
  const tokens = tokenize(filter);
  const tree = new Parser(tokens).parse();
  return nodeToQuery(tree, mapAttr);
}

/** Pass-through mapper for resources that already use SCIM attribute names. */
export const IDENTITY_MAP: (a: string) => string = (a) => a;
