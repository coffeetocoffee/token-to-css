function kebab(str) {
  return str
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

/**
 * Parse a token JSON string while recording, for every leaf, the source
 * line of its key. Returns { tree, loc } where `loc` maps the kebab-cased
 * flattened token name to { file, line } (1-based line number).
 */
export function parseLocated(text, filename) {
  let i = 0;
  let line = 1;
  const loc = {};

  function ws() {
    while (i < text.length) {
      const c = text[i];
      if (c === "\n") {
        line++;
        i++;
      } else if (c === "\r") {
        i++;
      } else if (/\s/.test(c)) {
        i++;
      } else {
        break;
      }
    }
  }

  function err(m) {
    throw new Error(`${filename}:${line}: ${m}`);
  }

  function parseString() {
    const startLine = line;
    i++; // opening quote
    let value = "";
    while (i < text.length) {
      const c = text[i++];
      if (c === "\\") {
        const e = text[i++];
        if (e === "n") value += "\n";
        else if (e === "t") value += "\t";
        else if (e === "r") value += "\r";
        else if (e === '"') value += '"';
        else if (e === "\\") value += "\\";
        else if (e === "/") value += "/";
        else if (e === "u") {
          value += String.fromCharCode(parseInt(text.substr(i, 4), 16));
          i += 4;
        } else value += e;
      } else if (c === '"') {
        return { value, line: startLine };
      } else {
        value += c;
      }
    }
    err("unterminated string");
  }

  function parseNumber() {
    const start = i;
    while (i < text.length && /[0-9eE.+\-]/.test(text[i])) i++;
    return parseFloat(text.slice(start, i));
  }

  function parseValue(path) {
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const obj = {};
      ws();
      if (text[i] === "}") {
        i++;
        return obj;
      }
      while (true) {
        ws();
        if (text[i] !== '"') err("expected key");
        const k = parseString();
        ws();
        if (text[i] !== ":") err("expected :");
        i++;
        const childPath = [...path, kebab(k.value)];
        const val = parseValue(childPath);
        const isLeaf =
          val === null ||
          (typeof val !== "object" && typeof val !== "function");
        if (isLeaf) {
          loc[childPath.join("-")] = { file: filename, line: k.line };
        }
        obj[k.value] = val;
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          break;
        }
        err("expected , or }");
      }
      return obj;
    }
    if (c === '"') return parseString().value;
    if (c === "-" || (c >= "0" && c <= "9")) return parseNumber();
    if (text.startsWith("true", i)) {
      i += 4;
      return true;
    }
    if (text.startsWith("false", i)) {
      i += 5;
      return false;
    }
    if (text.startsWith("null", i)) {
      i += 4;
      return null;
    }
    err("unexpected token");
  }

  const tree = parseValue([]);
  return { tree, loc };
}
