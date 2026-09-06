import { createServer } from "node:http";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { createTokenServer } from "./serve.js";

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}


/** The landing page: paste a token file, or point at a running serve. */
export function buildLandingHTML(title = "token-to-css — hosted playground") {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escHtml(title)}</title>
<style>
body{font-family:system-ui,sans-serif;margin:2rem auto;max-width:44rem;background:#fafafa;color:#18181b}
h1{font-size:1.5rem}
p{color:#52525b}
textarea{width:100%;height:14rem;font-family:ui-monospace,monospace;font-size:.85rem;padding:.75rem;border:1px solid #d4d4d8;border-radius:.5rem;box-sizing:border-box}
.row{display:flex;gap:.75rem;margin:.75rem 0;flex-wrap:wrap}
input{flex:1;min-width:14rem;padding:.5rem .75rem;border:1px solid #d4d4d8;border-radius:.375rem;font-size:.9rem}
button{padding:.5rem 1.25rem;font-size:.95rem;border:0;border-radius:.375rem;background:#2563eb;color:white;cursor:pointer}
button:disabled{background:#a5b4fc}
#err{color:#b91c1c;font-size:.85rem;min-height:1.2em}
code{background:#f4f4f5;padding:.1rem .35rem;border-radius:.25rem;font-size:.85em}
</style>
</head>
<body>
<h1>Live design-system playground</h1>
<p>Paste a <code>tokens.json</code> (or point at a running <code>token-to-css serve</code>)
to get a live preview plus the visual editor — proposals go through the server's
governed write scope.</p>
<textarea id="tokens" placeholder='{ "color": { "primary": "#3b82f6" }, ... }'></textarea>
<div class="row">
  <input id="serveUrl" placeholder="…or a serve URL: http://localhost:4173" />
  <input id="token" placeholder="bearer token (optional, for write scope)" />
</div>
<p id="err"></p>
<button id="go">Open playground →</button>
<script>
document.getElementById("go").addEventListener("click", async () => {
  const body = {};
  const text = document.getElementById("tokens").value.trim();
  if (text) body.tokensText = text;
  const url = document.getElementById("serveUrl").value.trim();
  if (url) body.serveUrl = url;
  const token = document.getElementById("token").value.trim();
  if (token) body.token = token;
  if (!body.tokensText && !body.serveUrl) {
    document.getElementById("err").textContent = "paste tokens or enter a serve URL";
    return;
  }
  const btn = document.getElementById("go");
  btn.disabled = true;
  btn.textContent = "Booting…";
  try {
    const res = await fetch("/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || "session failed");
    location.href = json.url;
  } catch (e) {
    document.getElementById("err").textContent = e.message;
    btn.disabled = false;
    btn.textContent = "Open playground →";
  }
});
</script>
</body>
</html>`;
}

let nextSessionId = 1;

/**
 * Create the v12.0 hosted playground: a landing hub where a pasted token file
 * (or a serve URL) boots a full session — the v5.1 live playground plus the
 * v10.5 visual editor, all riding `createTokenServer`. Each session is a real
 * Token Server on an ephemeral port, so the v10.5 commit pipeline
 * (`/editor/preview` → governed `POST /tokens`) is intact by construction.
 *
 * With `serveUrl` (optional `token`), the session mirrors the remote tree and
 * `POST /session/<id>/propose` forwards proposals to the remote *write scope*,
 * where `serve --approve` (or the GitHub connector) turns them into change
 * requests / token PRs.
 *
 * Returns an unlistened `http.Server` with:
 * - `.createSession({ tokens?, tokensText?, serveUrl?, token? })` → session
 * - `.sessions` — Map of active sessions
 * - `.closeAll()` — closes the hub and every session server
 */
export async function createPlaygroundServer(options = {}) {
  const title = options.title || "token-to-css — hosted playground";
  const sessions = new Map();

  async function bootSession({ tokens = null, tokensText = null, serveUrl = null, token = null } = {}) {
    let tree = tokens;
    if (!tree && tokensText != null) tree = JSON.parse(tokensText);
    if (serveUrl) {
      const base = serveUrl.replace(/\/$/, "");
      const headers = token ? { authorization: `Bearer ${token}` } : {};
      const res = await fetch(`${base}/tokens`, { headers });
      if (!res.ok) throw new Error(`serve URL returned ${res.status}`);
      tree = await res.json();
    }
    if (!tree || typeof tree !== "object" || Array.isArray(tree)) {
      throw new Error("a token object is required");
    }
    // The session IS a Token Server: playground + editor on, in-memory tree,
    // so POST /tokens folds proposals without touching any source file.
    const child = createTokenServer({ tokens: tree, watch: false, playground: true, editor: true });
    await new Promise((resolveListen) => child.listen(0, resolveListen));
    const port = child.address().port;
    const id = `s${nextSessionId++}`;
    const session = {
      id,
      url: `http://localhost:${port}/`,
      server: child,
      remote: serveUrl ? { url: serveUrl.replace(/\/$/, ""), token: token || null } : null,
      createdAt: new Date().toISOString(),
    };
    sessions.set(id, session);
    return session;
  }

  async function proposeToRemote(session, proposal) {
    const { url, token } = session.remote;
    const headers = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${url}/tokens`, {
      method: "POST",
      headers,
      body: JSON.stringify(proposal),
    });
    const json = await res.json().catch(() => ({}));
    // Mirror the (possibly approved) remote state back into the local preview.
    try {
      const refreshed = await fetch(`${url}/tokens`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      if (refreshed.ok) session.server.setTokens(await refreshed.json());
    } catch {
      /* preview refresh is best-effort */
    }
    return json;
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;

    if (req.method === "GET" && (path === "/" || path === "")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(buildLandingHTML(title));
      return;
    }

    if (req.method === "POST" && path === "/session") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const payload = body ? JSON.parse(body) : {};
          bootSession(payload).then(
            (session) => {
              res.writeHead(200, { "content-type": "application/json" });
              res.end(
                JSON.stringify({ ok: true, id: session.id, url: session.url, remote: Boolean(session.remote) })
              );
            },
            (err) => {
              res.writeHead(400, { "content-type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: err.message }));
            }
          );
        } catch (err) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    // Forward a proposal to the session's remote write scope (serve --approve
    // queues a CR; the GitHub connector turns it into a token PR).
    const proposeMatch = /^\/session\/([^/]+)\/propose$/.exec(path);
    if (req.method === "POST" && proposeMatch) {
      const session = sessions.get(proposeMatch[1]);
      if (!session || !session.remote) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "no remote session" }));
        return;
      }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const proposal = JSON.parse(body);
          proposeToRemote(session, proposal).then(
            (json) => {
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify(json));
            },
            (err) => {
              res.writeHead(502, { "content-type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: err.message }));
            }
          );
        } catch (err) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  server.sessions = sessions;
  server.createSession = bootSession;
  server.proposeToRemote = proposeToRemote;
  server.closeAll = () => {
    for (const session of sessions.values()) {
      try {
        session.server.closeAll();
        session.server.close();
      } catch {
        /* already closed */
      }
    }
    sessions.clear();
  };
  return server;
}

// --- v12.2: static-site playground -----------------------------------------

const CDN_MAJOR = "12";

/** The site stylesheet shared by the static playground pages. */
export function buildStaticCSS() {
  return [
    ":root{color-scheme:light dark}",
    "*{box-sizing:border-box}",
    "body{font-family:system-ui,sans-serif;margin:2rem auto;max-width:52rem;padding:0 1rem;background:#fafafa;color:#18181b}",
    "h1{font-size:1.35rem;margin:0 0 .25rem}",
    "p.sub{color:#52525b;margin:.25rem 0 1.25rem}",
    "textarea{width:100%;height:11rem;font-family:ui-monospace,monospace;font-size:.85rem;padding:.75rem;border:1px solid #d4d4d8;border-radius:.5rem}",
    ".row{display:flex;gap:.75rem;margin:.75rem 0;flex-wrap:wrap;align-items:center}",
    "input{flex:1;min-width:12rem;padding:.5rem .75rem;border:1px solid #d4d4d8;border-radius:.375rem;font-size:.9rem}",
    "button{padding:.5rem 1.25rem;font-size:.95rem;border:0;border-radius:.375rem;background:#2563eb;color:#fff;cursor:pointer}",
    "button.secondary{background:#e4e4e7;color:#18181b}",
    "table{width:100%;border-collapse:collapse;margin-top:1rem}",
    "th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid #e4e4e7;vertical-align:middle;font-size:.9rem}",
    "td button{padding:.2rem .7rem;font-size:.8rem}",
    "code{background:#f4f4f5;padding:.1rem .35rem;border-radius:.25rem;font-size:.85em;word-break:break-all}",
    ".sw{display:inline-block;width:1.5rem;height:1.5rem;border-radius:.3rem;border:1px solid #ccc;vertical-align:middle}",
    ".sw.none{background:repeating-linear-gradient(45deg,#eee,#eee 4px,#f9f9f9 4px,#f9f9f9 8px)}",
    "#status{min-height:1.3em;font-size:.85rem;color:#52525b;margin:.5rem 0}",
    "#status.err{color:#b91c1c}",
    "#status.ok{color:#15803d}",
    ".count{color:#71717a;font-size:.85rem}",
    "pre{background:#f4f4f5;padding:.75rem;border-radius:.375rem;overflow:auto;font-size:.8rem}",
  ].join("\n");
}

function pageShell(body, { title, importMap = "", headScript = "" }) {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escHtml(title)}</title>`,
    importMap,
    headScript,
    `<style>${buildStaticCSS()}</style>`,
    "</head>",
    "<body>",
    body,
    "</body>",
    "</html>",
  ].join("\n");
}

/**
 * The static-site landing page (v12.2): paste a tokens.json or point at a
 * running serve URL; the compiler is imported in the browser via the import
 * map, so preview + editor + diff-before-commit run with no server.
 */
export function buildStaticPlayground(options = {}) {
  // Inside <textarea> only &, <, > need escaping (raw JSON quotes stay).
  const escapeText = (s) =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const sourceText = options.sourceText
    ? escapeText(options.sourceText)
    : JSON.stringify(
        { color: { primary: "#3b82f6", background: "#ffffff" }, space: { md: "1rem" } },
        null,
        2
      );
  const config = JSON.stringify(options.config || {}).replace(/</g, "\\u003c");
  const cdnUrl =
    options.cdnUrl ||
    `https://cdn.jsdelivr.net/npm/@token-to-css/core@${CDN_MAJOR}/+esm`;
  const importMap =
    '<script type="importmap">\n' +
    JSON.stringify(
      {
        imports: { "@token-to-css/core": cdnUrl },
      },
      null,
      2
    ) +
    "\n</script>";
  const headScript = `<script>window.TTC_STATIC_CONFIG = ${config};</script>`;
  const body = [
    "<h1>token-to-css playground</h1>",
    '<p class="sub">Paste <code>tokens.json</code> — the compiler runs in your browser (no server). Optionally point at a running <code>token-to-css serve --cors</code> to propose changes through its governed write scope.</p>',
    '<textarea id="tokens" spellcheck="false">' + sourceText + "</textarea>",
    '<div class="row">',
    '  <button id="load">Load tokens</button>',
    '  <input id="serveUrl" placeholder="serve URL (optional): http://localhost:4173" />',
    '  <input id="token" placeholder="bearer token (optional)" />',
    "</div>",
    '<p id="status"></p>',
    '<div id="app" hidden>',
    '  <div class="row">',
    '    <span id="count" class="count"></span>',
    '    <span style="flex:1"></span>',
    '    <button id="download" class="secondary">Download tokens.json</button>',
    "  </div>",
    "  <details>",
    "    <summary>Generated CSS</summary>",
    '    <pre id="ttc-css"></pre>',
    "  </details>",
    "  <table>",
    "    <thead><tr><th>token</th><th>value</th><th></th><th></th></tr></thead>",
    '    <tbody id="rows"></tbody>',
    "  </table>",
    "</div>",
    // The client module ships alongside index.html (kept as a real file so it
    // is syntax-checkable and testable).
    '<script type="module" src="./playground.js"></script>',
  ].join("\n");
  return pageShell(body, {
    title: options.title || "token-to-css — static playground",
    importMap,
    headScript,
  });
}

/**
 * `playground --static <dir>`: write the deployable site into `dir` —
 * `index.html` (landing + paste flow) and `playground.js` (the browser
 * client). The output directory is static-host ready as-is (GitHub Pages,
 * any static file server).
 */
export function writeStaticPlayground(dir, options = {}) {
  mkdirSync(dir, { recursive: true });
  const clientSource = readFileSync(
    new URL("./static/playground.js", import.meta.url),
    "utf8"
  );
  writeFileSync(joinPath(dir, "index.html"), buildStaticPlayground(options), "utf8");
  writeFileSync(joinPath(dir, "playground.js"), clientSource, "utf8");
  return {
    dir,
    files: ["index.html", "playground.js"],
  };
}
