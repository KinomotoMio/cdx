# cdx

English | [简体中文](README.zh-CN.md)

Delegate work to persistent Codex threads hosted by Codex's own `app-server daemon`, then inspect, steer, stop, continue, and review them from a one-line CLI command or a short JavaScript script.

## How it works

- **No custom daemon:** `cdx` talks to Codex's `app-server daemon` over its local Unix control socket (`~/.codex/app-server-control/app-server-control.sock`, respecting `CODEX_HOME`), starting the daemon on first use if needed. Threads keep running after `cdx` exits.
- **Thin local index:** Codex owns every thread's state. `cdx` only records which threads it started—name, native thread ID, working directory, and baseline commit—in `~/.cdx/threads.json` (`CDX_HOME` overrides this directory).
- **Isolated git worktrees:** Passing `--worktree` creates a dedicated worktree under `~/.cdx/worktrees/<repo>-<name>` on branch `cdx/<name>` cut from `HEAD`, so parallel threads can edit without stepping on each other.
- **Two ways in:** Use `cdx <command>` for single operations and `cdx run` to orchestrate multiple threads in JavaScript. Both act on the same threads.
- **Images as well as code:** Threads can attach local reference/target images (`-i`) and return raster images generated or edited by Codex.

## Requirements & setup

- **Node.js 20+**
- **Codex CLI** signed in via `codex login` (prototype checked against `codex-cli` 0.162 on macOS/Linux)

```bash
npm install
npm link        # optional: puts `cdx` on your PATH (otherwise run `node bin/cdx.mjs`)
cdx help
```

Run the isolated regression suite with:

```bash
npm test
```

## Quick start

Start a task in its own git worktree, check on its progress, review the diff, and clean up:

```bash
# Start a background thread from a brief file in an isolated worktree
cdx start api-auth -f brief.md --worktree -m gpt-6.1-sol -e high

# Inspect active threads and recent steps
cdx ls
cdx show api-auth

# Nudge a running turn without interrupting it
cdx steer api-auth "Keep backwards compatibility for existing session tokens"

# Wait for the turn to finish and inspect all changes since task start
cdx wait api-auth
cdx diff api-auth

# Ask for a follow-up turn on the same thread, or drop it from cdx's index
cdx send api-auth "Add a unit test for expired tokens" --wait
cdx forget api-auth
```

## CLI reference

| Command | Description |
| --- | --- |
| `cdx start <name> [prompt]` | Start a thread (`-f file`, `-C dir`, `--worktree`, `-m model`, `-e effort`, `--read-only`, `--net`, `--add-dir dir`, `-i image`, `--schema file.json`, `--wait`) |
| `cdx ls` | List threads started by `cdx` with their current state |
| `cdx show <name> [-n 15]` | Show thread state and its latest `n` steps |
| `cdx wait <name> [--timeout 30m]` | Block until the current turn finishes and print its result |
| `cdx result <name>` | Print how the last turn ended |
| `cdx steer <name> <text\|-f file>` | Add guidance to a running turn without stopping it |
| `cdx send <name> <text\|-f file>` | Start a new turn on a stopped thread (`-i image`, `--schema file.json`, `-m`, `-e`, `--wait`) |
| `cdx stop <name>` | Interrupt the running turn |
| `cdx diff <name> [--stat]` | Show committed and uncommitted changes since the thread started |
| `cdx forget <name>` | Remove the thread from `cdx`'s index (Codex keeps the underlying thread) |
| `cdx run <script.mjs \| - \| -e code>` | Run an async script with `start`, `thread`, `list`, `all`, and `forget` in scope |
| `cdx report <text\|-f file> [--thread name]` | Save a diagnostic report for `cdx` itself under `~/.cdx/reports/` |

Pass `--json` to any command for machine-readable JSON output. Prompts and messages can also be piped via `stdin`.

## Scripting with `cdx run`

When fanning out across parallel tasks, enforcing structured JSON output (`schema`), or running multi-step review loops, use `cdx run`. Top-level `await` is supported, and any returned value is printed as JSON:

```bash
cdx run - <<'EOF'
const jobs = ["queue", "store"].map((name) =>
  start({
    name,
    prompt: `Implement the ${name} module according to SPEC.md and run npm test.`,
    worktree: true,
    sandbox: "write",
    schema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        risks: { type: "array", items: { type: "string" } },
      },
      required: ["summary", "risks"],
      additionalProperties: false,
    },
  })
);

const threads = await Promise.all(jobs);
const results = await all(threads.map((t) => () => t.wait()), { limit: 2 });
return results.map((r) => ({ name: r.name, state: r.state, report: r.parsed, git: r.gitStatus }));
EOF
```

## Agent skill

[`skills/cdx/`](skills/cdx/SKILL.md) packages `cdx` as a reusable skill for coding agents (such as Claude Code, Antigravity, or Cursor), including guidance on writing self-contained briefs, worktree isolation, reviewing diffs, and [generating/editing raster images](skills/cdx/references/image-generation.md).

Symlink it into your agent's skill directory to enable it:

```bash
# Example: Claude Code
ln -s "$(pwd)/skills/cdx" ~/.claude/skills/cdx

# Example: Antigravity
ln -s "$(pwd)/skills/cdx" ~/.gemini/config/skills/cdx
```

## Reliability notes

- **Baseline diffs:** New tasks record their starting `HEAD` commit; `cdx diff` includes both subsequent commits and uncommitted working-tree changes. Older entries without a recorded baseline compare against `HEAD`. Diffs in shared directories may include other writers' changes.
- **Uncertain startups stay inspectable:** Failed or timed-out starts remain in `~/.cdx/threads.json` (`pending:<name>` or `failed-or-unknown`) rather than being silently discarded. Check `cdx show` / `cdx result` before retrying or forgetting—a timed-out RPC may still have reached the daemon. Worktrees are retained for recovery.
- **Timeouts & no auto-replay:** RPC calls time out after 30 seconds. Subsequent commands reconnect automatically, and mutations are never replayed behind your back.
- **Locked atomic index writes:** Updates to `threads.json` use a lockfile (`threads.json.lock`) and atomic rename. If a process crashes mid-write, confirm no other `cdx` process is active before removing a stale lockfile.

## License

[MIT](LICENSE)
