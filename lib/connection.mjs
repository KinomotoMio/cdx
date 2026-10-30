// One WebSocket connection to Codex's own app-server daemon.
// The daemon hosts threads; this process only talks to it, so a task keeps
// running after the script or command that started it has exited.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import WebSocket from "ws";

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const SOCKET = path.join(CODEX_HOME, "app-server-control", "app-server-control.sock");

function startDaemon() {
  const r = spawnSync("codex", ["app-server", "daemon", "start"], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`could not start the Codex app-server daemon:\n${(r.stderr || r.stdout || "").trim()}`);
  }
}

function openSocket() {
  const target = fs.realpathSync(SOCKET);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws+unix://${target}:/`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

export class Connection {
  #ws;
  #nextId = 0;
  #pending = new Map();
  #listeners = new Set();

  static async open() {
    let ws;
    try {
      ws = await openSocket();
    } catch {
      startDaemon();
      ws = await openSocket();
    }
    const conn = new Connection(ws);
    await conn.request("initialize", {
      clientInfo: { name: "cdx", title: "cdx", version: "0.0.1" },
      capabilities: null,
    });
    conn.#ws.send(JSON.stringify({ method: "initialized" }));
    return conn;
  }

  constructor(ws) {
    this.#ws = ws;
    ws.on("message", (data) => this.#onMessage(JSON.parse(data.toString())));
    ws.on("close", () => {
      for (const { reject } of this.#pending.values()) reject(new Error("connection to Codex closed"));
      this.#pending.clear();
    });
  }

  #onMessage(msg) {
    if (msg.id != null && !msg.method) {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(`${p.method}: ${msg.error.message}`), { rpc: msg.error }));
      else p.resolve(msg.result);
      return;
    }
    // Server requests (approvals, user input) are left to other clients such as the Codex app:
    // cdx starts threads with approvals off and never answers on someone else's behalf.
    if (msg.method && msg.id == null) for (const fn of this.#listeners) fn(msg.method, msg.params);
  }

  request(method, params) {
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Subscribe to notifications; returns an unsubscribe function. */
  listen(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  close() {
    this.#ws.close();
  }
}

let shared;
/** The process-wide connection, opened on first use. */
export function connection() {
  shared ??= Connection.open();
  return shared;
}

export async function closeConnection() {
  if (!shared) return;
  const conn = await shared.catch(() => null);
  shared = undefined;
  conn?.close();
}
