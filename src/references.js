import { parseColor, formatColor, withAlpha, lighten, darken, mix } from "./color.js";

function getPath(obj, path) {
  return path
    .split(".")
    .reduce((node, key) => (node == null ? undefined : node[key]), obj);
}

const REF = /\{([^}]+)\}/g;
const EXPR = /\s[-+*/]\s/;

function findCall(str) {
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (/[a-zA-Z]/.test(c)) {
      let j = i;
      while (j < str.length && /[a-zA-Z]/.test(str[j])) j++;
      const name = str.slice(i, j);
      if (str[j] === "(") {
        let depth = 0;
        let k = j;
        for (; k < str.length; k++) {
          if (str[k] === "(") depth++;
          else if (str[k] === ")") {
            depth--;
            if (depth === 0) break;
          }
        }
        if (k < str.length) {
          return { name, inner: str.slice(j + 1, k), start: i, end: k + 1 };
        }
      }
      i = j;
    }
  }
  return null;
}

function splitTopLevel(s, sep) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur !== "" || out.length) out.push(cur);
  return out;
}

function evalArg(a) {
  const col = parseColor(a);
  if (col) return { type: "color", value: col };
  const t = a.trim();
  if (t.endsWith("%")) return { type: "pct", value: parseFloat(t) / 100 };
  if (t !== "" && !Number.isNaN(parseFloat(t)))
    return { type: "num", value: parseFloat(t) };
  return { type: "raw", value: a };
}

function applyFn(name, args) {
  const colorAt = (i) =>
    args[i] && args[i].type === "color" ? args[i].value : null;
  const numAt = (i) =>
    args[i] && args[i].type !== "raw" ? args[i].value : null;
  switch (name.toLowerCase()) {
    case "alpha": {
      const c = colorAt(0);
      const p = numAt(1);
      if (!c || p == null) return null;
      return formatColor(withAlpha(c, p));
    }
    case "lighten": {
      const c = colorAt(0);
      const p = numAt(1);
      if (!c || p == null) return null;
      return formatColor(lighten(c, p));
    }
    case "darken": {
      const c = colorAt(0);
      const p = numAt(1);
      if (!c || p == null) return null;
      return formatColor(darken(c, p));
    }
    case "mix": {
      const c1 = colorAt(0);
      const c2 = colorAt(1);
      const p = args[2] ? numAt(2) : 0.5;
      if (!c1 || !c2 || p == null) return null;
      return formatColor(mix(c1, c2, p));
    }
    default:
      return null;
  }
}

export function resolveColorFunctions(str) {
  let result = str;
  let guard = 0;
  while (guard++ < 50) {
    const call = findCall(result);
    if (!call) break;
    const innerResolved = resolveColorFunctions(call.inner);
    const args = splitTopLevel(innerResolved, ",").map((a) => evalArg(a.trim()));
    const out = applyFn(call.name, args);
    if (out == null) break; // leave unresolved
    result = result.slice(0, call.start) + out + result.slice(call.end);
  }
  return result;
}

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "+" || c === "-" || c === "*" || c === "/" || c === "(" || c === ")") {
      tokens.push(c);
      i++;
      continue;
    }
    const m = /^\d*\.?\d+(?:[a-z%]+)?/.exec(src.slice(i));
    if (!m) return null;
    const raw = m[0];
    const num = /^(\d*\.?\d+)([a-z%]*)$/.exec(raw);
    tokens.push({ value: parseFloat(num[1]), unit: num[2] });
    i += raw.length;
  }
  return tokens;
}

function applyMulDiv(op, a, b) {
  if (op === "*") {
    if (a.unit === "" && b.unit === "") return { value: a.value * b.value, unit: "" };
    if (a.unit === "" && b.unit !== "") return { value: a.value * b.value, unit: b.unit };
    if (a.unit !== "" && b.unit === "") return { value: a.value * b.value, unit: a.unit };
    return null;
  }
  if (op === "/") {
    if (b.value === 0) return null;
    if (a.unit === "" && b.unit === "") return { value: a.value / b.value, unit: "" };
    if (a.unit !== "" && b.unit === "") return { value: a.value / b.value, unit: a.unit };
    if (a.unit !== "" && b.unit !== "" && a.unit === b.unit)
      return { value: a.value / b.value, unit: "" };
    return null;
  }
  return null;
}

function applyAddSub(op, a, b) {
  if (a.unit !== b.unit) return null;
  const value = op === "+" ? a.value + b.value : a.value - b.value;
  return { value, unit: a.unit };
}

function evalExpr(src) {
  const tokens = tokenize(src);
  if (!tokens || tokens.length === 0) return null;
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  function parseExpr() {
    let left = parseTerm();
    if (left === null) return null;
    while (peek() === "+" || peek() === "-") {
      const op = next();
      const right = parseTerm();
      if (right === null) return null;
      left = applyAddSub(op, left, right);
      if (left === null) return null;
    }
    return left;
  }
  function parseTerm() {
    let left = parseFactor();
    if (left === null) return null;
    while (peek() === "*" || peek() === "/") {
      const op = next();
      const right = parseFactor();
      if (right === null) return null;
      left = applyMulDiv(op, left, right);
      if (left === null) return null;
    }
    return left;
  }
  function parseFactor() {
    const t = peek();
    if (t === "(") {
      next();
      const v = parseExpr();
      if (peek() !== ")") return null;
      next();
      return v;
    }
    if (t === null || typeof t !== "object") return null;
    next();
    return t;
  }
  const result = parseExpr();
  if (pos !== tokens.length) return null;
  return result;
}

function trimNumber(n) {
  return String(Number(n.toFixed(5)));
}

function collapse(value) {
  const result = evalExpr(value);
  if (result === null) return null;
  return `${trimNumber(result.value)}${result.unit}`;
}

export function resolveReferences(tokens, { reduce = true, strict = false } = {}) {
  const stack = new Set();
  function walk(node) {
    if (typeof node === "string") {
      const isExpr = EXPR.test(node);
      let value = node.replace(REF, (_, ref) => {
        if (stack.has(ref)) {
          throw new Error(`circular token reference: {${ref}}`);
        }
        const target = getPath(tokens, ref);
        if (target === undefined) {
          throw new Error(`unknown token reference: {${ref}}`);
        }
        stack.add(ref);
        const resolved = walk(typeof target === "string" ? target : target);
        stack.delete(ref);
        return typeof resolved === "string" ? resolved : String(resolved);
      });
      value = resolveColorFunctions(value);
      if (isExpr) {
        if (reduce) {
          const collapsed = collapse(value);
          if (collapsed) value = collapsed;
          else if (strict)
            throw new Error(
              `cannot reduce expression with mismatched units: ${node}`
            );
          else if (!/^calc\(/.test(value)) value = `calc(${value})`;
        } else if (!/^calc\(/.test(value)) {
          value = `calc(${value})`;
        }
      }
      return value;
    }
    if (node && typeof node === "object" && !Array.isArray(node)) {
      const out = {};
      for (const [key, val] of Object.entries(node)) out[key] = walk(val);
      return out;
    }
    return node;
  }
  return walk(tokens);
}
