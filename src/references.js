function getPath(obj, path) {
  return path
    .split(".")
    .reduce((node, key) => (node == null ? undefined : node[key]), obj);
}

const REF = /\{([^}]+)\}/g;
const EXPR = /\s[-+*/]\s/;

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

export function resolveReferences(tokens, { reduce = true } = {}) {
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
      if (isExpr) {
        if (reduce) {
          const collapsed = collapse(value);
          if (collapsed) value = collapsed;
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
