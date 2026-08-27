# Codex Goal Watchdog

Codex Goal Watchdog 是一个本地启动器，用来降低 Codex `/goal` 因短暂网络故障、上游
服务异常或上下文耗尽而中断的概率。它不修改 Codex，而是在 Codex TUI 和
`app-server` 之间放置一个只监听本机回环地址的 WebSocket 代理。

> 这个项目依赖 Codex 的实验性 `app-server` WebSocket 接口。live smoke test 只能确认
> 几个 RPC 方法仍然存在，不能证明完整恢复协议兼容。Codex 升级后，还应做一次受监督的
> 真实 `/goal` 恢复验证，再用于长时间无人值守任务。

## 能做什么

- 识别结构化的 429、502、503、504 和连接中断等瞬时故障。
- 给 Codex 自带重试留出宽限期；同一 turn 恢复进展后，不再主动中断。
- 重试长时间没有恢复时，中断该 turn 一次，并在确认 goal 状态后继续运行。
- 终态瞬时错误已经把 goal 置为 `blocked` 时，按退避时间重新激活同一个 goal。
- 上下文窗口耗尽时，先压缩原 thread，再恢复同一个 goal。
- ChatGPT/Codex usage-limit 窗口耗尽时，读取 app-server 返回的实际窗口和 reset 时间，
  等待官方额度恢复后再激活同一个 thread 的同一个 goal。
- 本地 app-server 异常退出时，在原地址按封顶退避重启，并保持当前 TUI 与 proxy 的连接。

这不是绕过配额限制。watchdog 在官方额度恢复前不会为该 goal 发送新的执行请求，只会低频
读取额度状态；恢复后也会重新读取 goal，确认它仍为 `usageLimited` 或 `quotaExhausted` 才会
设回 `active`。人工暂停、认证失败、`budgetLimited`、API billing 的
`insufficient_quota`/credit exhausted，以及已经完成的 goal 都不会被自动恢复。

## 环境要求

- Node.js 22 或更高版本。
- 通过 npm 全局安装的 Codex CLI。
- 启动器按 Windows、macOS 和 Linux 的路径规则编写；当前只在 Windows 上完成了真实
  Codex 运行验证。Windows 另带 PowerShell 和 CMD 启动脚本。

当前开发环境使用 Node.js 22.22.1 和 Codex CLI 0.147.0。其他 Codex 版本需要重新运行
`npm run test:live` 验证协议兼容性。

## 安装

克隆仓库后，在 watchdog 仓库目录安装依赖并注册本地命令：

```bash
cd codex-watchdog
npm ci
npm link
```

`npm link` 会在当前 npm 全局前缀中注册 `codex-watchdog` 命令，不会发布 npm 包。

启动器先读取 `CODEX_WATCHDOG_CODEX_JS`；未设置时，通过 `npm root --global` 查找
`@openai/codex/bin/codex.js`。Windows 下还会兼容 `%APPDATA%\npm\node_modules`。

## 使用

之后可以离开 watchdog 仓库，在任意目标项目目录运行：

```bash
codex-watchdog
```

也可以明确指定工作目录，并继续传入普通 Codex 参数：

```bash
codex-watchdog -C /path/to/project
```

Windows PowerShell：

```powershell
& "C:\tools\codex-watchdog\bin\codex-watchdog.ps1" -C "C:\work\repo"
```

Windows CMD：

```bat
C:\tools\codex-watchdog\bin\codex-watchdog.cmd -C C:\work\repo
```

未传 `-C` 或 `--cd` 时，watchdog 会把当前目录显式传给 Codex。这样执行
`resume` 时仍按当前工作区筛选会话：

```bash
codex-watchdog resume
codex-watchdog resume --all
```

不要手动传入 `--remote`。代理地址由 watchdog 创建，额外的 `--remote` 会绕过恢复链，
因此启动器会直接拒绝。

## 配置

| 环境变量 | 作用 | 默认值 |
|---|---|---|
| `CODEX_WATCHDOG_CODEX_JS` | 指定 Codex 的 `codex.js` 入口 | 自动查找全局 npm 安装 |
| `CODEX_WATCHDOG_DELAYS_MS` | 逗号分隔的恢复退避时间，单位毫秒 | `30000,60000,120000,300000` |
| `CODEX_WATCHDOG_INTERRUPT_AFTER_MS` | Codex 持续重试多久后允许中断当前 turn | `120000` |
| `CODEX_WATCHDOG_QUOTA_POLL_MS` | quota 数据未知、缺少 reset 时间或查询暂时失败时的轮询间隔 | `60000` |
| `CODEX_WATCHDOG_QUOTA_RESET_GRACE_MS` | 官方 reset 时间之后额外等待的边界宽限 | `10000` |

临时缩短退避时间进行测试：

```powershell
$env:CODEX_WATCHDOG_DELAYS_MS = "1000,2000,5000"
$env:CODEX_WATCHDOG_INTERRUPT_AFTER_MS = "10000"
$env:CODEX_WATCHDOG_QUOTA_POLL_MS = "5000"
$env:CODEX_WATCHDOG_QUOTA_RESET_GRACE_MS = "1000"
```

## 工作原理

```text
Codex TUI -> watchdog WebSocket proxy -> Codex app-server -> provider
```

代理原样转发 TUI 和 app-server 的常规消息，同时监听带 `threadId` 和 `turnId` 的结构化
事件。恢复期间只会按需发送以下内部请求：

- `thread/goal/get`：恢复前重新读取 goal 状态。
- `account/rateLimits/read`：读取 Codex quota 窗口的 `usedPercent`、
  `windowDurationMins` 和服务端 `resetsAt`。
- `turn/interrupt`：仍在重试且超过宽限期时，对同一 turn 最多发送一次。
- `thread/compact/start`：上下文耗尽时压缩原 thread。
- `thread/goal/set`：turn 结束或压缩完成后，把可恢复的 goal 设回 `active`。

如果同一 turn 又出现 `item/*` 进展，待执行的中断会被取消。watchdog 发起中断后，单独
收到 `active` 状态不足以证明 Codex 已经继续；只有新的 turn 真正开始，才会取消待执行
的恢复。

app-server WebSocket 断开后，普通模式会保留 TUI 连接，并在同一地址重启 app-server。
代理只重放 `initialize` 和 `initialized` 握手；已经发送过的 turn、prompt、goal 或压缩
请求不会自动重放。断线期间新发出的业务请求也不会排队到下一代 app-server；带 ID 的请求
会收到明确的“未发送”错误。这样可以避免连接抖动直接拖着 Codex TUI 退出，也不会让 watchdog
接管 session 或代替 Codex 的 `resume`。

更完整的取舍和协议边界见
[ADR-0001](docs/adr/0001-app-server-transient-goal-recovery.md)。

## 日志和安全边界

普通运行日志写入 `logs/watchdog-YYYY-MM-DD.log`，该目录不会进入 Git。日志可能包含
app-server 的错误信息，分享前仍应检查是否带有项目路径或其他敏感上下文。

watchdog 只监听 `127.0.0.1`，不提供远程服务，也不接管 Codex 的认证配置。它会主动
中断满足条件的 turn；如果该 turn 已经执行过有副作用的工具操作，后续恢复可能再次执行
相关步骤。无人值守运行前，应确保任务本身可以安全重试。

## 验证

运行单元测试和代理集成测试：

```bash
npm test
npm run check
```

Codex 安装或升级后，运行真实 app-server 协议 smoke test：

```bash
npm run test:live
```

live test 会启动本机已安装的 Codex app-server，确认 WebSocket 初始化、
`account/rateLimits/read`、`turn/interrupt` 和 `thread/compact/start` 方法仍然存在，并确认
当前 rate-limit 返回结构可以由 watchdog 解析。它不会消耗额度、修改用户 Goal 或制造真实
provider 故障，也不会覆盖 `thread/goal/*` 和全部通知结构，因此不能单独作为版本兼容证明。

`npm run test:cli` 还会打包并安装当前仓库，用 fake app-server 验证进程崩溃后能在原地址
换代，TUI WebSocket 保持连接，并在重新握手后继续收发请求。

## 目录

```text
bin/        Windows 启动脚本
src/        启动器、代理、恢复控制器和错误分类
test/       单元测试、代理集成测试和 live smoke test
docs/adr/   架构决策记录
```

## 社区鸣谢
[Linux.do](https://linux.do)

## 许可证

本项目使用 [MIT License](LICENSE)。


