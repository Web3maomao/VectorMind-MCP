---
name: vector-mind
description: Use VectorMind MCP to keep per-project local context (requirements, change intents, notes, project summary, code/doc chunks) and avoid guessing. Use at session start to bootstrap_context, before edits to start_requirement, after saves to sync_change_intent, and use semantic_search/query_codebase for recall/navigation.
---

# VectorMind MCP Autopilot

## Overview

VectorMind is an MCP server that maintains a **local, per-project** context store (SQLite + optional embeddings) so the assistant can restore “what we’re doing / why we changed this” across sessions.

VectorMind data lives under the project root: `.vectormind/` (for example: `.vectormind/vectormind.db`).

## When to Use

Use this skill for any coding session where:
- You want the assistant to resume work accurately across chats/days
- You care about recording “intent/why” for code changes (not just git diffs)
- You want semantic recall over requirements/notes/summaries/code/docs

## Required Workflow (do this by default)

### 1) At the start of every new session (or resume)

- Call `bootstrap_context({ query: "<current goal>", top_k: 5 })` first.
- Use the returned summary/notes/pending changes/semantic matches to ground your plan.

### 2) Before editing code/files for a new task

- Call `start_requirement({ title: "<short title>", background: "<constraints/acceptance criteria>" })`.

### 3) After editing + saving files

- Call `get_pending_changes()`
- Then call `sync_change_intent({ intent: "<what changed + why + next steps>", files?: <omit to auto-link pending> })`.

### 4) Don’t guess paths or history

- Need a symbol location? Call `query_codebase({ query: "<name>" })`.
- Need to recall context/notes/code/docs? Call `semantic_search({ query: "<question>", top_k: 8 })`.

### 5) Persist durable state before ending

- Call `upsert_project_summary({ summary: "<current state + next steps>" })`.
- Call `add_note({ title?, content, tags? })` for decisions/constraints/TODOs.

## Output Policy

- Don’t paste raw JSON tool output unless the user asks for verification/debugging.
- If tool output conflicts with assumptions, trust the tool output.

## Setup Notes

This skill requires the VectorMind MCP server to be enabled in your client.

### Claude Desktop (example)

Add this under `mcpServers` in your Claude config, then restart Claude:

```json
{
  "mcpServers": {
    "vector-mind": {
      "command": "npx",
      "args": ["-y", "@coreyuan/vector-mind"]
    }
  }
}
```

### myclaude / Claude Code (optional: auto-suggest trigger)

If you use a rules file like `.claude/skills/skill-rules.json`, add a `vector-mind` entry with keywords like:
- “我现在要做什么”
- “继续/恢复/接着做”
- “总结项目/写总结/记录意图”
- “别猜/用工具/查符号/语义检索”

---

Remember: think in English, respond to user in Chinese.
