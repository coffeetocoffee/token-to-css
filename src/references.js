function getPath(obj, path) {
  return path
    .split(".")
    .reduce((node, key) => (node == null ? undefined : node[key]), obj);
}

const REF = /\{([^}]+)\}/g;
const EXPR = /\s[-+*/]\s/;

export function resolveReferences(tokens) {
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
      if (isExpr && !/^calc\(/.test(value)) value = `calc(${value})`;
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
