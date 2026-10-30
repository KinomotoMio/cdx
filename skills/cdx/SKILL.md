---
name: cdx
description: Delegate work to Codex threads that keep running in Codex's own app-server, then look in on them, steer, stop, continue and review them with the `cdx` CLI or short scripts. Use when a well-specified piece of engineering work can run alongside what you are doing, when several independent pieces can run in parallel, or when the user asks to hand something to Codex.
metadata:
  version: "0.1"
---

# Delegating to Codex threads

Reply to the user in their language; this guide is in English.

`cdx` starts Codex threads in Codex's app-server daemon. A thread keeps working after the command or script that started it exits, so you can start work, do something else, and come back to it. You hand out the work, but you still own what lands. Each thread is a colleague's piece of work in progress. It has a brief, a directory it works in, a state, and eventually a result. Keep those four in view the way you would for work you assigned to a person.

## What you are keeping track of

- **The brief.** Codex sees none of your conversation. Write down what it needs: the goal, the files to read, the interfaces and invariants to keep, what is out of scope, the commands that show the work is done, and what to report. Name files and signatures, and give acceptance as commands it can run. When a result disappoints, check the brief before you blame the model.
- **The directory.** A thread edits the directory it starts in. Two threads writing the same files will overwrite each other. Give each writer its own `--worktree`, which is a branch `cdx/<name>` cut from `HEAD`. Uncommitted changes in your checkout are not in that branch. If the work depends on them, tell the user instead of committing for them. Start a thread that only investigates or reviews with `--read-only`.
- **The state.** `cdx ls` and `cdx show <name>` read it from Codex:
  - `running`: the thread is working.
  - `completed`: the turn finished.
  - `interrupted`: someone stopped it.
  - `failed`: the turn errored; the result carries the error.
  - `waitingOnApproval` / `waitingOnUserInput`: cdx starts threads with approvals and questions off, so these should not happen. If one appears, look at the thread in the Codex app, where it is listed as `cdx: <name>`.
- **The result.** The reply is Codex's account of what it did, not evidence that it worked. `gitStatus` and `cdx diff <name>` show what actually changed, and the acceptance commands show whether it works. Read the diff and run those commands yourself before you integrate. Check scope: files outside what you assigned, changed interfaces, deleted or weakened tests, stubs and hard-coded values.

## Acting on a thread

The actions differ in what they do to the work in progress. Pick the one whose effect you want:

- `cdx steer <name> "…"` adds guidance to the running turn without stopping it. Codex takes it in at its next step. Use it when `show` reveals drift that a sentence can correct.
- `cdx stop <name>` interrupts the running turn. The thread keeps everything it learned. Use it when the direction is wrong enough that continuing wastes time, or when the user asks you to stop.
- `cdx send <name> "…"` starts a new turn on a thread that is not running, usually a correction after review. It builds on the context Codex already has. If the brief itself was wrong, start a new thread with a better brief instead of arguing over several corrections.
- `cdx wait <name>` blocks until the current turn ends and prints the result. Run it in your harness's background so you are notified when the turn ends, and keep working meanwhile. Look in with `cdx show` rather than waiting blind through a long run.

## Two ways in

A single action is a one-line command:

```bash
cdx start api-auth -f brief.md --worktree -m gpt-6.1-sol -e high
cdx show api-auth
cdx wait api-auth          # in the background
cdx diff api-auth
```

When the work needs composition, such as several threads in parallel, a decision based on what one of them reported, or a review loop, write a short script and run it with `cdx run`. The script runs with `start`, `thread`, `list`, `all` and `forget` in scope, top-level `await` works, and whatever it `return`s is printed as JSON. It acts on the same threads as the commands, so you can start work in a script and look at it later with `cdx show`.

```bash
cdx run - <<'EOF'
const { readFileSync } = await import("node:fs");
const pieces = ["queue", "store"].map(name =>
  start({ name, prompt: readFileSync(`briefs/${name}.md`, "utf8"), worktree: true, model: "gpt-6.1-sol", effort: "high",
          schema: { type: "object", properties: { summary: { type: "string" }, risks: { type: "array", items: { type: "string" } } },
                    required: ["summary", "risks"], additionalProperties: false } }));
const threads = await Promise.all(pieces);
const results = await all(threads.map(t => () => t.wait()), { limit: 3 });
return results.map(r => ({ name: r.name, state: r.state, report: r.parsed, git: r.gitStatus }));
EOF
```

Each script run is a new process. Write a complete script for each round instead of re-running an edited earlier one, which would start its threads again. A name belongs to one thread: `start` refuses a name already in use.

### Script reference

- `start({ name, prompt, cwd?, worktree?, model?, effort?, sandbox?: "write" | "read", network?, addDirs?, schema? })` returns a thread handle as soon as Codex accepts the work.
- `thread(nameOrId)` returns a handle to a thread cdx started earlier. `list()` returns every one with its state.
- Each handle has these methods:
  - `status()` and `peek(n)`: state, last message, and recent steps.
  - `wait({ timeoutMs })`: the result, or `null` when the timeout passes first.
  - `result()`: how the last turn ended, or `null` while it runs.
  - `steer(text)`, `interrupt()` and `send(text, { schema, effort, model })`.
  - `diff({ stat })`: the uncommitted changes in the thread's directory.
- A result has these fields:
  - `state`, `text`, `parsed` (the reply as JSON when you passed a `schema`) and `error`.
  - `filesChanged`: Codex's patch edits only.
  - `gitStatus`: what git sees, including files written by shell commands.
  - `commands`, each with its exit code, and `durationMs`.
- `all(tasksOrThunks, { limit })` runs thunks with bounded concurrency and keeps the order.

## Choosing work and models

Codex does best with a precise contract: backend services against a given API, data models and migrations, well-specified refactors with stated invariants, tests against a spec, scripts and infra, bulk mechanical changes, or an independent second implementation or review. Keep visual frontend work, UX and copy, product judgment, and anything resting on unwritten context for yourself. A frontend task can still give Codex its non-visual plumbing behind an interface you define.

- `gpt-6.1-sol` at `high` effort is the workhorse for specified implementation; use `xhigh` for long multi-file or architecture-heavy work.
- `gpt-6-astra` at `medium` effort, or `high` when needed, is for hard algorithms, cross-module design and subtle debugging.
- `gpt-6-luna` is for mechanical edits.

Two or three threads at once is usually what you can review well.

## What must hold

- cdx offers no full-access sandbox. Do not work around that through Codex configuration.
- The brief and every file Codex reads go to OpenAI. Keep secrets, `.env` contents and private data the user has not cleared out of both.
- A thread's report is a claim. Review its changes and run the acceptance yourself before you integrate, and tell the user what Codex did, what you changed after review and what you verified.

## Housekeeping

`cdx forget <name>` removes a thread from cdx's list; Codex keeps the thread itself. Remove a finished worktree with `git worktree remove <dir>`, and delete its `cdx/<name>` branch once the work is merged or abandoned. The daemon starts on first use; `codex app-server daemon stop` stops it, so do not stop it while threads are running.
