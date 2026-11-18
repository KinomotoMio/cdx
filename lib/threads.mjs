// Delegated Codex threads: start them, look at them, steer them, collect results.
// Codex owns every thread's state. cdx only remembers which threads it started,
// under which name and in which directory (~/.cdx/threads.json).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { connection } from "./connection.mjs";

export const HOME = process.env.CDX_HOME || path.join(os.homedir(), ".cdx");
const INDEX = path.join(HOME, "threads.json");

// Features that make Codex wait for an answer from whoever is watching. A delegated
// thread usually has nobody watching, so it would wait forever.
const THREAD_CONFIG = { "features.default_mode_request_user_input": false };

function readIndex() {
  try {
    const entries = JSON.parse(fs.readFileSync(INDEX, "utf8"));
    if (!Array.isArray(entries)) throw new Error("expected an array");
    return entries;
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw new Error(`cannot read ${INDEX}: ${err.message}`);
  }
}

// Keep the critical section synchronous and short; never hold it across RPC calls.
function updateIndex(change) {
  fs.mkdirSync(HOME, { recursive: true });
  const lock = `${INDEX}.lock`;
  const deadline = Date.now() + 5000;
  let fd;
  for (;;) {
    try { fd = fs.openSync(lock, "wx", 0o600); break; }
    catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (Date.now() >= deadline) throw new Error(`index locked: ${lock}; check other cdx processes before removing a stale lock`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  const tmp = `${INDEX}.${process.pid}.tmp`;
  try {
    const entries = change(readIndex());
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, INDEX);
  } finally {
    fs.rmSync(tmp, { force: true });
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}

function findEntry(ref) {
  const entries = readIndex();
  return entries.find((e) => e.name === ref) ?? entries.find((e) => e.id === ref || e.id.startsWith(ref));
}

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function userInput(text, images = []) {
  return [
    ...images.map((p) => ({ type: "localImage", path: path.resolve(p) })),
    { type: "text", text, text_elements: [] },
  ];
}

function sandboxPolicy({ sandbox = "write", network = false, addDirs = [] }) {
  if (sandbox === "read") return { type: "readOnly", networkAccess: network };
  if (sandbox !== "write") throw new Error(`sandbox must be "write" or "read", not ${JSON.stringify(sandbox)}`);
  return {
    type: "workspaceWrite",
    writableRoots: addDirs.map((d) => path.resolve(d)),
    networkAccess: network,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function makeWorktree(cwd, name) {
  const root = git(cwd, "rev-parse", "--show-toplevel");
  const dir = path.join(HOME, "worktrees", `${path.basename(root)}-${name}`);
  const branch = `cdx/${name}`;
  git(root, "worktree", "add", "-b", branch, dir, "HEAD");
  const dirty = git(root, "status", "--porcelain");
  return { dir, branch, repo: root, note: dirty ? "uncommitted changes in the repository are not in the worktree" : null };
}

/** Start a new delegated thread and its first turn. Returns as soon as Codex accepts it. */
export async function start(opts) {
  const { name, prompt, model, effort, schema } = opts;
  if (!name || !/^[\w.-]+$/.test(name)) throw new Error("a name of letters, digits, '.', '-' or '_' is required");
  if (!prompt) throw new Error("a prompt is required");
  const policy = sandboxPolicy(opts);
  const entry = { name, id: `pending:${name}`, cwd: path.resolve(opts.cwd ?? "."), startup: "starting", createdAt: new Date().toISOString() };
  const save = () => updateIndex(entries => entries.map(e => e.name === name ? { ...entry } : e));
  updateIndex(entries => {
    if (entries.some(e => e.name === name)) throw new Error(`a thread named ${name} already exists; choose another name or cdx forget ${name}`);
    return [...entries, entry];
  });
  try {

    let cwd = path.resolve(opts.cwd ?? ".");
    let worktree = null;
    if (opts.worktree) {
      worktree = makeWorktree(cwd, name);
      cwd = worktree.dir;
    }

    entry.cwd = cwd;
    if (worktree) entry.worktree = { branch: worktree.branch, repo: worktree.repo };
    try { entry.baseCommit = git(cwd, "rev-parse", "HEAD"); } catch {}
    save();
    const conn = await connection();
    const started = await conn.request("thread/start", {
      cwd,
      model: model ?? null,
      approvalPolicy: "never",
      sandbox: opts.sandbox === "read" ? "read-only" : "workspace-write",
      config: THREAD_CONFIG,
    });
    const id = started.thread.id;
    Object.assign(entry, { id, model: started.model, sandbox: opts.sandbox === "read" ? "read" : "write" });
    save();
    await conn.request("thread/name/set", { threadId: id, name: `cdx: ${name}` }).catch(() => {});

    await conn.request("turn/start", {
      threadId: id,
      input: userInput(prompt, opts.images),
      sandboxPolicy: policy,
      effort: effort ?? null,
      outputSchema: schema ?? null,
    });

    delete entry.startup;
    save();
    const t = new Thread(entry);
    if (worktree?.note) t.note = worktree.note;
    return t;
  } catch (err) {
    entry.startup = "failed-or-unknown";
    entry.startupError = err.message;
    try { save(); } catch (saveError) { err.message += `; recording failure: ${saveError.message}`; }
    throw new Error(`${err.message}; task ${name} retained at ${entry.cwd} (id ${entry.id}). Inspect with cdx show before retrying; the server may have accepted the request.`);
  }
}

/** A handle on a thread cdx started, by name or id. */
export function thread(ref) {
  const entry = findEntry(ref);
  if (!entry) throw new Error(`no thread named ${ref}; \`cdx ls\` lists them`);
  return new Thread(entry);
}

/** Every thread cdx started, newest first, with its current state. */
export async function list() {
  const entries = readIndex().reverse();
  return Promise.all(entries.map((e) => new Thread(e).status().catch((err) => ({ ...brief(e), state: `unreadable: ${err.message}` }))));
}

export function forget(ref) {
  const entry = findEntry(ref);
  if (!entry) throw new Error(`no thread named ${ref}`);
  if (entry.startup === "starting") throw new Error("cannot forget a task while start is in progress");
  updateIndex(entries => entries.filter((e) => e.id !== entry.id));
  return brief(entry);
}

function brief(e) {
  return { name: e.name, id: e.id, cwd: e.cwd, ...(e.worktree && { branch: e.worktree.branch }) };
}

function summarizeTurn(turn) {
  const items = turn?.items ?? [];
  const messages = items.filter((i) => i.type === "agentMessage" && i.text);
  const files = new Set();
  for (const i of items) if (i.type === "fileChange") for (const c of i.changes) files.add(c.path);
  return {
    turnId: turn?.id ?? null,
    state: turn?.status ?? "none",
    text: messages.at(-1)?.text ?? null,
    error: turn?.error?.message ?? null,
    filesChanged: [...files],
    commands: items
      .filter((i) => i.type === "commandExecution")
      .map((i) => ({ command: i.command, exitCode: i.exitCode ?? null, status: i.status })),
    // Codex saves generated images under ~/.codex/generated_images/<thread>/; `result` holds
    // the image data itself and is left out.
    images: items
      .filter((i) => i.type === "imageGeneration")
      .map((i) => ({ path: i.savedPath ?? null, status: i.status, revisedPrompt: i.revisedPrompt, failure: i.failure ?? null })),
    durationMs: turn?.durationMs ?? null,
  };
}

function step(item) {
  switch (item.type) {
    case "agentMessage": return item.text ? { kind: "message", text: item.text } : null;
    case "plan": return { kind: "plan", text: item.text };
    case "commandExecution": return { kind: "command", command: item.command, exitCode: item.exitCode ?? null, status: item.status };
    case "fileChange": return { kind: "files", paths: item.changes.map((c) => c.path), status: item.status };
    case "mcpToolCall": return { kind: "tool", tool: `${item.server}.${item.tool}`, status: item.status };
    case "imageGeneration": return { kind: "image", path: item.savedPath ?? null, status: item.status };
    case "userMessage": return { kind: "input", text: item.content.map((c) => c.text ?? `[${c.path ?? c.type}]`).join(" ") };
    default: return null;
  }
}

export class Thread {
  constructor(entry) {
    this.entry = entry;
    this.name = entry.name;
    this.id = entry.id;
    this.cwd = entry.cwd;
  }

  async #read() {
    if (this.id.startsWith("pending:")) throw new Error(`task ${this.name} has no confirmed Codex thread; inspect cdx show and the saved startup record`);
    const conn = await connection();
    const { thread } = await conn.request("thread/read", { threadId: this.id, includeTurns: true });
    return thread;
  }

  // Loading the thread into the daemon also subscribes this connection to its events.
  async #load() {
    const conn = await connection();
    await conn.request("thread/resume", { threadId: this.id, excludeTurns: true });
    return conn;
  }

  async #activeTurnId() {
    const last = (await this.#read()).turns.at(-1);
    return last?.status === "inProgress" ? last.id : null;
  }

  /** Where the thread stands now: running, waiting, or how its last turn ended. */
  async status() {
    if (this.id.startsWith("pending:")) return { ...brief(this.entry), state: this.entry.startup, turns: 0, lastMessage: this.entry.startupError };
    const t = await this.#read();
    const last = summarizeTurn(t.turns.at(-1));
    const flags = t.status?.type === "active" ? t.status.activeFlags : [];
    return {
      ...brief(this.entry),
      state: last.state === "inProgress" ? (flags.length ? flags.join(",") : "running") : last.state,
      ...(this.entry.startup && { startup: this.entry.startup, startupError: this.entry.startupError }),
      turns: t.turns.length,
      lastMessage: last.text,
      filesChanged: last.filesChanged,
    };
  }

  /** The latest steps of the current or last turn. */
  async peek(n = 15) {
    if (this.id.startsWith("pending:")) return { ...(await this.status()), steps: [] };
    const t = await this.#read();
    const turn = t.turns.at(-1);
    return { ...(await this.status()), steps: (turn?.items ?? []).map(step).filter(Boolean).slice(-n) };
  }

  /** How the last turn ended; null while it is still running. */
  async result() {
    const t = await this.#read();
    const r = summarizeTurn(t.turns.at(-1));
    if (r.state === "inProgress") return null;
    return { ...brief(this.entry), ...r, parsed: parseMaybe(r.text), gitStatus: gitStatus(this.cwd) };
  }

  /** Wait until the current turn ends, then return its result. */
  async wait({ timeoutMs = 0, pollMs = 15000 } = {}) {
    const conn = await this.#load();
    let wake;
    const stop = conn.listen((method, params) => {
      if (method === "turn/completed" && params.threadId === this.id) wake?.();
    });
    const deadline = timeoutMs ? Date.now() + timeoutMs : Infinity;
    try {
      for (;;) {
        const r = await this.result();
        if (r) return r;
        if (Date.now() >= deadline) return null;
        await new Promise((resolve) => {
          const timer = setTimeout(() => wake(), Math.min(pollMs, deadline - Date.now()));
          wake = () => { clearTimeout(timer); resolve(); };
        });
      }
    } finally {
      stop();
    }
  }

  /** Add guidance to the running turn without stopping it. */
  async steer(text) {
    const turnId = await this.#activeTurnId();
    if (!turnId) throw new Error(`${this.name} is not running; use send to start a new turn`);
    const conn = await this.#load();
    await conn.request("turn/steer", { threadId: this.id, input: userInput(text), expectedTurnId: turnId });
  }

  /** Stop the running turn. The thread stays and can be continued with send. */
  async interrupt() {
    const turnId = await this.#activeTurnId();
    if (!turnId) return false;
    const conn = await this.#load();
    await conn.request("turn/interrupt", { threadId: this.id, turnId });
    return true;
  }

  /** Start a new turn on a thread that is not running, e.g. a correction after review. */
  async send(text, { schema, effort, model, images } = {}) {
    if (await this.#activeTurnId()) throw new Error(`${this.name} is still running; steer it or wait`);
    const conn = await this.#load();
    await conn.request("turn/start", {
      threadId: this.id,
      input: userInput(text, images),
      outputSchema: schema ?? null,
      effort: effort ?? null,
      model: model ?? null,
    });
    return this;
  }

  /** Changes since the recorded starting commit, including subsequent commits. */
  diff({ stat = false } = {}) {
    return git(this.cwd, "diff", ...(stat ? ["--stat"] : []), this.entry.baseCommit ?? "HEAD", "--") +
      (stat ? "" : untracked(this.cwd));
  }
}

// filesChanged only lists Codex's patch edits; a file written by a shell command shows up here.
function gitStatus(cwd) {
  try {
    return git(cwd, "status", "--short").split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

function untracked(cwd) {
  const files = git(cwd, "ls-files", "--others", "--exclude-standard");
  return files ? `\n# untracked\n${files}\n` : "";
}

function parseMaybe(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Run promises or thunks with at most `limit` at once; results keep their order. */
export async function all(tasks, { limit = 3 } = {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      const t = tasks[i];
      results[i] = await (typeof t === "function" ? t() : t);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}
