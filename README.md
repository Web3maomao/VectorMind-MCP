# VectorMind MCP（Requirement-Driven）

VectorMind 是一个 **“以需求为核心”的 MCP 上下文记忆工具**：把每一次代码修改都绑定到一个明确的需求意图（Intent），让你在和 AI 反复对话、切换会话、隔天继续时，**不再靠 AI 盲猜“为什么改这段代码”**。

## 它解决什么问题

- **AI 经常丢上下文**：隔一段时间/换个会话，AI 不知道当前在做哪个需求、改动做到哪一步。
- **改动没有“为什么”**：Git 记录了“改了什么”，但很少记录“为什么这么改/当时的目标是什么”。
- **代码库定位靠猜**：想找某个类/函数在哪里，AI 容易给出错误路径或过时结论。

VectorMind 通过本地文件监听 + SQLite 关系记忆，把“需求 → 改动意图 → 文件/符号索引”串起来，帮助 AI **恢复进度、追溯意图、快速定位代码**。

## 关键能力（What you get）

- **需求追踪（requirements）**：在写代码前创建/激活一个需求，明确目标与业务背景。
- **改动意图归档（change_logs）**：每次保存后把“改动意图 + 影响文件”写入数据库，并关联到当前激活需求。
- **符号索引（symbols）**：实时维护类/函数/类型等符号表，用于快速 query 定位定义位置。
- **项目总结 & 笔记（memory_items）**：把“项目总结/关键决策/约束/待办”等上下文以结构化条目持久化到本地。
- **代码片段 & 文档分块索引（memory_items）**：监听文件变更，把代码/文档切成可检索的 chunk 存入本地。
- **上下文检索（semantic_search）**：默认使用本地 SQLite FTS 做召回（无需模型）；可选开启 embeddings，用向量相似度增强语义召回。
- **会话恢复（brain dump）**：新会话开始时一键拉取最近需求与对应的改动意图，AI 直接接着做。

## 工作流（强烈推荐）

1) **新会话开始**：AI 先调用 `bootstrap_context({ query: 当前目标 })`（或 `get_brain_dump()`）恢复上下文并做一次语义召回  
2) **准备开始写代码前**：AI 调用 `start_requirement(title, background)`  
3) **每次改完并保存后**：AI 调用 `get_pending_changes()` 查看待同步文件，再调用 `sync_change_intent(intent, files)`（可省略 files 让服务端自动关联所有 pending）  
4) **阶段性收口**（重要）：AI 在对话里写好总结，然后调用 `upsert_project_summary(summary)`/`add_note(...)` 持久化  
5) **需要找代码定义时**：AI 调用 `query_codebase(query)`（不要靠猜）  
6) **需要按语义找上下文/代码/文档时**：AI 调用 `semantic_search(query, ...)`（不要靠猜）

> 本 MCP Server 会在初始化时下发 `instructions`，提示 AI 按以上流程调用工具（避免盲猜）。

## MCP Tools

### `start_requirement`
- 入参：`{ title: string, background?: string }`
- 用途：创建并激活一个需求（后续改动意图会自动关联到最新 `active` 需求）

### `sync_change_intent`
- 入参：`{ intent: string, files?: string[], affected_files?: string[] }`
- 用途：把“这次改动的意图摘要”写入 `change_logs`，并与当前激活需求关联  
- 说明：如果不传 `files`，服务端会自动把“最近未同步的文件变更（pending）”关联到本次意图；如果没有激活需求，会返回错误并提示先 `start_requirement`

### `get_brain_dump`
- 入参：`{}`
- 用途：返回最近 5 个需求，以及每个需求最近的改动意图（用于会话恢复）

### `bootstrap_context`
- 入参：`{ query?: string, top_k?: number, kinds?: string[], include_content?: boolean }`
- 用途：返回 brain dump + pending changes；如果传入 `query`，会额外返回本地记忆库的检索结果（推荐新会话开始就用它）

### `get_pending_changes`
- 入参：`{}`
- 用途：返回本地“已发生变更但尚未被 sync_change_intent 确认”的文件列表（便于 AI 不漏同步）

### `query_codebase`
- 入参：`{ query: string }`
- 用途：按名称/签名模糊搜索 `symbols`，返回匹配的 `file_path` 与 `signature`

### `upsert_project_summary`
- 入参：`{ summary: string }`
- 用途：保存/更新“项目级上下文总结”（由 AI 在对话里写好再保存），用于跨会话快速恢复

### `add_note`
- 入参：`{ title?: string, content: string, tags?: string[] }`
- 用途：保存一条“可持久化的项目笔记”（决策、约束、TODO、架构说明等）

### `semantic_search`
- 入参：`{ query: string, top_k?: number, kinds?: string[], include_content?: boolean }`
- 用途：对本地记忆库进行检索（覆盖需求/意图/笔记/项目总结/代码 chunk/文档 chunk）。如启用 embeddings，会优先走向量相似度；否则使用本地 FTS/LIKE。

## 本地数据与监听

- 数据库：默认使用 MCP `roots/list` 提供的 workspace root（否则回退到 `process.cwd()`，也可用 `VECTORMIND_ROOT` 强制指定）创建 `.vectormind/vectormind.db`（默认已在 `.gitignore` 中忽略整个 `.vectormind/` 目录）
- 监听范围：默认监听 workspace root（同上）下文件变动（忽略 `.git/`、`node_modules/`、`dist/`、数据库文件）
- 符号抽取：目前为轻量正则抽取（非 AST 解析），支持常见语言如 TS/JS、Python、Go、Rust、C/C++
- 检索：默认使用本地 SQLite FTS（无需模型）；当你设置 `VECTORMIND_EMBEDDINGS=on` 才会启用向量化（`@xenova/transformers`），并优先用向量相似度做语义召回（首次启用可能下载模型权重，向量与数据都在本地）

## 检索/向量化配置（可选）

- `VECTORMIND_ROOT=...`：强制指定“项目根目录”（当你的 MCP Client 无法提供 workspace roots 或启动目录不对时使用）
- `VECTORMIND_EMBEDDINGS=on|off`：是否启用向量化（默认 `off`；开启后会启动本地 embedding 模型，`semantic_search` 优先走向量相似度；关闭则走本地 FTS/LIKE，不会生成向量/启动模型）
- `VECTORMIND_EMBED_FILES=all|changed|none`：控制是否向量化“代码/文档 chunk”（默认 `all`；`none` 只影响 chunk，仍会向量化需求/意图/笔记/总结；`changed` 仅在 change/manual 时向量化 chunk）
- `VECTORMIND_EMBED_MODEL=...`：指定 embedding 模型（默认 `Xenova/all-MiniLM-L6-v2`）
- `VECTORMIND_EMBED_CACHE_DIR=...`：指定模型缓存目录
- `VECTORMIND_ALLOW_REMOTE_MODELS=false`：禁止下载远端模型（适合离线环境）

## 安装与运行

### 本地开发运行

```bash
npm install
npm run build
node dist/index.js
```

## 发布到 NPM（建议）

1) 修改 `package.json` 的 `name` 为你的实际包名（例如 `@coreyuan/vector-mind`）  
2) 登录并发布：

```bash
npm login
npm publish
```

> 说明：已配置 `prepublishOnly`（发布前自动 `npm run build`）与 `publishConfig.access=public`（适用于 scoped 包）。

## 快速测试（Smoke）

```bash
# 只测工具/索引/同步流程（不下载 embedding 模型）
npm run smoke

# 测试向量化 + 语义检索（首次会下载本地模型权重）
npm run smoke -- --embeddings=on
```

### 以 NPM 包方式运行（发布后）

```bash
npx -y @coreyuan/vector-mind
```

## 在 MCP Client 中配置（stdio）

不同客户端配置格式略有差异，但核心都是：用 `stdio` 启动一个命令。

- 本地构建版本（示例）：
  - `command`: `node`
  - `args`: `["/absolute/path/to/your/project/dist/index.js"]`

- 发布后（示例）：
  - `command`: `npx`
  - `args`: `["-y", "@coreyuan/vector-mind"]`

通常情况下客户端会通过 MCP `roots/list` 自动提供 workspace root，因此无需写死目录，配置如下：

> 如果客户端不支持或不响应 `roots/list`，VectorMind 会快速回退到 `process.cwd()`（可用 `VECTORMIND_ROOTS_TIMEOUT_MS` 调整 roots 请求超时时间，默认 750ms）。
```json
{
  "command": "npx",
  "args": ["-y", "@coreyuan/vector-mind"]
}
```

如果你发现 `.vectormind/vectormind.db` 落在了错误目录（或你的 MCP Client 不支持 `roots/list`），再加上：
```json
{
  "command": "npx",
  "args": ["-y", "@coreyuan/vector-mind"],
  "env": { "VECTORMIND_ROOT": "H:\\\\path\\\\to\\\\your-project" }
}
```

### Codex（`config.toml`）：不要固定 MCP Server 的 `cwd`（让它跟随项目）

Codex 目前不会通过 MCP `roots/list` 提供 workspace roots；因此要实现“每个项目一个 `<project>/.vectormind/`”，推荐两种方式：

1) **让 Codex 在你的项目目录启动**（或用 `codex -C <project>` 指定工作目录），然后 VectorMind 就会用 `process.cwd()` 作为 `project_root`。
2) **在每次工具调用里显式传 `project_root`**（当你的 Codex/VS Code 启动 MCP server 的工作目录不等于项目根目录时尤其有用）。

> `project_root` 可以作为 VectorMind 所有 tools 的可选参数；一旦提供，VectorMind 会切换到该项目并在 `<project_root>/.vectormind/` 下读写数据库与索引。

```toml
[mcp_servers.vector-mind]
type = "stdio"
command = "npx"
args = ["-y", "@coreyuan/vector-mind"]
# 不要设置 cwd：让它跟随 Codex 的工作目录（也就是你的项目目录）
```

**不要在全局 `config.toml` 里写死：**
- `cwd = "..."`（会把 VectorMind 锁死到一个项目）
- `env = { VECTORMIND_ROOT = "..." }`（同样会锁死到一个项目）

> 如果你确实要固定到单一项目（少见）：那就可以设置 `cwd` 或 `VECTORMIND_ROOT`；但这会破坏“多项目隔离”。

配置完成后，客户端会在初始化阶段拿到该服务器的 tools + instructions；AI 就能“知道它存在”，并在需要时调用，而不是盲猜。

## Skills（可选：让用户“无感”自动调用）

> 说明：Skill 不是跨所有 AI 通用标准，不同客户端的“Skill”格式不同；但 MCP Server 本身是通用的（支持 MCP 的客户端都能用）。

### Codex Skills（OpenAI Codex）

- 安装：把 `skills/vector-mind-autopilot` 复制到 `~/.codex/skills/vector-mind-autopilot`（Windows: `C:\Users\<you>\.codex\skills\vector-mind-autopilot`），或直接使用打包文件 `skill-dist/vector-mind-autopilot.skill`
- 使用：重启后正常聊天即可；如未触发，可在对话里提一次 `$vector-mind-autopilot`

### Claude Skills（Claude Code / myclaude）

- 安装：把仓库里的 `skills/vector-mind` 复制到 `~/.claude/skills/vector-mind`（Windows: `C:\Users\<you>\.claude\skills\vector-mind`）
- 使用：重启后就会被识别为一个 Skill（可配合 `.claude/skills/skill-rules.json` 加关键词触发）

### Claude Desktop（Project Instructions）

- MCP 配置参考：`skills/vector-mind-autopilot/references/claude-desktop-mcp-config.json`
- 指令参考（复制到 Project Instructions / Custom Instructions）：`skills/vector-mind-autopilot/references/claude-project-instructions.md`

## 典型示例

你：我想加“用户头像上传功能”。  
AI：调用 `start_requirement("用户头像上传功能", "支持 PNG/JPG")`。  
你/AI：改完 `upload.ts` 和 `user.model.ts` 并保存。  
AI：调用 `sync_change_intent("增加 Multer 配置，并在 user model 增加 avatar 字段", ["upload.ts","user.model.ts"])`。  
AI：在对话里写一段阶段总结后，调用 `upsert_project_summary("...")`。  
下次新会话：AI 先 `get_brain_dump()`，再用 `semantic_search("头像上传下一步是什么？")` 快速定位相关上下文与代码位置。

## 注意事项

- `sync_change_intent` 只会关联到“最近的 active 需求”；如需并行多需求，建议先把一个需求标记完成（当前版本未提供 completion tool）。
- 符号索引是启发式的，复杂语法/宏/生成代码可能不完整；如需更高精度，可扩展为 AST/语言服务器方案。

使用方式

你可以直接发这句来测试（推荐新会话第一句就这么发）：
```
请先调用 vector-mind 的 bootstrap_context({ query: "我现在要做什么？" })，把返回的 JSON 原样贴出来，然后再继续回答。
```
怎么确认它真的调用了：

对话里会出现一次 tool 调用记录/卡片（不同客户端 UI 不一样）
或者你让它把 bootstrap_context 返回的 JSON 原样输出（里面会有 ok: true；新版还会带 project_root/db_path 用来确认落库位置）

如果你希望“每次都自动调用”，就在你的固定/system 指令里加一句：

```
每次新会话开始先调用 bootstrap_context，再开始分析/改代码。
```
