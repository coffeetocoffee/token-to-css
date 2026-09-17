/**
 * Zero-dependency Prometheus metrics for the `token-to-css` Token Server mesh.
 *
 * `createMetrics()` returns a small registry that accumulates counters, gauges,
 * and histograms, and `scrape()` renders them in the Prometheus text exposition
 * format. No external dependencies — used by `serve` for the v13 `/metrics`
 * endpoint (CR counts, subscriber counts, fold latency, adoption score).
 */

function fmtLabels(labels) {
  if (!labels || Object.keys(labels).length === 0) return "";
  const parts = Object.entries(labels).map(
    ([k, v]) => `${k}="${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
  );
  return `{${parts.join(",")}}`;
}

function sanitize(name) {
  return name.replace(/[^a-zA-Z0-9_:]/g, "_");
}

const DEFAULT_BUCKETS = [
  0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

export function createMetrics() {
  const series = [];
  const keyOf = (labels) =>
    labels && Object.keys(labels).length ? JSON.stringify(labels) : "";

  function find(name) {
    return series.find((s) => s.name === name);
  }
  function ensure(type, name, help, labelNames, buckets) {
    let s = find(name);
    if (!s) {
      s = {
        type,
        name: sanitize(name),
        help,
        labelNames: labelNames || [],
        values: new Map(),
        buckets: buckets || null,
      };
      series.push(s);
    }
    return s;
  }

  return {
    series,

    /** Increment a counter (optionally with labels). */
    incrementCounter(name, help, labels, by = 1) {
      const s = ensure("counter", name, help, labels ? Object.keys(labels) : []);
      const k = keyOf(labels);
      s.values.set(k, (s.values.get(k) || 0) + by);
    },

    /** Seed a counter to an absolute value (used when reloading persisted state). */
    seedCounter(name, help, labels, value) {
      const s = ensure("counter", name, help, labels ? Object.keys(labels) : []);
      s.values.set(keyOf(labels), value);
    },

    /** Set a gauge (optionally with labels) to an absolute value. */
    setGauge(name, help, labels, value) {
      const s = ensure("gauge", name, help, labels ? Object.keys(labels) : []);
      s.values.set(keyOf(labels), value);
    },

    /** Record an observation in a histogram (optionally with labels). */
    observeHistogram(name, help, labels, value, buckets = DEFAULT_BUCKETS) {
      const s = ensure(
        "histogram",
        name,
        help,
        labels ? Object.keys(labels) : [],
        buckets
      );
      const k = keyOf(labels);
      const cur =
        s.values.get(k) ||
        { count: 0, sum: 0, buckets: new Map(), _buckets: buckets };
      cur.count += 1;
      cur.sum += value;
      for (const b of buckets) {
        if (value <= b) cur.buckets.set(b, (cur.buckets.get(b) || 0) + 1);
      }
      s.values.set(k, cur);
    },

    /** Read the current scalar value of a counter/gauge (undefined if unset). */
    get(name, labels) {
      const s = find(name);
      if (!s) return undefined;
      return s.values.get(keyOf(labels));
    },

    scrape() {
      const out = [];
      for (const s of series) {
        out.push(`# HELP ${s.name} ${s.help}`);
        out.push(`# TYPE ${s.name} ${s.type}`);
        if (s.type === "histogram") {
          for (const [labelsKey, v] of s.values) {
            const labels = labelsKey ? JSON.parse(labelsKey) : {};
            let cum = 0;
            for (const b of v._buckets) {
              cum += v.buckets.get(b) || 0;
              out.push(
                `${s.name}_bucket${fmtLabels({ ...labels, le: String(b) })} ${cum}`
              );
            }
            out.push(
              `${s.name}_bucket${fmtLabels({ ...labels, le: "+Inf" })} ${v.count}`
            );
            out.push(`${s.name}_sum${fmtLabels(labels)} ${round(v.sum)}`);
            out.push(`${s.name}_count${fmtLabels(labels)} ${v.count}`);
          }
        } else {
          for (const [labelsKey, value] of s.values) {
            const labels = labelsKey ? JSON.parse(labelsKey) : {};
            out.push(`${s.name}${fmtLabels(labels)} ${round(value)}`);
          }
        }
      }
      return out.join("\n") + "\n";
    },
  };
}

function round(n) {
  return Number.isInteger(n) ? n : Math.round(n * 1e9) / 1e9;
}

export { fmtLabels };
