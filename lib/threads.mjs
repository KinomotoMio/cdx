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
    return JSON.parse(fs.readFileSync(INDEX, "utf8"));
  } catch {
    return [];
  }
}

function writeIndex(entries) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(INDEX, JSON.stringify(entries, null, 2) + "\n");
}

function findEntry(ref) {
  const entries = readIndex();
  return entries.find((e) => e.name === ref) ?? entries.find((e) => e.id === ref || e.id.startsWith(ref));
}

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function textInput(text) {
  return [{ type: "text", text, text_elements: [] }];
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
  if (readIndex().some((e) => e.name === name)) {
    throw new Error(`a thread named ${name} already exists; choose another name or \`cdx forget ${name}\``);
  }

  let cwd = path.resolve(opts.cwd ?? ".");
  let worktree = null;
  if (opts.worktree) {
    worktree = makeWorktree(cwd, name);
    cwd = worktree.dir;
  }

  const conn = await connection();
  const started = await conn.request("thread/start", {
    cwd,
    model: model ?? null,
    approvalPolicy: "never",
    sandbox: opts.sandbox === "read" ? "read-only" : "workspace-write",
    config: THREAD_CONFIG,
  });
  const id = started.thread.id;
  await conn.request("thread/name/set", { threadId: id, name: `cdx: ${name}` }).catch(() => {});

  const entry = {
    name,
    id,
    cwd,
    model: started.model,
    sandbox: opts.sandbox === "read" ? "read" : "write",
    ...(worktree && { worktree: { branch: worktree.branch, repo: worktree.repo } }),
    createdAt: new Date().toISOString(),
  };
  writeIndex([...readIndex(), entry]);

  await conn.request("turn/start", {
    threadId: id,
    input: textInput(prompt),
    sandboxPolicy: sandboxPolicy(opts),
    effort: effort ?? null,
    outputSchema: schema ?? null,
  });

  const t = new Thread(entry);
  if (worktree?.note) t.note = worktree.note;
  return t;
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
  writeIndex(readIndex().filter((e) => e.id !== entry.id));
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
    case "userMessage": return { kind: "input", text: item.content.map((c) => c.text ?? `[${c.type}]`).join(" ") };
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
    const t = await this.#read();
    const last = summarizeTurn(t.turns.at(-1));
    const flags = t.status?.type === "active" ? t.status.activeFlags : [];
    return {
      ...brief(this.entry),
      state: last.state === "inProgress" ? (flags.length ? flags.join(",") : "running") : last.state,
      turns: t.turns.length,
      lastMessage: last.text,
      filesChanged: last.filesChanged,
    };
  }

  /** The latest steps of the current or last turn. */
  async peek(n = 15) {
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
          wake = resolve;
          setTimeout(resolve, Math.min(pollMs, deadline - Date.now()));
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
    await conn.request("turn/steer", { threadId: this.id, input: textInput(text), expectedTurnId: turnId });
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
  async send(text, { schema, effort, model } = {}) {
    if (await this.#activeTurnId()) throw new Error(`${this.name} is still running; steer it or wait`);
    const conn = await this.#load();
    await conn.request("turn/start", {
      threadId: this.id,
      input: textInput(text),
      outputSchema: schema ?? null,
      effort: effort ?? null,
      model: model ?? null,
    });
    return this;
  }

  /** The thread's uncommitted changes in its directory, as git sees them. */
  diff({ stat = false } = {}) {
    return git(this.cwd, "diff", ...(stat ? ["--stat"] : []), "HEAD") +
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
