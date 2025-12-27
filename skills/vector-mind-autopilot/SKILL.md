---
name: vector-mind-autopilot
description: "Automatically apply the VectorMind MCP workflow (local requirement-driven memory): bootstrap_context on session start, start_requirement before edits, sync_change_intent after saves, and semantic_search/query_codebase instead of guessing. Use for coding work when VectorMind MCP is configured."
---

# VectorMind Autopilot (MCP)

## Goal

Make the assistant use VectorMind MCP by default so project context, intent, and progress are restored and persisted locally without the user manually asking for MCP calls.

## Default Workflow (do this unless explicitly unnecessary)

### 1) Detect VectorMind MCP availability

- If the tools `bootstrap_context`, `start_requirement`, and `sync_change_intent` exist, treat VectorMind as available and use it.
- If VectorMind tools are missing or tool calls fail repeatedly, follow **Setup / Troubleshooting** and continue with best-effort reasoning (do not guess silently; tell the user what’s missing).

### 2) On every new session (or when the user says “继续/恢复/接着做”)

- Call `bootstrap_context({ query: <the user's current goal>, top_k: 5 })` first.
- Use the returned `project_summary`, `recent_notes`, `pending_changes`, and semantic `items` to ground your plan and avoid “blind guessing”.
- Do **not** paste raw JSON unless the user asks for it (summarize key facts instead).

### 3) Before editing code or files

- If this is a new task/feature, call `start_requirement({ title, background })` before changing anything.
- Prefer short, specific titles (e.g., “Add avatar upload”) and put constraints in `background` (formats, edge cases, acceptance criteria).

### 4) After editing + saving files

- Call `get_pending_changes()` to see what changed but isn’t yet linked to an intent.
- Call `sync_change_intent({ intent, files? })` to archive the “what/why” and associate the changes to the active requirement.
  - Prefer omitting `files` to let the server auto-link all pending changes, unless you intentionally want a subset.
  - Write `intent` as a concise, user-facing summary: what changed + why + any follow-ups.

### 5) When you need to find code or recall context

- If the user asks “X 在哪里定义的/哪个文件负责 Y”: call `query_codebase({ query: "X" })` instead of guessing paths.
- If you need to recall prior context/notes/decisions/code/docs: call `semantic_search({ query, top_k, kinds? })` instead of guessing.

### 6) After major milestones (or before ending the session)

- Call `upsert_project_summary({ summary })` to keep a single, up-to-date project summary.
- Call `add_note({ title?, content, tags? })` for durable decisions/constraints/TODOs that should survive across sessions.

## Output Policy (user-visible)

- Don’t spam tool outputs. Summarize what matters (active requirement, pending changes, next steps).
- Show raw JSON only when the user requests debugging/verification.

## Setup / Troubleshooting

### VectorMind tools are missing

- Configure your MCP client to run VectorMind via stdio (published package example): `npx -y @coreyuan/vector-mind`.
- Codex CLI config location: `~/.codex/config.toml` (Windows: `C:\\Users\\<you>\\.codex\\config.toml`).
  - Example:
    - `[mcp_servers.vector-mind]`
    - `type = "stdio"`
    - `command = "npx"`
    - `args = ["-y", "@coreyuan/vector-mind"]`

### Tool calls fail with “Transport closed”

- Restart the MCP client (or the editor) so the MCP server reconnects.
- Re-check the MCP server config and that `npx -y @coreyuan/vector-mind` runs successfully in the same environment.

## Universal (non-Codex) usage

If your AI client does not support Codex skills, copy/paste `references/universal-system-prompt.md` into that client’s system prompt/custom instructions.
