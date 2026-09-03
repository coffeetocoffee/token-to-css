/**
 * GitHub Pull-Request connector (v8.0 Universal Connector Hub).
 *
 * Proposes token changes as a GitHub PR (the "propose change from playground"
 * flow): `push` creates a branch, commits the updated token file, and opens a
 * PR against the base branch; `pull` reads the current token file from the repo.
 *
 * Pure transforms (`tokensToGithubFiles` / `githubFilesToTokens`) are
 * transport-agnostic and unit-testable without the GitHub API. `push`/`pull`
 * talk to the GitHub REST API when a `fetchImpl` is supplied.
 * Zero runtime dependencies — pass your own `fetch` (global or injected).
 *
 * Experimental.
 */
import { toTransportTree, registerConnector } from "../connect.js";

export function tokensToGithubFiles(tokens, { path = "tokens.json" } = {}) {
  const tree = toTransportTree(tokens);
  return { [path]: JSON.stringify(tree, null, 2) };
}

export function githubFilesToTokens(files, { path = "tokens.json" } = {}) {
  const raw = files[path] != null ? files[path] : Object.values(files)[0];
  if (raw == null) return {};
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

export function registerGithubPrConnector({
  fetchImpl,
  token,
  owner,
  repo,
  base = "main",
  path = "tokens.json",
  branchPrefix = "token-to-css/",
} = {}) {
  const fetchFn = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);

  function api(pathname, init = {}) {
    if (!fetchFn) throw new Error("github connector: no fetch implementation available");
    if (!owner || !repo) throw new Error("github connector: owner/repo required");
    const url = `https://api.github.com/repos/${owner}/${repo}${pathname}`;
    return fetchFn(url, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers || {}),
      },
    });
  }

  async function pull() {
    const res = await api(`/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(base)}`);
    if (!res.ok) throw new Error(`github pull failed: ${res.status}`);
    const data = await res.json();
    const content = typeof data.content === "string"
      ? Buffer.from(data.content, data.encoding || "base64").toString("utf8")
      : null;
    return githubFilesToTokens({ [path]: content });
  }

  async function push(tree) {
    const files = tokensToGithubFiles(tree, { path });
    const content = Buffer.from(files[path], "utf8").toString("base64");

    // 1. Resolve the base branch head sha.
    const baseRef = await api(`/git/refs/heads/${encodeURIComponent(base)}`);
    if (!baseRef.ok) throw new Error(`github push failed: cannot read base ref (${baseRef.status})`);
    const baseSha = (await baseRef.json()).object.sha;

    // 2. Create a topic branch off the base.
    const branch = `${branchPrefix}${Date.now()}`;
    const createRef = await api("/git/refs", {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
    });
    if (!createRef.ok) throw new Error(`github push failed: cannot create branch (${createRef.status})`);

    // 3. Commit the token file on the new branch.
    const commit = await api(`/contents/${encodeURIComponent(path)}`, {
      method: "PUT",
      body: JSON.stringify({
        message: `chore(tokens): update ${path} via token-to-css`,
        content,
        branch,
      }),
    });
    if (!commit.ok) throw new Error(`github push failed: cannot commit file (${commit.status})`);

    // 4. Open the pull request.
    const pr = await api("/pulls", {
      method: "POST",
      body: JSON.stringify({
        title: `Update design tokens (${path})`,
        head: branch,
        base,
        body: "Automated token change proposed by token-to-css.",
      }),
    });
    if (!pr.ok) throw new Error(`github push failed: cannot open PR (${pr.status})`);
    return pr.json();
  }

  registerConnector({
    name: "github",
    pull,
    push,
    formats: {
      github: (_flat, opts) => {
        const tree = opts && opts.resolvedBase ? opts.resolvedBase : {};
        return JSON.stringify(tokensToGithubFiles(tree, { path }), null, 2);
      },
    },
  });
  return { pull, push, tokensToGithubFiles, githubFilesToTokens };
}
