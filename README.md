# DSH Chat for VS Code

在 VS Code 里直接用 **DeepSeek Harness（DSH）** 的智能体。这不是一个聊天玩具——聊天面板背后是完整的 DSH agent：它可以读取、创建、修改工作区文件，运行命令，搜索网页，并行委派子任务，然后把每一步工具调用实时展示在聊天流里。

> 参考了 OpenCode / Claude Code / Cline 的 VS Code 插件形态，但**调用的是 DSH 本身**：插件通过 DSH 的 HTTP RPC（`/api/*`）和 WebSocket 事件流（`/api/events.mux`、`/api/events.host`）连接正在运行的 DSH 实例，复用它的全部 agent 能力。

## 特性

- 🪟 **纯编辑器窗口形态（OpenCode 式）**：DSH Chat 是编辑器区里的独立窗口，与代码窗口平级——**每个窗口 = 一个完整的会话工作区**：自带会话 tab 栏、＋新建、🪟再开新窗口、📜历史、模型路由、问题卡片。窗口想开几个开几个，拖到任意编辑器组分屏并行。
- 🔒 **窗口之间完全独立**：新窗口永远创建**全新的独立会话**（全新上下文），各窗口各聊各的、互不同步；同一窗口内可切换会话 tab（共享 DSH 会话池，各窗口激活互不影响）。
- 🖥 **入口**：编辑器右上角 💬 按钮 / `Ctrl+Alt+D` / 状态栏 🐳 / 命令 `DSH: New Chat Window`——全部是"开一个独立窗口"。
- 📑 **会话历史**：窗口内 📜 按钮列出当前工作区的全部历史会话，一键切换/继续旧对话。
- ❓ **Agent 提问卡片**：agent 调用 `ask_user_question` 时弹出问题卡片（单选/多选/自定义输入），回答后 agent 继续，不再卡死。
- 🤖 **真正的 agent**：会话绑定当前工作区（`cwd`），DSH 的 `standard` preset 自带文件读写、终端、搜索、子代理等全套工具——让它"直接改文件"，它就真的改。
- 🧭 **模型自动路由**（可手动覆盖）：
  - 规划 / 架构 / 设计类问题 → **DeepSeek Pro**（`deepseek-v4-pro`，`reasoningEffort=max`）
  - 实现、修 bug 等杂活 → **DeepSeek Flash**（`deepseek-v4-flash`）
  - 上一轮失败后自动升级 → **Pro Max**（`deepseek-v4-pro-max`）；若模型不在可用目录中，自动回退 Pro → Flash 并提示
  - 面板头部下拉可手动固定 Auto / Flash / Pro / Pro Max
- 💾 **会话持久化**：按工作区复用 DSH 会话，重启 VS Code 后历史自动恢复（含每回合使用的模型名）。
- ⌨ **VS Code 联动**：
  - 编辑器右上角 💬 按钮一键开窗口；选中代码时出现 ❓（解释）和 🐛（修复）按钮
  - 右键选中代码 → 「DSH: Ask About Selection」/「DSH: Debug / Fix Selection」（自动附带文件路径、行号、代码块，并打开新窗口）
  - 快捷键 `Ctrl+Alt+D`（macOS `Cmd+Alt+D`）开新窗口
  - 状态栏 🐳 一键开窗口
- 🛑 **可取消**：运行中点「停止」，回合状态正确显示「已停止」。

## 前置条件

- 正在运行的 **DSH 实例**（默认 `http://127.0.0.1:3080`）。插件直接连它的 HTTP/WS API——不需要浏览器 GUI 打开，DSH 进程活着即可。用 `dsh web` 启动，或通过 DSH CLI 的 web 模式。
- 模型由 DSH 侧配置（provider 路由与凭证）。默认 provider：`deepseek-official`。

## 安装

### 方式一：VSIX 安装（推荐）

```bash
npm install
npm run compile
npm run package     # 生成 dsh4vscode-0.1.0.vsix
```

然后在 VS Code 中：扩展面板 → `...` → **Install from VSIX**，选择生成的 `.vsix`。

### 方式二：开发模式（Extension Development Host）

```bash
npm install
npm run compile
code --extensionDevelopmentPath=<本目录>
```

## 配置（settings.json）

| 设置 | 默认 | 说明 |
|---|---|---|
| `dsh.baseUrl` | `http://127.0.0.1:3080` | DSH web 服务器地址 |
| `dsh.provider` | `deepseek-official` | 模型路由使用的 provider |
| `dsh.models.flash` | `deepseek-v4-flash` | 杂活模型 |
| `dsh.models.pro` | `deepseek-v4-pro` | 规划/架构模型 |
| `dsh.models.proMax` | `deepseek-v4-pro-max` | 疑难调试模型（不可用自动回退） |
| `dsh.reasoningEfforts` | `{flash: high, pro: max, proMax: max}` | 各模型推理强度 |
| `dsh.autoRoute` | `true` | 自动路由开关 |
| `dsh.escalateOnFailure` | `true` | 回合失败后自动升级模型 |
| `dsh.workspacePath` | `""` | 覆盖会话 cwd（空 = 第一个工作区文件夹） |
| `dsh.agentPreset` | `standard` | 创建会话使用的 agent preset |

## 架构

```
src/
├── extension.ts          # 入口：命令、状态栏、面板注册
├── dsh/
│   ├── client.ts         # DSH HTTP RPC (/api/<method>) + WebSocket 双事件流 + 自动重连
│   ├── controller.ts     # 会话管理、回合模型、事件→聊天模型、模型路由与回退
│   ├── router.ts         # 提示词分类（架构/规划 → pro）+ 失败升级策略
│   ├── config.ts         # dsh.* 设置类型化访问
│   └── types.ts          # DSH wire 协议类型（与 packages/host/apiproxy 对齐）
└── webview/
    ├── panel.ts          # WebviewViewProvider + 消息桥
    └── media/            # 前端：main.js / style.css / vendor/markdown-it.min.js
```

### 协议要点（DSH web API）

- `POST /api/<method>`：JSON-RPC 信封 `{type:'client-request', rpcId, method, payload}` → `{type:'server-response', result:{ok, value|error}}`
- `ws /api/events.mux`：会话事件流（`session/event`、`session/subscribed`、`approval/*`、`question/*` 等）
- `ws /api/events.host`：宿主状态流（`host/session-status` 运行翻转、`host/session-added` 等）
- 关键方法：`session.list` / `session.create` / `session.history` / `session.prompt` / `session.cancel` / `session.models` / `session.selectModel`

## 已知说明

- 开发模式下 VS Code 会提示 "webview without a content security policy"——这是 VS Code 对 webview **初始空 HTML** 的固定提示，本插件实际设置了完整 CSP，仅开发环境可见，可忽略。
- `deepseek-v4-pro-max` 若当前 provider 不可路由（例如官方 API 仅暴露 `pro`/`flash`），会自动回退到 `pro` 并在面板提示。

## License

MIT
