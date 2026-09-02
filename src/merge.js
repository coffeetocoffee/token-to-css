export function deepMerge(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      target[key] !== null &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      deepMerge(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

export function mergeTokens(main, imports) {
  const result = {};
  for (const doc of [...imports, main]) {
    deepMerge(result, doc);
  }
  return result;
}
