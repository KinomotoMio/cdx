#!/usr/bin/env node
// cdx: delegate work to Codex threads hosted by Codex's own app-server daemon.

import fs from "node:fs";
import path from "node:path";
import { closeConnection } from "../lib/connection.mjs";
import * as codex from "../lib/threads.mjs";
import { report } from "../lib/report.mjs";

const HELP = `cdx — delegate work to Codex threads that keep running in Codex's app-server

  cdx start <name> [prompt] [-f brief.md] [-C dir] [--worktree] [-m model] [-e effort]
                   [--read-only] [--net] [--add-dir dir]... [-i image]... [--schema file.json] [--wait]
  cdx ls                          threads cdx started, with their state
  cdx show <name> [-n 15]         state and latest steps
  cdx wait <name> [--timeout 30m] block until the current turn ends; print its result
  cdx result <name>               how the last turn ended
  cdx steer <name> <text|-f file> add guidance to the running turn
  cdx send <name> <text|-f file> [-i image]... [--schema file.json] [--wait]   a new turn on a stopped thread
  cdx stop <name>                 interrupt the running turn
  cdx diff <name> [--stat]        changes since the thread started
  cdx forget <name>               drop it from cdx's list (Codex keeps the thread)
  cdx run <script.mjs | - | -e code>   run a script with start/thread/list/all/forget in scope
  cdx report <text|-f file> [--thread name]   record a problem with cdx itself in ~/.cdx/reports/

  --json prints machine-readable output for any command.`;

function parse(argv) {
  const flags = { addDir: [], image: [] };
  const rest = [];
  const value = { f: "file", C: "cwd", m: "model", e: "effort", n: "n", i: "image", "-schema": "schema", "-timeout": "timeout", "-add-dir": "addDir", "-thread": "thread" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-e" && rest[0] === "run") { flags.code = argv[++i]; continue; }
    const key = a.startsWith("-") ? value[a.slice(1)] : undefined;
    if (key === "addDir" || key === "image") flags[key].push(argv[++i]);
    else if (key) flags[key] = argv[++i];
    else if (a === "--worktree") flags.worktree = true;
    else if (a === "--read-only") flags.readOnly = true;
    else if (a === "--net") flags.net = true;
    else if (a === "--wait") flags.wait = true;
    else if (a === "--json") flags.json = true;
    else if (a === "--stat") flags.stat = true;
    else if (a === "-h" || a === "--help") flags.help = true;
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else rest.push(a);
  }
  return { flags, rest };
}

function duration(s) {
  if (!s) return 0;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(s);
  if (!m) throw new Error(`bad duration ${s}`);
  return Number(m[1]) * { ms: 1, s: 1e3, m: 6e4, h: 36e5 }[m[2] ?? "s"];
}

function text(flags, words) {
  if (flags.file) return fs.readFileSync(flags.file, "utf8");
  if (words.length) return words.join(" ");
  if (!process.stdin.isTTY) return fs.readFileSync(0, "utf8");
  return "";
}

function schema(flags) {
  return flags.schema ? JSON.parse(fs.readFileSync(flags.schema, "utf8")) : undefined;
}

const clip = (s, n = 400) => (s && s.length > n ? s.slice(0, n) + "…" : s ?? "");

function printStatus(s) {
  console.log(`${s.name}  ${s.state}  turns=${s.turns}  ${s.cwd}${s.branch ? `  (${s.branch})` : ""}`);
  if (s.filesChanged?.length) console.log(`  files: ${s.filesChanged.join(", ")}`);
  if (s.lastMessage) console.log(`  last: ${clip(s.lastMessage, 300).replace(/\n/g, "\n        ")}`);
}

function printStep(st) {
  const line = {
    message: () => `> ${clip(st.text, 300)}`,
    plan: () => `plan: ${clip(st.text, 300)}`,
    command: () => `$ ${clip(st.command, 160)}${st.exitCode != null ? `  → ${st.exitCode}` : `  (${st.status})`}`,
    files: () => `~ ${st.paths.join(", ")}`,
    tool: () => `tool ${st.tool} (${st.status})`,
    image: () => `image ${st.path ?? `(${st.status})`}`,
    input: () => `< ${clip(st.text, 200)}`,
  }[st.kind]();
  console.log("  " + line.replace(/\n/g, "\n    "));
}

function printResult(r) {
  if (!r) return console.log("still running");
  console.log(`${r.name}  ${r.state}${r.durationMs ? `  ${Math.round(r.durationMs / 1000)}s` : ""}  ${r.cwd}`);
  if (r.error) console.log(`error: ${r.error}`);
  if (r.gitStatus?.length) console.log(`git: ${r.gitStatus.join(", ")}`);
  for (const img of r.images) console.log(`image: ${img.path ?? `not saved (${img.failure?.message ?? img.status})`}`);
  const failed = r.commands.filter((c) => c.exitCode && c.exitCode !== 0);
  if (failed.length) console.log(`failed commands: ${failed.map((c) => `${clip(c.command, 80)} → ${c.exitCode}`).join("; ")}`);
  if (r.text) console.log(`\n${r.text}`);
}

async function runScript(flags, file) {
  let code;
  if (flags.code != null) code = flags.code;
  else if (!file || file === "-") code = fs.readFileSync(0, "utf8");
  else code = fs.readFileSync(path.resolve(file), "utf8");
  const AsyncFunction = (async () => {}).constructor;
  const fn = new AsyncFunction("start", "thread", "list", "all", "forget", code);
  const out = await fn(codex.start, codex.thread, codex.list, codex.all, codex.forget);
  if (out !== undefined) console.log(JSON.stringify(out, null, 2));
}

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") return console.log(HELP);
  const { flags, rest } = parse([cmd, ...argv]);
  rest.shift();
  const [name, ...words] = rest;
  const out = (value, human) => (flags.json ? console.log(JSON.stringify(value, null, 2)) : human(value));

  switch (cmd) {
    case "start": {
      const t = await codex.start({
        name,
        prompt: text(flags, words),
        cwd: flags.cwd,
        worktree: flags.worktree,
        model: flags.model,
        effort: flags.effort,
        sandbox: flags.readOnly ? "read" : "write",
        network: flags.net,
        addDirs: flags.addDir,
        images: flags.image,
        schema: schema(flags),
      });
      if (t.note) console.error(`note: ${t.note}`);
      if (flags.wait) return out(await t.wait(), printResult);
      return out({ name: t.name, id: t.id, cwd: t.cwd }, (v) => console.log(`started ${v.name}  ${v.id}\n  ${v.cwd}`));
    }
    case "ls":
      return out(await codex.list(), (v) => (v.length ? v.forEach(printStatus) : console.log("no threads")));
    case "show":
      return out(await codex.thread(name).peek(Number(flags.n ?? 15)), (v) => {
        printStatus(v);
        v.steps.forEach(printStep);
      });
    case "wait":
      return out(await codex.thread(name).wait({ timeoutMs: duration(flags.timeout) }), printResult);
    case "result":
      return out(await codex.thread(name).result(), printResult);
    case "steer":
      await codex.thread(name).steer(text(flags, words));
      return out({ steered: name }, () => console.log(`steered ${name}`));
    case "send": {
      const t = await codex.thread(name).send(text(flags, words), { schema: schema(flags), effort: flags.effort, model: flags.model, images: flags.image });
      if (flags.wait) return out(await t.wait(), printResult);
      return out({ sent: name }, () => console.log(`new turn on ${name}`));
    }
    case "stop": {
      const stopped = await codex.thread(name).interrupt();
      return out({ stopped }, () => console.log(stopped ? `interrupted ${name}` : `${name} was not running`));
    }
    case "diff":
      return console.log(codex.thread(name).diff({ stat: flags.stat }));
    case "forget":
      return out(codex.forget(name), (v) => console.log(`forgot ${v.name} (Codex thread ${v.id} remains)`));
    case "run":
      return runScript(flags, name);
    case "report": {
      const file = await report({ text: text(flags, rest), thread: flags.thread });
      return out({ report: file }, () => console.log(`recorded ${file}`));
    }
    default:
      throw new Error(`unknown command ${cmd}\n\n${HELP}`);
  }
}

try {
  await main();
} catch (err) {
  console.error(`cdx: ${err.message}`);
  process.exitCode = 1;
} finally {
  await closeConnection();
}
