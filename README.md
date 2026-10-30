# cdx

Delegate work to Codex threads that keep running in Codex's own app-server daemon, and steer, stop, continue and review them from a one-line command or a short script.

- **Host:** Codex's `app-server daemon`, which cdx reaches over its control socket (a WebSocket over a Unix socket). cdx runs no daemon of its own, and a thread outlives the command or script that started it.
- **State:** Codex owns every thread. cdx remembers only which threads it started, under which name and in which directory, in `~/.cdx/threads.json` (`CDX_HOME` overrides it).
- **Two ways in:** `cdx <command>` for single actions, and `cdx run <script>` for composition. Both act on the same threads.
- **Agent guidance:** [`skills/cdx/SKILL.md`](skills/cdx/SKILL.md).

```bash
npm install
node bin/cdx.mjs help
```

Requires Node 20+ and a signed-in Codex CLI (`codex login`). Status: prototype, checked against codex-cli 0.162.
