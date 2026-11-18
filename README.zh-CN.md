# cdx

[English](README.md) | 简体中文

将任务委派给运行在 Codex 自带 `app-server daemon` 中的持久化线程，并通过单行 CLI 命令或简短的 JavaScript 脚本随时查看、引导（steer）、中断、追问和审查结果。

## 工作原理

- **无独立守护进程：** `cdx` 通过本地 Unix 控制套接字（`~/.codex/app-server-control/app-server-control.sock`，支持 `CODEX_HOME`）直接连接 Codex 的 `app-server daemon`，首次使用时会自动拉起守护进程。`cdx` 命令退出后，后台线程仍会继续执行。
- **轻量本地索引：** 线程状态完全由 Codex 持有。`cdx` 仅在 `~/.cdx/threads.json`（可通过 `CDX_HOME` 覆盖）中记录自己创建的线程名称、原生 ID、工作目录和起始提交。
- **Git Worktree 隔离：** 传入 `--worktree` 会基于当前 `HEAD` 在 `~/.cdx/worktrees/<repo>-<name>` 创建独立工作树与 `cdx/<name>` 分支，让多个并行写入线程互不干扰。
- **两种调用方式：** 单次操作用 `cdx <command>`，多任务编排用 `cdx run` 脚本；两者操作同一批线程，可随时混用。
- **支持图像生成与编辑：** 可通过 `-i` 附加本地参考图或待编辑图片，并回收 Codex 生成的位图文件路径。

## 环境要求与安装

- **Node.js 20+**
- **Codex CLI** 且已完成登录（`codex login`；当前原型已在 macOS/Linux 下针对 `codex-cli` 0.162 验证）

```bash
npm install
npm link        # 可选：将 `cdx` 链接到全局 PATH（也可直接运行 `node bin/cdx.mjs`）
cdx help
```

运行隔离回归测试：

```bash
npm test
```

## 快速上手

在独立 worktree 中启动后台线程、查看进度、微调方向、审查 diff 并清理记录：

```bash
# 从任务说明文件启动线程，使用独立 git worktree
cdx start api-auth -f brief.md --worktree -m gpt-6.1-sol -e high

# 查看所有线程状态与最近执行步骤
cdx ls
cdx show api-auth

# 在不打断当前轮次的情况下向运行中的线程补充指令
cdx steer api-auth "保持对现有 session token 格式的向后兼容"

# 等待当前轮次结束，并查看任务启动以来的全部代码变更
cdx wait api-auth
cdx diff api-auth

# 在同一线程上发起新一轮修改，或将其从 cdx 索引中移除
cdx send api-auth "补充过期 token 的单元测试" --wait
cdx forget api-auth
```

## CLI 命令速查

| 命令 | 说明 |
| --- | --- |
| `cdx start <name> [prompt]` | 启动新线程（支持 `-f file`、`-C dir`、`--worktree`、`-m model`、`-e effort`、`--read-only`、`--net`、`--add-dir dir`、`-i image`、`--schema file.json`、`--wait`） |
| `cdx ls` | 列出 `cdx` 启动的线程及其当前状态 |
| `cdx show <name> [-n 15]` | 查看线程状态及最近 `n` 步执行记录 |
| `cdx wait <name> [--timeout 30m]` | 阻塞等待当前轮次结束并输出结果 |
| `cdx result <name>` | 查看上一轮次的结束状态与输出 |
| `cdx steer <name> <text\|-f file>` | 向正在运行的轮次追加引导信息（不中断执行） |
| `cdx send <name> <text\|-f file>` | 在已停止的线程上发起新一轮对话（支持 `-i image`、`--schema file.json`、`-m`、`-e`、`--wait`） |
| `cdx stop <name>` | 中断当前正在运行的轮次 |
| `cdx diff <name> [--stat]` | 查看线程启动以来的已提交与未提交变更 |
| `cdx forget <name>` | 从 `cdx` 索引中移除该线程（Codex 内部仍保留原线程） |
| `cdx run <script.mjs \| - \| -e code>` | 运行内置 `start`、`thread`、`list`、`all`、`forget` 的异步脚本 |
| `cdx report <text\|-f file> [--thread name]` | 将 `cdx` 自身的问题诊断报告记录到 `~/.cdx/reports/` |

所有命令均可加 `--json` 输出机器可读的 JSON；提示词与消息文本也支持通过 `stdin` 管道传入。

## 使用 `cdx run` 编排脚本

需要并行分发多个子任务、约束 JSON Schema 输出或编写多轮审查循环时，可使用 `cdx run`。脚本内支持顶层 `await`，`return` 的值会自动序列化为 JSON 输出：

```bash
cdx run - <<'EOF'
const jobs = ["queue", "store"].map((name) =>
  start({
    name,
    prompt: `按 SPEC.md 实现 ${name} 模块并运行 npm test。`,
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

## Agent Skill 集成

[`skills/cdx/`](skills/cdx/SKILL.md) 提供了面向编程 Agent（如 Claude Code、Antigravity 等）的完整技能说明，涵盖任务简报（brief）编写规范、worktree 并发隔离、代码审查流程以及[位图生成与编辑指南](skills/cdx/references/image-generation.md)。

将其软链接到对应 Agent 的技能目录即可启用：

```bash
# 示例：Claude Code
ln -s "$(pwd)/skills/cdx" ~/.claude/skills/cdx

# 示例：Antigravity
ln -s "$(pwd)/skills/cdx" ~/.gemini/config/skills/cdx
```

## 可靠性说明

- **基线提交对比：** 新启动的任务会记录起始 `HEAD` 提交，`cdx diff` 会同时包含后续新增提交与工作区未提交变更；无基线记录的旧任务则与当前 `HEAD` 对比。若多个写入者共用同一目录，diff 可能包含其他写入者的改动。
- **异常启动保留现场：** 启动失败或超时的任务会保留在 `~/.cdx/threads.json` 中（标记为 `pending:<name>` 或 `failed-or-unknown`），不会被静默丢弃。重发或 `forget` 前请先用 `cdx show` / `cdx result` 检查，因为超时的请求可能已被服务端接收；对应的 worktree 也会保留以便恢复。
- **RPC 超时与不自动重放：** 单次 RPC 调用超时时间为 30 秒。后续命令会自动重连，但所有写操作绝不会在后台自动重放。
- **文件锁与原子写入：** `threads.json` 更新采用锁文件（`threads.json.lock`）加临时文件原子替换。若进程在持锁期间崩溃，请先确认没有其他活跃的 `cdx` 写入进程，再手动删除残留锁文件。

## 开源协议

[MIT](LICENSE)
