// Problem reports for cdx itself, written while cdx is in development preview.
// Each report is a Markdown file carrying the context needed to investigate it later:
// which cdx and Codex were running, and where the affected thread stood.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HOME, thread } from "./threads.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (err) {
    return `unavailable: ${(err.stderr || err.message).toString().trim().split("\n")[0]}`;
  }
}

function cdxVersion() {
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const commit = run("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"]);
  const dirty = run("git", ["-C", ROOT, "status", "--porcelain"]);
  return `${version} (${commit}${dirty && !dirty.startsWith("unavailable") ? ", uncommitted changes" : ""})`;
}

function daemonVersion() {
  const out = run("codex", ["app-server", "daemon", "version"]);
  try {
    const v = JSON.parse(out);
    return `${v.status}, app-server ${v.appServerVersion ?? "?"}`;
  } catch {
    return out;
  }
}

async function threadSection(ref) {
  try {
    const t = thread(ref);
    const peek = await t.peek(20);
    const { steps, ...status } = peek;
    return [
      "## Thread",
      "",
      "```json",
      JSON.stringify({ ...status, entry: t.entry }, null, 2),
      "```",
      "",
      "Latest steps:",
      "",
      "```json",
      JSON.stringify(steps, null, 2),
      "```",
    ].join("\n");
  } catch (err) {
    return `## Thread\n\n\`${ref}\` could not be read: ${err.message}`;
  }
}

/** Write a report and return its path. */
export async function report({ text, thread: ref }) {
  if (!text?.trim()) throw new Error("describe what happened: cdx report \"<what happened>\"");
  const now = new Date();
  const title = text.trim().split("\n")[0].slice(0, 120);
  const sections = [
    `# ${title}`,
    "",
    `Reported ${now.toISOString()} from ${process.cwd()}`,
    "",
    "## What happened",
    "",
    text.trim(),
    "",
    ref ? await threadSection(ref) : null,
    "",
    "## Environment",
    "",
    `- cdx: ${cdxVersion()}`,
    `- codex: ${run("codex", ["--version"])}`,
    `- daemon: ${daemonVersion()}`,
    `- node: ${process.version} on ${process.platform}-${process.arch}`,
    "",
  ].filter((s) => s !== null);

  const dir = path.join(HOME, "reports");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${stamp}${ref ? `-${ref.replace(/[^\w.-]/g, "_")}` : ""}.md`);
  fs.writeFileSync(file, sections.join("\n"));
  return file;
}
