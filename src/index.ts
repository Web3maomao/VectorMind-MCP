#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";

import chokidar from "chokidar";
import Database from "better-sqlite3";
import { z } from "zod";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

type RequirementRow = {
  id: number;
  title: string;
  status: string;
  context_data: string | null;
  created_at: string;
};

type ChangeLogRow = {
  id: number;
  req_id: number;
  file_path: string;
  intent_summary: string;
  timestamp: string;
};

type SymbolRow = {
  name: string;
  type: string;
  file_path: string;
  signature: string | null;
};

type ExtractedSymbol = {
  name: string;
  type: string;
  signature: string;
};

const SERVER_NAME = "vector-mind";
const SERVER_VERSION = "1.0.0";

const cwd = process.cwd();
const dbPath = path.join(cwd, ".vectormind.db");
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS requirements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    context_data TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS change_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    req_id INTEGER,
    file_path TEXT,
    intent_summary TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(req_id) REFERENCES requirements(id)
  );

  CREATE TABLE IF NOT EXISTS symbols (
    name TEXT,
    type TEXT,
    file_path TEXT,
    signature TEXT,
    PRIMARY KEY(name, file_path)
  );

  CREATE INDEX IF NOT EXISTS idx_change_logs_req_id_timestamp
    ON change_logs(req_id, timestamp DESC);

  CREATE INDEX IF NOT EXISTS idx_symbols_name
    ON symbols(name);
`);

const insertRequirementStmt = db.prepare(
  `INSERT INTO requirements (title, context_data, status) VALUES (?, ?, 'active')`,
);
const getActiveRequirementStmt = db.prepare(
  `SELECT id, title, status, context_data, created_at
   FROM requirements
   WHERE status = 'active'
   ORDER BY created_at DESC, id DESC
   LIMIT 1`,
);
const listRecentRequirementsStmt = db.prepare(
  `SELECT id, title, status, context_data, created_at
   FROM requirements
   ORDER BY created_at DESC, id DESC
   LIMIT ?`,
);
const listChangeLogsForRequirementStmt = db.prepare(
  `SELECT id, req_id, file_path, intent_summary, timestamp
   FROM change_logs
   WHERE req_id = ?
   ORDER BY timestamp DESC, id DESC
   LIMIT ?`,
);
const insertChangeLogStmt = db.prepare(
  `INSERT INTO change_logs (req_id, file_path, intent_summary) VALUES (?, ?, ?)`,
);

const deleteSymbolsForFileStmt = db.prepare(
  `DELETE FROM symbols WHERE file_path = ?`,
);
const upsertSymbolStmt = db.prepare(
  `INSERT OR REPLACE INTO symbols (name, type, file_path, signature) VALUES (?, ?, ?, ?)`,
);
const searchSymbolsStmt = db.prepare(
  `SELECT name, type, file_path, signature
   FROM symbols
   WHERE name LIKE ? ESCAPE '\\'
      OR signature LIKE ? ESCAPE '\\'
   ORDER BY
     CASE
       WHEN name = ? THEN 0
       WHEN name LIKE ? ESCAPE '\\' THEN 1
       ELSE 2
     END,
     name
   LIMIT ?`,
);

function normalizeToDbPath(inputPath: string): string {
  const abs = path.isAbsolute(inputPath) ? inputPath : path.join(cwd, inputPath);
  const rel = path.relative(cwd, abs);
  const inCwd = !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  const candidate = inCwd ? rel : abs;
  return candidate.replace(/\\/g, "/");
}

function shouldIgnorePath(inputPath: string): boolean {
  const normalizedAbs = path.resolve(inputPath);
  const rel = path.relative(cwd, normalizedAbs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return true;

  const relPosix = rel.replace(/\\/g, "/");
  if (relPosix === ".vectormind.db") return true;

  const top = relPosix.split("/")[0];
  if (top === "node_modules" || top === ".git" || top === "dist") return true;

  return false;
}

function isTextLikeFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  const allowed = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".py",
    ".go",
    ".rs",
    ".java",
    ".kt",
    ".cs",
    ".c",
    ".cc",
    ".cpp",
    ".h",
    ".hpp",
  ]);
  return allowed.has(ext);
}

function extractSymbols(filePath: string, content: string): ExtractedSymbol[] {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".py") return extractPythonSymbols(content);
  if (ext === ".rs") return extractRustSymbols(content);
  if (ext === ".go") return extractGoSymbols(content);
  if (
    ext === ".ts" ||
    ext === ".tsx" ||
    ext === ".js" ||
    ext === ".jsx" ||
    ext === ".mjs" ||
    ext === ".cjs"
  ) {
    return extractJsTsSymbols(content);
  }
  return extractCLikeSymbols(content);
}

function extractJsTsSymbols(content: string): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("//")) continue;

    let match: RegExpMatchArray | null;

    match = trimmed.match(/^(export\s+)?(default\s+)?class\s+([A-Za-z_$][\w$]*)/);
    if (match) {
      symbols.push({ name: match[3], type: "class", signature: trimmed });
      continue;
    }

    match = trimmed.match(
      /^(export\s+)?(async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/,
    );
    if (match) {
      symbols.push({ name: match[3], type: "function", signature: trimmed });
      continue;
    }

    match = trimmed.match(/^(export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/);
    if (match) {
      symbols.push({ name: match[2], type: "interface", signature: trimmed });
      continue;
    }

    match = trimmed.match(/^(export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/);
    if (match) {
      symbols.push({ name: match[2], type: "type", signature: trimmed });
      continue;
    }

    match = trimmed.match(/^(export\s+)?enum\s+([A-Za-z_$][\w$]*)\b/);
    if (match) {
      symbols.push({ name: match[2], type: "enum", signature: trimmed });
      continue;
    }

    match = trimmed.match(
      /^(export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(async\s*)?\(.*=>/,
    );
    if (match) {
      symbols.push({ name: match[2], type: "function", signature: trimmed });
      continue;
    }

    match = trimmed.match(
      /^(export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(async\s*)?function\s*\(/,
    );
    if (match) {
      symbols.push({ name: match[2], type: "function", signature: trimmed });
      continue;
    }
  }
  return symbols;
}

function extractPythonSymbols(content: string): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    let match: RegExpMatchArray | null;
    match = trimmed.match(/^class\s+([A-Za-z_][\w]*)\b/);
    if (match) {
      symbols.push({ name: match[1], type: "class", signature: trimmed });
      continue;
    }
    match = trimmed.match(/^(async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/);
    if (match) {
      symbols.push({ name: match[2], type: "function", signature: trimmed });
      continue;
    }
  }
  return symbols;
}

function extractRustSymbols(content: string): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;

    let match: RegExpMatchArray | null;
    match = trimmed.match(/^(pub\s+)?(struct|enum|trait)\s+([A-Za-z_][\w]*)\b/);
    if (match) {
      symbols.push({ name: match[3], type: match[2], signature: trimmed });
      continue;
    }
    match = trimmed.match(/^(pub\s+)?fn\s+([A-Za-z_][\w]*)\s*\(/);
    if (match) {
      symbols.push({ name: match[2], type: "function", signature: trimmed });
      continue;
    }
  }
  return symbols;
}

function extractGoSymbols(content: string): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;

    let match: RegExpMatchArray | null;
    match = trimmed.match(/^type\s+([A-Za-z_][\w]*)\s+(struct|interface)\b/);
    if (match) {
      symbols.push({ name: match[1], type: match[2], signature: trimmed });
      continue;
    }
    match = trimmed.match(/^func\s+([A-Za-z_][\w]*)\s*\(/);
    if (match) {
      symbols.push({ name: match[1], type: "function", signature: trimmed });
      continue;
    }
    match = trimmed.match(/^func\s+\([^)]*\)\s+([A-Za-z_][\w]*)\s*\(/);
    if (match) {
      symbols.push({ name: match[1], type: "method", signature: trimmed });
      continue;
    }
  }
  return symbols;
}

function extractCLikeSymbols(content: string): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*"))
      continue;

    let match: RegExpMatchArray | null;
    match = trimmed.match(
      /^(class|struct|interface|enum)\s+([A-Za-z_][\w]*)\b/,
    );
    if (match) {
      symbols.push({ name: match[2], type: match[1], signature: trimmed });
      continue;
    }

    match = trimmed.match(/^[A-Za-z_][\w:<>,\s\*&]*\s+([A-Za-z_][\w]*)\s*\(/);
    if (match) {
      symbols.push({ name: match[1], type: "function", signature: trimmed });
      continue;
    }
  }
  return symbols;
}

const indexFileSymbolsTx = db.transaction((filePath: string, symbols: ExtractedSymbol[]) => {
  deleteSymbolsForFileStmt.run(filePath);
  for (const s of symbols) {
    upsertSymbolStmt.run(s.name, s.type, filePath, s.signature);
  }
});

function indexFile(absPath: string): void {
  if (shouldIgnorePath(absPath)) return;
  if (!isTextLikeFile(absPath)) return;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return;
  }
  if (!stat.isFile()) return;
  if (stat.size > 1_000_000) return;

  let content: string;
  try {
    content = fs.readFileSync(absPath, "utf8");
  } catch {
    return;
  }
  if (content.includes("\u0000")) return;

  const filePath = normalizeToDbPath(absPath);
  const symbols = extractSymbols(absPath, content);
  try {
    indexFileSymbolsTx(filePath, symbols);
  } catch (err) {
    console.error("[vectormind] failed to index symbols:", filePath, err);
  }
}

function removeFileSymbols(absPath: string): void {
  if (shouldIgnorePath(absPath)) return;
  const filePath = normalizeToDbPath(absPath);
  try {
    deleteSymbolsForFileStmt.run(filePath);
  } catch (err) {
    console.error("[vectormind] failed to remove symbols:", filePath, err);
  }
}

const watcher = chokidar.watch(cwd, {
  ignored: (p) => shouldIgnorePath(p),
  ignoreInitial: false,
  persistent: true,
  awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
});

watcher.on("add", (p) => indexFile(p));
watcher.on("change", (p) => indexFile(p));
watcher.on("unlink", (p) => removeFileSymbols(p));
watcher.on("error", (err) => console.error("[vectormind] watcher error:", err));

const StartRequirementArgsSchema = z.object({
  title: z.string().min(1),
  background: z.string().optional().default(""),
});

const SyncChangeIntentArgsSchema = z
  .object({
    intent: z.string().min(1),
    files: z.array(z.string().min(1)).optional(),
    affected_files: z.array(z.string().min(1)).optional(),
  })
  .transform((v) => ({
    intent: v.intent,
    files: (v.files ?? v.affected_files ?? []).filter(Boolean),
  }));

const QueryCodebaseArgsSchema = z.object({
  query: z.string().min(1),
});

function escapeLike(pattern: string): string {
  return pattern.replace(/[\\\\%_]/g, (m) => `\\${m}`);
}

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  {
    capabilities: { tools: {} },
    instructions: [
      "VectorMind MCP is available in this session. Use it to avoid guessing project context.",
      "",
      "Required workflow:",
      "- On every new conversation/session: call get_brain_dump() first to restore active/recent requirements + recent change intents.",
      "- BEFORE editing code: call start_requirement(title, background) to set the active requirement.",
      "- AFTER editing + saving: call sync_change_intent(intent, files) to archive why the change was made (and which files).",
      "- When asked to locate code (class/function/type): call query_codebase(query) instead of guessing.",
      "",
      "If tool output conflicts with assumptions, trust the tool output.",
    ].join("\n"),
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "start_requirement",
        description:
          "MUST call BEFORE editing code. Starts/activates a requirement so all subsequent code changes can be linked to a concrete intent (do not edit code without an active requirement).",
        inputSchema: toJsonSchemaCompat(StartRequirementArgsSchema),
      },
      {
        name: "sync_change_intent",
        description:
          "MUST call AFTER you edit code and save files. Archives the intent summary and links affected files to the current active requirement (do not guess intent later—write it here now).",
        inputSchema: toJsonSchemaCompat(SyncChangeIntentArgsSchema),
      },
      {
        name: "get_brain_dump",
        description:
          "MUST call at the start of every new chat/session. Restores context (recent requirements + recent linked code-change intents) so you can answer without guessing.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "query_codebase",
        description:
          "Search the symbol index for class/function/type names (or substrings) to locate definitions by file path and signature. Use this when you need to find code—do not guess locations.",
        inputSchema: toJsonSchemaCompat(QueryCodebaseArgsSchema),
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const rawArgs = (request.params.arguments ?? {}) as Record<string, unknown>;

  try {
    if (toolName === "start_requirement") {
      const args = StartRequirementArgsSchema.parse(rawArgs);
      const info = insertRequirementStmt.run(args.title, args.background || null);
      const id = Number(info.lastInsertRowid);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { ok: true, requirement: { id, title: args.title } },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (toolName === "sync_change_intent") {
      const args = SyncChangeIntentArgsSchema.parse(rawArgs);
      const active = getActiveRequirementStmt.get() as RequirementRow | undefined;
      if (!active) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: false,
                  error:
                    "No active requirement. Call start_requirement(title, background) before syncing change intent.",
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      const files = args.files.length ? args.files : ["(unspecified)"];
      const insertTx = db.transaction(() => {
        for (const f of files) {
          const dbFilePath =
            f === "(unspecified)" ? f : normalizeToDbPath(String(f));
          insertChangeLogStmt.run(active.id, dbFilePath, args.intent);

          if (f !== "(unspecified)") {
            const abs = path.isAbsolute(String(f)) ? String(f) : path.join(cwd, String(f));
            indexFile(abs);
          }
        }
      });
      insertTx();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                linked_to_requirement: { id: active.id, title: active.title },
                files: files,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (toolName === "get_brain_dump") {
      const recent = listRecentRequirementsStmt.all(5) as RequirementRow[];
      const items = recent.map((req) => {
        const changes = listChangeLogsForRequirementStmt.all(req.id, 20) as ChangeLogRow[];
        return { requirement: req, recent_changes: changes };
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { ok: true, generated_at: new Date().toISOString(), items },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (toolName === "query_codebase") {
      const args = QueryCodebaseArgsSchema.parse(rawArgs);
      const q = args.query.trim();
      const escaped = escapeLike(q);
      const like = `%${escaped}%`;
      const rows = searchSymbolsStmt.all(like, like, q, like, 50) as SymbolRow[];

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, query: q, matches: rows }, null, 2),
          },
        ],
      };
    }

    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: String(err) }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

async function shutdown(signal: string): Promise<void> {
  try {
    await watcher.close();
  } catch (err) {
    console.error("[vectormind] watcher close error:", err);
  }
  try {
    db.close();
  } catch (err) {
    console.error("[vectormind] db close error:", err);
  }
  process.exit(signal === "SIGTERM" ? 143 : 130);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
