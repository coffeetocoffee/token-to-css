import { spawn } from "node:child_process";

/**
 * MCP client for the token-to-css VS Code extension.
 *
 * A thin client over the existing MCP surface: spawns `token-to-css mcp
 * <tokens.json>` (the installed CLI — the compiler is never bundled) and speaks
 * the same newline-delimited JSON-RPC 2.0 over stdio the CLI implements.
 */
export class McpClient {
  /**
   * @param {object} options
   * @param {string} options.command  CLI binary (e.g. "token-to-css" on PATH, or "node")
   * @param {string[]} [options.args] argv after the command (e.g. ["mcp", "tokens.json"])
   * @param {string} [options.cwd]
   * @param {number} [options.requestTimeoutMs] default 15000
   */
  constructor({ command, args = [], cwd, requestTimeoutMs = 15000 } = {}) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.requestTimeoutMs = requestTimeoutMs;
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.tools = [];
    this.serverInfo = null;
    this.buffer = "";
    this.exitCode = null;
    this.stderr = [];
    this.onExit = null;
    this._closedByUs = false;
  }

  /** Spawn the CLI and run the initialize handshake. Resolves after tools/list. */
  start() {
    const shell = process.platform === "win32" && !/[\\/]/.test(this.command);
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this._onData(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => this.stderr.push(chunk));
    this.child.on("exit", (code) => {
      this.exitCode = code;
      this._rejectAll(this._closedByUs ? new Error("mcp client disposed") : new Error(`mcp server exited (code ${code})`));
      if (this.onExit) this.onExit(code);
    });
    return this.initialize();
  }

  _onData(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = this.pending.get(message.id);
      if (entry) {
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(message.error.message || "mcp error"));
        else entry.resolve(message.result);
      }
    }
  }

  _rejectAll(err) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  _send(obj) {
    if (!this.child || this.child.killed) throw new Error("mcp client is not running");
    this.child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  /**
   * Send a JSON-RPC request and resolve with the `result` payload.
   * Rejects on an `error` response, timeout, or child exit.
   */
  request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this._send({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  notify(method, params = {}) {
    this._send({ jsonrpc: "2.0", method, params });
  }

  /** initialize handshake + tools/list cache. */
  async initialize() {
    const res = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "token-to-css-vscode", version: "12.0.0" },
    });
    this.serverInfo = res.serverInfo || null;
    this.notify("notifications/initialized");
    const tools = await this.request("tools/list", {});
    this.tools = (tools && tools.tools) || [];
    return res;
  }

  hasTool(name) {
    return this.tools.some((t) => t.name === name);
  }

  /**
   * Call an MCP tool and return the parsed JSON payload (the tool result is
   * JSON text inside `content[0].text`).
   */
  async callTool(name, args = {}) {
    const res = await this.request("tools/call", { name, arguments: args });
    const text = res && res.content && res.content[0] && res.content[0].type === "text" ? res.content[0].text : "";
    return JSON.parse(text);
  }

  /** Close the child process. Pending requests reject with "disposed". */
  dispose() {
    this._closedByUs = true;
    this._rejectAll(new Error("mcp client disposed"));
    if (this.child) {
      try {
        this.child.stdin.end();
      } catch {
        /* already gone */
      }
      const child = this.child;
      setTimeout(() => {
        if (!child.killed) child.kill();
      }, 500).unref?.();
    }
  }
}

/** Default MCP spawn for a token file: `<bin> mcp <tokensPath>`. */
export function resolveMcpCommand(tokensPath, { bin = "token-to-css" } = {}) {
  return { command: bin, args: ["mcp", tokensPath] };
}
