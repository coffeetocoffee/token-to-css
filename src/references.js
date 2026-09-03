import {
  parseColor,
  formatColor,
  withAlpha,
  lighten,
  darken,
  mix,
} from "./color.js";

function getPath(obj, path) {
  return path
    .split(".")
    .reduce((node, key) => (node == null ? undefined : node[key]), obj);
}

const REF = /\{([^}]+)\}/g;

const UNIT_RE = /^(px|rem|em|%|vh|vw|vmin|vmax|fr|pt|ch|ex|s|ms|deg|rad|turn)$/;

const BUILTIN_FUNCTIONS = {
  alpha(args) {
    const c = asColor(args[0]);
    const p = asNumber(args[1]) / (args[1].unit === "%" ? 100 : 1);
    return formatColor(withAlpha(c, p));
  },
  lighten(args) {
    const c = asColor(args[0]);
    const p = asNumber(args[1]) / (args[1].unit === "%" ? 100 : 1);
    return formatColor(lighten(c, p));
  },
  darken(args) {
    const c = asColor(args[0]);
    const p = asNumber(args[1]) / (args[1].unit === "%" ? 100 : 1);
    return formatColor(darken(c, p));
  },
  mix(args) {
    const c1 = asColor(args[0]);
    const c2 = asColor(args[1]);
    const p =
      args[2] != null
        ? asNumber(args[2]) / (args[2].unit === "%" ? 100 : 1)
        : 0.5;
    return formatColor(mix(c1, c2, p));
  },
  rgb(args) {
    const nums = args.map((a) => (a.kind === "num" ? a.value : null));
    if (nums.some((n) => n == null))
      throw new Error("rgb() expects numeric arguments");
    return formatColor({ r: nums[0], g: nums[1], b: nums[2], a: 1 });
  },
  hsl(args) {
    const nums = args.map((a) => (a.kind === "num" ? a.value : null));
    if (nums.some((n) => n == null))
      throw new Error("hsl() expects numeric arguments");
    return formatColor(hslToRgb(nums[0], nums[1] / 100, nums[2] / 100));
  },
};

function asColor(v) {
  if (v.kind !== "str") throw new Error("expected a color value");
  const c = parseColor(v.value);
  if (!c) throw new Error(`invalid color: ${v.value}`);
  return c;
}

function asNumber(v) {
  if (v.kind !== "num") throw new Error("expected a number");
  return v.value;
}

function hslToRgb(h, s, l) {
  h = (((h % 360) + 360) % 360) / 360;
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue(p, q, h + 1 / 3);
    g = hue(p, q, h);
    b = hue(p, q, h - 1 / 3);
  }
  return { r: r * 255, g: g * 255, b: b * 255, a: 1 };
}

const registeredFunctions = {};

export function registerFunction(name, fn) {
  registeredFunctions[name.toLowerCase()] = fn;
}

function tokenize(str) {
  const tokens = [];
  const isDigit = (c) => c >= "0" && c <= "9";
  const isAlpha = (c) => /[A-Za-z#]/.test(c);
  const isIdentChar = (c) => /[A-Za-z0-9_#-]/.test(c);
  let i = 0;
  while (i < str.length) {
    const c = str[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "(" || c === ")" || c === ",") {
      tokens.push({ type: c === "(" ? "lparen" : c === ")" ? "rparen" : "comma" });
      i++;
      continue;
    }
    if (c === "{") {
      const end = str.indexOf("}", i);
      const name = str.slice(i + 1, end);
      tokens.push({ type: "ref", name });
      i = end + 1;
      continue;
    }
    if (c === "-" && str[i + 1] === "-") {
      let j = i + 2;
      while (j < str.length && /[\w-]/.test(str[j])) j++;
      tokens.push({ type: "ident", name: str.slice(i, j) });
      i = j;
      continue;
    }
    if (isAlpha(c) || (c === "-" && /[\w]/.test(str[i + 1] || ""))) {
      let j = i + 1;
      while (j < str.length && isIdentChar(str[j])) j++;
      tokens.push({ type: "ident", name: str.slice(i, j) });
      i = j;
      continue;
    }
    if (isDigit(c) || (c === "." && isDigit(str[i + 1]))) {
      let j = i;
      while (j < str.length && /[\d.]/.test(str[j])) j++;
      let k = j;
      while (k < str.length && /[a-z%]/i.test(str[k])) k++;
      const numStr = str.slice(i, j);
      const unit = str.slice(j, k);
      tokens.push({
        type: "num",
        value: parseFloat(numStr),
        unit: UNIT_RE.test(unit) ? unit : "",
      });
      i = k;
      continue;
    }
    const prev = tokens[tokens.length - 1];
    const prevIsOp =
      prev && prev.type === "op" ? prev.op : prev && prev.type === "lparen" ? "(" : null;
    if (
      c === "+" ||
      c === "*" ||
      c === "/" ||
      (c === "-" && (i === 0 || prevIsOp === "(" || prevIsOp))
    ) {
      tokens.push({ type: "op", op: c });
      i++;
      continue;
    }
    if (c === "-") {
      tokens.push({ type: "op", op: "-" });
      i++;
      continue;
    }
    i++;
  }
  return tokens;
}

function looksLikeExpr(s) {
  return (
    /\{[^}]+\}/.test(s) ||
    /\(/.test(s) ||
    /\s[-+*/]\s/.test(s) ||
    /[A-Za-z_][\w-]*\(/.test(s)
  );
}

class CalcError extends Error {
  constructor() {
    super("calc");
  }
}

function parse(tokens) {
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];

  function parseAddSub() {
    let left = parseMulDiv();
    while (
      peek() &&
      peek().type === "op" &&
      (peek().op === "+" || peek().op === "-")
    ) {
      const op = next().op;
      left = { type: "binop", op, left, right: parseMulDiv() };
    }
    return left;
  }
  function parseMulDiv() {
    let left = parseUnary();
    while (
      peek() &&
      peek().type === "op" &&
      (peek().op === "*" || peek().op === "/")
    ) {
      const op = next().op;
      left = { type: "binop", op, left, right: parseUnary() };
    }
    return left;
  }
  function parseUnary() {
    if (
      peek() &&
      peek().type === "op" &&
      (peek().op === "+" || peek().op === "-")
    ) {
      const op = next().op;
      return { type: "unary", op, operand: parseUnary() };
    }
    return parsePrimary();
  }
  function parsePrimary() {
    const t = peek();
    if (!t) throw new Error("unexpected end of expression");
    if (t.type === "lparen") {
      next();
      const e = parseAddSub();
      if (!peek() || peek().type !== "rparen") throw new Error("missing )");
      next();
      return { type: "paren", expr: e };
    }
    if (t.type === "num") {
      next();
      return { type: "num", value: t.value, unit: t.unit };
    }
    if (t.type === "color") {
      next();
      return { type: "color", value: t.value };
    }
    if (t.type === "ref") {
      next();
      return { type: "ref", name: t.name };
    }
    if (t.type === "ident") {
      next();
      if (peek() && peek().type === "lparen") {
        next();
        const args = [];
        if (!(peek() && peek().type === "rparen")) {
          args.push(parseAddSub());
          while (peek() && peek().type === "comma") {
            next();
            args.push(parseAddSub());
          }
        }
        if (!peek() || peek().type !== "rparen")
          throw new Error("missing ) in function call");
        next();
        return { type: "call", name: t.name, args };
      }
      return { type: "str", value: t.name };
    }
    throw new Error(`unexpected token: ${JSON.stringify(t)}`);
  }

  const ast = parseAddSub();
  if (i < tokens.length) throw new Error("unexpected trailing tokens");
  return ast;
}

function formatNum(n) {
  return String(Math.round(n * 1e6) / 1e6);
}

function formatValue(v) {
  if (v.kind === "num") return `${formatNum(v.value)}${v.unit || ""}`;
  return v.value;
}

function neg(v) {
  if (v.kind === "num") return { kind: "num", value: -v.value, unit: v.unit };
  throw new CalcError();
}

function applyBinop(op, l, r) {
  if (l.kind === "num" && r.kind === "num") {
    const u1 = l.unit;
    const u2 = r.unit;
    if (op === "*" || op === "/") {
      const value = op === "*" ? l.value * r.value : l.value / r.value;
      let unit = "";
      if (op === "*") {
        if (!u1 && !u2) unit = "";
        else if (u1 && !u2) unit = u1;
        else if (!u1 && u2) unit = u2;
        else throw new CalcError();
      } else {
        if (!u2) unit = u1;
        else if (u1 === u2) unit = "";
        else throw new CalcError();
      }
      return { kind: "num", value, unit };
    }
    if (u1 === u2) {
      return {
        kind: "num",
        value: op === "+" ? l.value + r.value : l.value - r.value,
        unit: u1,
      };
    }
    if (!u1 && !u2)
      return {
        kind: "num",
        value: op === "+" ? l.value + r.value : l.value - r.value,
        unit: "",
      };
    if (u1 && !u2)
      return {
        kind: "num",
        value: op === "+" ? l.value + r.value : l.value - r.value,
        unit: u1,
      };
    if (!u1 && u2)
      return {
        kind: "num",
        value: op === "+" ? r.value + l.value : l.value - r.value,
        unit: u2,
      };
    throw new CalcError();
  }
  throw new CalcError();
}

function evalNode(node, ctx) {
  switch (node.type) {
    case "num":
      return { kind: "num", value: node.value, unit: node.unit };
    case "color":
      return { kind: "str", value: node.value };
    case "str":
      return { kind: "str", value: node.value };
    case "ref": {
      const target = getPath(ctx.tokens, node.name);
      if (target === undefined)
        throw new Error(`unknown token reference: {${node.name}}`);
      if (ctx.stack.has(node.name))
        throw new Error(`circular token reference: {${node.name}}`);
      ctx.stack.add(node.name);
      const resolved =
        typeof target === "string" ? evaluate(target, ctx) : String(target);
      ctx.stack.delete(node.name);
      return { kind: "str", value: resolved };
    }
    case "call": {
      const fn = ctx.functions[node.name.toLowerCase()];
      if (!fn) {
        const rendered = node.args
          .map((a) => formatValue(evalNode(a, ctx)))
          .join(", ");
        return { kind: "str", value: `${node.name}(${rendered})` };
      }
      const args = node.args.map((a) => evalNode(a, ctx));
      const out = fn(args, ctx);
      return { kind: "str", value: typeof out === "string" ? out : String(out) };
    }
    case "unary": {
      const v = evalNode(node.operand, ctx);
      return node.op === "-" ? neg(v) : v;
    }
    case "binop": {
      const l = evalNode(node.left, ctx);
      const r = evalNode(node.right, ctx);
      return applyBinop(node.op, l, r);
    }
    case "paren":
      return evalNode(node.expr, ctx);
    default:
      throw new Error("unknown node");
  }
}

function evaluate(str, ctx) {
  const resolved = str.replace(REF, (_, ref) => {
    if (ctx.stack.has(ref))
      throw new Error(`circular token reference: {${ref}}`);
    const target = getPath(ctx.tokens, ref);
    if (target === undefined)
      throw new Error(`unknown token reference: {${ref}}`);
    ctx.stack.add(ref);
    const r =
      typeof target === "string" ? evaluate(target, ctx) : String(target);
    ctx.stack.delete(ref);
    return r;
  });

  if (!looksLikeExpr(resolved)) return resolved;

  let ast;
  try {
    ast = parse(tokenize(resolved));
  } catch {
    // Not actually an expression — e.g. a multi-part CSS value like
    // "0 4px 6px rgba(0,0,0,0.1)" (the "(" trips the expression heuristic,
    // but "0" parses as a complete expression with trailing tokens).
    // Keep the author's literal value verbatim instead of failing the build.
    // parse() only throws structural errors here; unknown/circular
    // references and strict mismatches surface later and still throw.
    return resolved;
  }

  try {
    const v = evalNode(ast, ctx);
    const result = formatValue(v);
    if (!ctx.reduce)
      return /^calc\(/.test(result) ? result : `calc(${resolved})`;
    return result;
  } catch (e) {
    if (e instanceof CalcError) {
      if (ctx.strict)
        throw new Error(
          `cannot reduce expression with mismatched units: ${str}`
        );
      return `calc(${resolved})`;
    }
    throw e;
  }
}

export function resolveReferences(tokens, { reduce = true, strict = false } = {}) {
  const ctx = {
    tokens,
    stack: new Set(),
    reduce,
    strict,
    functions: { ...BUILTIN_FUNCTIONS, ...registeredFunctions },
  };
  function walk(node) {
    if (typeof node === "string") return evaluate(node, ctx);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out = {};
      for (const k of Object.keys(node)) out[k] = walk(node[k]);
      return out;
    }
    return node;
  }
  return walk(tokens);
}

export function resolveColorFunctions(str) {
  return evaluate(str, {
    tokens: {},
    stack: new Set(),
    reduce: true,
    strict: false,
    functions: { ...BUILTIN_FUNCTIONS, ...registeredFunctions },
  });
}
