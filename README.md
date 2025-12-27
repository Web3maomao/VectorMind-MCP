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
- **会话恢复（brain dump）**：新会话开始时一键拉取最近需求与对应的改动意图，AI 直接接着做。

## 工作流（强烈推荐）

1) **新会话开始**：AI 先调用 `get_brain_dump()` 恢复上下文  
2) **准备开始写代码前**：AI 调用 `start_requirement(title, background)`  
3) **每次改完并保存后**：AI 调用 `sync_change_intent(intent, files)` 归档本次意图  
4) **需要找代码定义时**：AI 调用 `query_codebase(query)`（不要靠猜）

> 本 MCP Server 会在初始化时下发 `instructions`，提示 AI 按以上流程调用工具（避免盲猜）。

## MCP Tools

### `start_requirement`
- 入参：`{ title: string, background?: string }`
- 用途：创建并激活一个需求（后续改动意图会自动关联到最新 `active` 需求）

### `sync_change_intent`
- 入参：`{ intent: string, files?: string[], affected_files?: string[] }`
- 用途：把“这次改动的意图摘要”写入 `change_logs`，并与当前激活需求关联  
- 说明：如果没有激活需求，会返回错误并提示先 `start_requirement`

### `get_brain_dump`
- 入参：`{}`
- 用途：返回最近 5 个需求，以及每个需求最近的改动意图（用于会话恢复）

### `query_codebase`
- 入参：`{ query: string }`
- 用途：按名称/签名模糊搜索 `symbols`，返回匹配的 `file_path` 与 `signature`

## 本地数据与监听

- 数据库：在当前项目根目录创建 `.vectormind.db`（默认已在 `.gitignore` 中忽略）
- 监听范围：`process.cwd()` 下文件变动（忽略 `.git/`、`node_modules/`、`dist/`、数据库文件）
- 符号抽取：目前为轻量正则抽取（非 AST 解析），支持常见语言如 TS/JS、Python、Go、Rust、C/C++

## 安装与运行

### 本地开发运行

```bash
npm install
npm run build
node dist/index.js
```

### 以 NPM 包方式运行（发布后）

```bash
npx -y @your-org/vector-mind
```

## 在 MCP Client 中配置（stdio）

不同客户端配置格式略有差异，但核心都是：用 `stdio` 启动一个命令。

- 本地构建版本（示例）：
  - `command`: `node`
  - `args`: `["/absolute/path/to/your/project/dist/index.js"]`

- 发布后（示例）：
  - `command`: `npx`
  - `args`: `["-y", "@your-org/vector-mind"]`

配置完成后，客户端会在初始化阶段拿到该服务器的 tools + instructions；AI 就能“知道它存在”，并在需要时调用，而不是盲猜。

## 典型示例

你：我想加“用户头像上传功能”。  
AI：调用 `start_requirement("用户头像上传功能", "支持 PNG/JPG")`。  
你/AI：改完 `upload.ts` 和 `user.model.ts` 并保存。  
AI：调用 `sync_change_intent("增加 Multer 配置，并在 user model 增加 avatar 字段", ["upload.ts","user.model.ts"])`。  
下次新会话：AI 先 `get_brain_dump()`，直接告诉你当前进度与下一步。

## 注意事项

- `sync_change_intent` 只会关联到“最近的 active 需求”；如需并行多需求，建议先把一个需求标记完成（当前版本未提供 completion tool）。
- 符号索引是启发式的，复杂语法/宏/生成代码可能不完整；如需更高精度，可扩展为 AST/语言服务器方案。

