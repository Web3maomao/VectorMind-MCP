#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "node:url";

import chokidar, { type FSWatcher } from "chokidar";
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

type MemoryItemRow = {
  id: number;
  kind: string;
  title: string | null;
  content: string;
  file_path: string | null;
  start_line: number | null;
  end_line: number | null;
  req_id: number | null;
  metadata_json: string | null;
  content_hash: string | null;
  created_at: string;
  updated_at: string;
};

type ExtractedSymbol = {
  name: string;
  type: string;
  signature: string;
};

const SERVER_NAME = "vector-mind";
const SERVER_VERSION = "1.0.8";

type RootSource = "tool_arg" | "env" | "mcp_roots" | "cwd" | "fallback";

const rootFromEnv = process.env.VECTORMIND_ROOT?.trim() ?? "";

const ROOTS_LIST_TIMEOUT_MS = (() => {
  const raw = process.env.VECTORMIND_ROOTS_TIMEOUT_MS?.trim();
  if (!raw) return 750;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 750;
  return n;
})();

const BOOTSTRAP_SEMANTIC_TIMEOUT_MS = (() => {
  const raw = process.env.VECTORMIND_SEMANTIC_TIMEOUT_MS?.trim();
  if (!raw) return 2500;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 2500;
  return n;
})();

let initialized = false;
let rootSource: RootSource = "cwd";
let projectRoot = "";
let dbPath = "";

let db: Database.Database;
let watcher: FSWatcher | null = null;
let watcherReady = false;
let initializationPromise: Promise<void> | null = null;

let insertRequirementStmt: Database.Statement;
let getActiveRequirementStmt: Database.Statement;
let listRecentRequirementsStmt: Database.Statement;
let listChangeLogsForRequirementStmt: Database.Statement;
let insertChangeLogStmt: Database.Statement;
let insertMemoryItemStmt: Database.Statement;
let getMemoryItemByIdStmt: Database.Statement;
let upsertProjectSummaryStmt: Database.Statement;
let getProjectSummaryStmt: Database.Statement;
let listRecentNotesStmt: Database.Statement;
let deleteFileChunkItemsStmt: Database.Statement;
let getEmbeddingMetaStmt: Database.Statement;
let upsertEmbeddingStmt: Database.Statement;
let upsertPendingChangeStmt: Database.Statement;
let listPendingChangesStmt: Database.Statement;
let deletePendingChangeStmt: Database.Statement;
let deleteAllPendingChangesStmt: Database.Statement;
let deleteSymbolsForFileStmt: Database.Statement;
let upsertSymbolStmt: Database.Statement;
let searchSymbolsStmt: Database.Statement;

let indexFileSymbolsTx:
  | ((filePath: string, symbols: ExtractedSymbol[]) => void)
  | null = null;

const FTS_TABLE_NAME = "memory_items_fts";
let ftsAvailable = false;

function isProbablyVscodeInstallDir(dir: string): boolean {
  const lower = dir.replace(/\\/g, "/").toLowerCase();
  return lower.includes("/microsoft vs code");
}

function isProbablySystemDir(dir: string): boolean {
  if (process.platform !== "win32") return false;
  const candidate = path.resolve(dir);
  const sysRootRaw = process.env.SystemRoot?.trim();
  const sysRoot = sysRootRaw ? path.resolve(sysRootRaw) : null;
  if (sysRoot) {
    const rel = path.relative(sysRoot, candidate);
    if (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return true;
  }
  const windowsFallback = path.resolve("C:\\Windows");
  {
    const rel = path.relative(windowsFallback, candidate);
    if (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return true;
  }
  const programFiles = [
    process.env["ProgramFiles"],
    process.env["ProgramFiles(x86)"],
    process.env["ProgramW6432"],
  ].filter(Boolean) as string[];
  for (const pf of programFiles) {
    const rel = path.relative(path.resolve(pf), candidate);
    if (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return true;
  }
  return false;
}

function getVsCodeUserDirCandidate(): string | null {
  const platform = process.platform;
  if (platform === "win32") {
    const appData = process.env.APPDATA?.trim();
    const roaming = appData || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(roaming, "Code", "User");
  }
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Code", "User");
  }
  return path.join(os.homedir(), ".config", "Code", "User");
}

function resolveSafeFallbackRootDir(): string {
  const candidate = getVsCodeUserDirCandidate();
  if (candidate) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      const st = fs.statSync(candidate);
      if (st.isDirectory()) return candidate;
    } catch {
      // ignore
    }
  }
  return os.homedir();
}

function parseFileUriToPath(uri: string): string | null {
  try {
    return fileURLToPath(new URL(uri));
  } catch {
    return null;
  }
}

function isProjectRootMarkerPresent(dir: string): boolean {
  const markers = [
    ".git",
    ".hg",
    ".svn",
    "package.json",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    "yarn.lock",
    "package-lock.json",
    "tsconfig.json",
    "pyproject.toml",
    "requirements.txt",
    "Pipfile",
    "poetry.lock",
    "go.mod",
    "Cargo.toml",
    "Cargo.lock",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
  ];

  for (const m of markers) {
    try {
      if (fs.existsSync(path.join(dir, m))) return true;
    } catch {
      // ignore
    }
  }

  // Visual Studio solutions: check for any *.sln at this level.
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isFile() && ent.name.toLowerCase().endsWith(".sln")) return true;
    }
  } catch {
    // ignore
  }

  return false;
}

function findNearestProjectRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 50; i++) {
    if (isProjectRootMarkerPresent(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(startDir);
}

function resolveRootFromToolArgOrThrow(raw: unknown): { root: string; source: RootSource } | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const uriPath = trimmed.startsWith("file:") ? parseFileUriToPath(trimmed) : null;
  const abs = path.resolve(uriPath ?? trimmed);
  const parent = path.dirname(abs);
  let startDir: string;
  try {
    const st = fs.statSync(abs);
    startDir = st.isDirectory() ? abs : parent;
  } catch {
    // If the user provided a file path that doesn't exist yet, accept its parent directory.
    try {
      const st2 = fs.statSync(parent);
      if (!st2.isDirectory()) throw new Error("parent is not a directory");
      startDir = parent;
    } catch (err) {
      throw new Error(`[VectorMind] Invalid project_root: ${abs}. (${String(err)})`);
    }
  }

  const root = findNearestProjectRoot(startDir);
  try {
    const st = fs.statSync(root);
    if (!st.isDirectory()) throw new Error("not a directory");
  } catch (err) {
    throw new Error(`[VectorMind] Invalid project_root: ${root}. (${String(err)})`);
  }

  return { root, source: "tool_arg" };
}

function resolveRootFromEnvOrThrow(): { root: string; source: RootSource } | null {
  if (!rootFromEnv) return null;
  const abs = path.resolve(rootFromEnv);
  try {
    const st = fs.statSync(abs);
    if (!st.isDirectory()) throw new Error("not a directory");
  } catch (err) {
    throw new Error(
      `[VectorMind] Invalid VECTORMIND_ROOT: ${abs}. Set it to an existing project directory. (${String(err)})`,
    );
  }
  return { root: abs, source: "env" };
}

function normalizeToDbPath(inputPath: string): string {
  const abs = path.isAbsolute(inputPath) ? inputPath : path.join(projectRoot, inputPath);
  const rel = path.relative(projectRoot, abs);
  const inCwd = !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  const candidate = inCwd ? rel : abs;
  return candidate.replace(/\\/g, "/");
}

function shouldIgnorePath(inputPath: string): boolean {
  const normalizedAbs = path.resolve(inputPath);
  const rel = path.relative(projectRoot, normalizedAbs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return true;

  const relPosix = rel.replace(/\\/g, "/");
  const top = relPosix.split("/")[0];
  if (top === "node_modules" || top === ".git" || top === "dist" || top === ".vectormind") {
    return true;
  }

  // Backward-compat ignore (pre-1.0.2 stored the DB in repo root)
  if (
    relPosix === ".vectormind.db" ||
    relPosix.startsWith(".vectormind.db-") ||
    relPosix === ".vectormind.db-journal"
  ) {
    return true;
  }

  return false;
}

function isSymbolIndexableFile(filePath: string): boolean {
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

function shouldIgnoreContentFile(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  const ignoreNames = new Set([
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
    "cargo.lock",
    "composer.lock",
  ]);
  if (ignoreNames.has(base)) return true;
  if (base.endsWith(".min.js") || base.endsWith(".min.css")) return true;
  return false;
}

function getContentChunkKind(filePath: string): "code_chunk" | "doc_chunk" | null {
  const ext = path.extname(filePath).toLowerCase();
  const docExt = new Set([
    ".md",
    ".mdx",
    ".txt",
    ".rst",
    ".adoc",
    ".org",
    ".json",
    ".yml",
    ".yaml",
    ".toml",
    ".ini",
    ".env",
    ".sql",
  ]);
  if (docExt.has(ext)) return "doc_chunk";
  if (isSymbolIndexableFile(filePath)) return "code_chunk";
  return null;
}

function isContentIndexableFile(filePath: string): boolean {
  if (shouldIgnoreContentFile(filePath)) return false;
  return getContentChunkKind(filePath) !== null;
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

type TextChunk = { startLine: number; endLine: number; content: string };

function chunkTextByLines(
  content: string,
  opts: { maxChars: number; maxLines: number },
): TextChunk[] {
  const lines = content.split(/\r?\n/);
  if (lines.length === 0) return [];

  const chunks: TextChunk[] = [];
  let startLine = 1;
  let currentLines: string[] = [];
  let currentChars = 0;

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const nextChars = currentChars + line.length + 1;
    const nextLines = currentLines.length + 1;

    if (currentLines.length > 0 && (nextChars > opts.maxChars || nextLines > opts.maxLines)) {
      const endLine = startLine + currentLines.length - 1;
      chunks.push({ startLine, endLine, content: currentLines.join("\n") });
      startLine = idx + 1;
      currentLines = [];
      currentChars = 0;
    }

    currentLines.push(line);
    currentChars += line.length + 1;
  }

  if (currentLines.length > 0) {
    const endLine = startLine + currentLines.length - 1;
    chunks.push({ startLine, endLine, content: currentLines.join("\n") });
  }

  return chunks;
}

function indexFileContentChunks(
  dbFilePath: string,
  absPath: string,
  content: string,
  reason: IndexReason,
): void {
  const kind = getContentChunkKind(absPath);
  if (!kind) return;

  const opts =
    kind === "code_chunk"
      ? { maxChars: 10_000, maxLines: 200 }
      : { maxChars: 14_000, maxLines: 260 };
  const chunks = chunkTextByLines(content, opts);
  const ext = path.extname(absPath).toLowerCase();
  const metadata = safeJson({ ext });

  const tx = db.transaction(() => {
    deleteFileChunkItemsStmt.run(dbFilePath);
    for (const chunk of chunks) {
      const title = `${dbFilePath}#L${chunk.startLine}-L${chunk.endLine}`;
      const contentHash = sha256Hex(chunk.content);
      const info = insertMemoryItemStmt.run(
        kind,
        title,
        chunk.content,
        dbFilePath,
        chunk.startLine,
        chunk.endLine,
        null,
        metadata,
        contentHash,
      );
      const memoryId = Number(info.lastInsertRowid);
      if (shouldEmbedFileChunks(reason)) {
        enqueueEmbedding(memoryId);
      }
    }
  });

  try {
    tx();
  } catch (err) {
    console.error("[vectormind] failed to index file chunks:", dbFilePath, err);
  }
}

type PendingChangeEvent = "add" | "change" | "unlink";

function recordPendingChange(absPath: string, event: PendingChangeEvent): void {
  if (shouldIgnorePath(absPath)) return;
  const track = isSymbolIndexableFile(absPath) || isContentIndexableFile(absPath);
  if (!track) return;
  const filePath = normalizeToDbPath(absPath);
  try {
    upsertPendingChangeStmt.run(filePath, event);
  } catch (err) {
    console.error("[vectormind] failed to record pending change:", filePath, err);
  }
}

function indexFile(absPath: string, reason: IndexReason): void {
  if (shouldIgnorePath(absPath)) return;
  const indexSymbols = isSymbolIndexableFile(absPath);
  const indexContent = isContentIndexableFile(absPath);
  if (!indexSymbols && !indexContent) return;

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
  if (indexSymbols) {
    const symbols = extractSymbols(absPath, content);
    try {
      indexFileSymbolsTx?.(filePath, symbols);
    } catch (err) {
      console.error("[vectormind] failed to index symbols:", filePath, err);
    }
  }
  if (indexContent) {
    indexFileContentChunks(filePath, absPath, content, reason);
  }
}

function removeFileIndexes(absPath: string): void {
  if (shouldIgnorePath(absPath)) return;
  const filePath = normalizeToDbPath(absPath);
  try {
    deleteSymbolsForFileStmt.run(filePath);
  } catch (err) {
    console.error("[vectormind] failed to remove symbols:", filePath, err);
  }
  try {
    deleteFileChunkItemsStmt.run(filePath);
  } catch (err) {
    console.error("[vectormind] failed to remove file chunks:", filePath, err);
  }
}

const ProjectRootArgSchema = z.object({
  project_root: z.string().optional(),
});

const StartRequirementArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    title: z.string().min(1),
    background: z.string().optional().default(""),
  }),
);

const SyncChangeIntentArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    intent: z.string().min(1),
    files: z.array(z.string().min(1)).optional(),
    affected_files: z.array(z.string().min(1)).optional(),
  }),
);

const QueryCodebaseArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    query: z.string().min(1),
  }),
);

const UpsertProjectSummaryArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    summary: z.string().min(1),
  }),
);

const AddNoteArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    title: z.string().optional().default(""),
    content: z.string().min(1),
    tags: z.array(z.string().min(1)).optional(),
  }),
);

const BootstrapContextArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    query: z.string().optional(),
    top_k: z.number().int().min(1).max(50).optional().default(10),
    kinds: z.array(z.string().min(1)).optional(),
    include_content: z.boolean().optional().default(false),
  }),
);

const SemanticSearchArgsSchema = ProjectRootArgSchema.merge(
  z.object({
    query: z.string().min(1),
    top_k: z.number().int().min(1).max(50).optional().default(10),
    kinds: z.array(z.string().min(1)).optional(),
    include_content: z.boolean().optional().default(false),
  }),
);

const ProjectRootOnlyArgsSchema = ProjectRootArgSchema;

function escapeLike(pattern: string): string {
  return pattern.replace(/[\\\\%_]/g, (m) => `\\${m}`);
}

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function safeJson(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

const embeddingsEnabled = !["0", "false", "off", "disabled"].includes(
  (process.env.VECTORMIND_EMBEDDINGS ?? "off").toLowerCase(),
);
const embedFilesMode = (process.env.VECTORMIND_EMBED_FILES ?? "all").toLowerCase();
const embedModelName = process.env.VECTORMIND_EMBED_MODEL ?? "Xenova/all-MiniLM-L6-v2";
const embedCacheDir =
  process.env.VECTORMIND_EMBED_CACHE_DIR ??
  path.join(os.homedir(), ".cache", "vectormind");
const allowRemoteModels = !["0", "false", "off"].includes(
  (process.env.VECTORMIND_ALLOW_REMOTE_MODELS ?? "true").toLowerCase(),
);

type IndexReason = "add" | "change" | "manual";

function shouldEmbedFileChunks(reason: IndexReason): boolean {
  if (!embeddingsEnabled) return false;
  if (embedFilesMode === "none" || embedFilesMode === "off" || embedFilesMode === "disabled")
    return false;
  if (embedFilesMode === "all") return true;
  return reason !== "add";
}

let embedderPromise:
  | Promise<(text: string) => Promise<Float32Array>>
  | null = null;

async function getEmbedder(): Promise<(text: string) => Promise<Float32Array>> {
  if (embedderPromise) return embedderPromise;

  embedderPromise = (async () => {
    fs.mkdirSync(embedCacheDir, { recursive: true });
    const mod: any = await import("@xenova/transformers");
    const env: any = mod.env;
    if (env) {
      if (typeof env.cacheDir === "string" || env.cacheDir === undefined) {
        env.cacheDir = embedCacheDir;
      }
      if (typeof env.allowRemoteModels === "boolean" || env.allowRemoteModels === undefined) {
        env.allowRemoteModels = allowRemoteModels;
      }
      if (typeof env.allowLocalModels === "boolean" || env.allowLocalModels === undefined) {
        env.allowLocalModels = true;
      }
    }

    const pipeline: any = mod.pipeline;
    const extractor: any = await pipeline("feature-extraction", embedModelName);

    return async (text: string): Promise<Float32Array> => {
      const input = text.trim() || " ";
      const out: any = await extractor(input, { pooling: "mean", normalize: true });

      const data = out?.data ?? out;
      if (data instanceof Float32Array) return data;
      if (ArrayBuffer.isView(data)) {
        return new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
      }
      if (Array.isArray(data)) {
        return Float32Array.from(data.flat(Infinity) as number[]);
      }
      if (typeof out?.tolist === "function") {
        return Float32Array.from((out.tolist() as number[]).flat(Infinity) as number[]);
      }
      throw new Error("Unexpected embedding output from embedder");
    };
  })();

  return embedderPromise;
}

function buildEmbeddingInput(item: MemoryItemRow): string {
  const headerParts: string[] = [];
  headerParts.push(`kind: ${item.kind}`);
  if (item.req_id != null) headerParts.push(`req_id: ${item.req_id}`);
  if (item.file_path) headerParts.push(`file: ${item.file_path}`);
  if (item.start_line != null && item.end_line != null) {
    headerParts.push(`lines: ${item.start_line}-${item.end_line}`);
  }
  if (item.title) headerParts.push(`title: ${item.title}`);

  const body = item.content ?? "";
  return `${headerParts.join(" | ")}\n\n${body}`.trim();
}

async function embedMemoryItemById(memoryId: number): Promise<void> {
  if (!embeddingsEnabled) return;

  const item = getMemoryItemByIdStmt.get(memoryId) as MemoryItemRow | undefined;
  if (!item) return;

  const input = buildEmbeddingInput(item);
  const inputHash = sha256Hex(input);

  const existing = getEmbeddingMetaStmt.get(memoryId) as
    | { memory_id: number; dim: number; content_hash: string | null }
    | undefined;
  if (existing?.content_hash === inputHash) return;

  const embedder = await getEmbedder();
  const vector = await embedder(input);

  const dim = vector.length;
  const bytes = Buffer.from(
    vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength),
  );
  upsertEmbeddingStmt.run(memoryId, dim, bytes, inputHash);
}

const embeddingQueue: number[] = [];
const embeddingQueued = new Set<number>();
let embeddingWorkerRunning = false;

function enqueueEmbedding(memoryId: number): void {
  if (!embeddingsEnabled) return;
  if (embeddingQueued.has(memoryId)) return;
  embeddingQueued.add(memoryId);
  embeddingQueue.push(memoryId);
  void runEmbeddingWorker();
}

async function runEmbeddingWorker(): Promise<void> {
  if (embeddingWorkerRunning) return;
  embeddingWorkerRunning = true;
  try {
    while (embeddingQueue.length) {
      const id = embeddingQueue.shift();
      if (id == null) break;
      embeddingQueued.delete(id);
      try {
        await embedMemoryItemById(id);
      } catch (err) {
        console.error("[vectormind] embedding failed:", { id, err });
      }
    }
  } finally {
    embeddingWorkerRunning = false;
  }
}

function dotProduct(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

type SemanticSearchMode = "embeddings" | "fts" | "like";

type MemoryItemSearchRow = Pick<
  MemoryItemRow,
  | "id"
  | "kind"
  | "title"
  | "content"
  | "file_path"
  | "start_line"
  | "end_line"
  | "req_id"
  | "metadata_json"
  | "updated_at"
>;

type SemanticSearchMatch = {
  score: number;
  item: {
    id: number;
    kind: string;
    title: string | null;
    file_path: string | null;
    start_line: number | null;
    end_line: number | null;
    req_id: number | null;
    preview: string;
    content?: string;
    metadata_json: string | null;
    updated_at: string;
  };
};

type SemanticSearchResult = {
  query: string;
  top_k: number;
  mode: SemanticSearchMode;
  matches: SemanticSearchMatch[];
};

type SemanticSearchOpts = {
  query: string;
  topK: number;
  kinds: string[] | null;
  includeContent: boolean;
};

function makePreviewText(content: string): string {
  const max = 400;
  if (content.length <= max) return content;
  return `${content.slice(0, max)}...`;
}

function toSemanticMatch(
  row: MemoryItemSearchRow,
  score: number,
  includeContent: boolean,
): SemanticSearchMatch {
  const preview = makePreviewText(row.content);
  return {
    score,
    item: {
      id: row.id,
      kind: row.kind,
      title: row.title,
      file_path: row.file_path,
      start_line: row.start_line,
      end_line: row.end_line,
      req_id: row.req_id,
      preview,
      content: includeContent ? row.content : undefined,
      metadata_json: row.metadata_json,
      updated_at: row.updated_at,
    },
  };
}

async function semanticSearchInternal(opts: SemanticSearchOpts): Promise<SemanticSearchResult> {
  if (!embeddingsEnabled) {
    throw new Error("Embeddings are disabled");
  }

  const q = opts.query.trim();
  if (!q) return { query: "", top_k: opts.topK, mode: "embeddings", matches: [] };
  const embedder = await getEmbedder();
  const qVec = await embedder(q);

  let candidateRows: Array<{ memory_id: number; dim: number; vector: Buffer }> = [];
  if (opts.kinds?.length) {
    const placeholders = opts.kinds.map(() => "?").join(", ");
    const stmt = db.prepare(
      `SELECT e.memory_id as memory_id, e.dim as dim, e.vector as vector
       FROM embeddings e
       JOIN memory_items m ON m.id = e.memory_id
       WHERE m.kind IN (${placeholders})`,
    );
    candidateRows = stmt.all(...opts.kinds) as Array<{
      memory_id: number;
      dim: number;
      vector: Buffer;
    }>;
  } else {
    candidateRows = db
      .prepare(`SELECT memory_id, dim, vector FROM embeddings`)
      .all() as Array<{ memory_id: number; dim: number; vector: Buffer }>;
  }

  const top: Array<{ memory_id: number; score: number }> = [];
  for (const row of candidateRows) {
    const buf = row.vector;
    if (!buf || buf.byteLength % 4 !== 0) continue;
    const v = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    if (row.dim !== v.length || v.length !== qVec.length) continue;
    const score = dotProduct(qVec, v);

    if (top.length < opts.topK) {
      top.push({ memory_id: row.memory_id, score });
      top.sort((a, b) => b.score - a.score);
      continue;
    }
    if (score <= top[top.length - 1].score) continue;
    top[top.length - 1] = { memory_id: row.memory_id, score };
    top.sort((a, b) => b.score - a.score);
  }

  const matches = top
    .map((t) => {
      const item = getMemoryItemByIdStmt.get(t.memory_id) as MemoryItemRow | undefined;
      if (!item) return null;
      return toSemanticMatch(item, t.score, opts.includeContent);
    })
    .filter(Boolean) as Array<{
    score: number;
    item: {
      id: number;
      kind: string;
      title: string | null;
      file_path: string | null;
      start_line: number | null;
      end_line: number | null;
      req_id: number | null;
      preview: string;
      content?: string;
      metadata_json: string | null;
      updated_at: string;
    };
  }>;

  return { query: q, top_k: opts.topK, mode: "embeddings", matches };
}

function buildFtsMatchQuery(raw: string): string {
  const terms = raw
    .trim()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 20);
  if (!terms.length) return '""';
  return terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(" AND ");
}

function ftsSearchInternal(opts: SemanticSearchOpts): SemanticSearchResult {
  if (!ftsAvailable) {
    throw new Error("FTS is unavailable");
  }

  const q = opts.query.trim();
  if (!q) return { query: "", top_k: opts.topK, mode: "fts", matches: [] };
  const matchQuery = buildFtsMatchQuery(q);

  const rows: Array<FtsSearchRow> = (() => {
    if (opts.kinds?.length) {
      const placeholders = opts.kinds.map(() => "?").join(", ");
      const stmt = db.prepare(`
        SELECT
          m.id as id,
          m.kind as kind,
          m.title as title,
          m.content as content,
          m.file_path as file_path,
          m.start_line as start_line,
          m.end_line as end_line,
          m.req_id as req_id,
          m.metadata_json as metadata_json,
          m.updated_at as updated_at,
          bm25(${FTS_TABLE_NAME}) as rank
        FROM ${FTS_TABLE_NAME}
        JOIN memory_items m ON m.id = ${FTS_TABLE_NAME}.rowid
        WHERE ${FTS_TABLE_NAME} MATCH ?
          AND m.kind IN (${placeholders})
        ORDER BY rank ASC
        LIMIT ?
      `);
      return stmt.all(matchQuery, ...opts.kinds, opts.topK) as Array<FtsSearchRow>;
    }

    const stmt = db.prepare(`
      SELECT
        m.id as id,
        m.kind as kind,
        m.title as title,
        m.content as content,
        m.file_path as file_path,
        m.start_line as start_line,
        m.end_line as end_line,
        m.req_id as req_id,
        m.metadata_json as metadata_json,
        m.updated_at as updated_at,
        bm25(${FTS_TABLE_NAME}) as rank
      FROM ${FTS_TABLE_NAME}
      JOIN memory_items m ON m.id = ${FTS_TABLE_NAME}.rowid
      WHERE ${FTS_TABLE_NAME} MATCH ?
      ORDER BY rank ASC
      LIMIT ?
    `);
    return stmt.all(matchQuery, opts.topK) as Array<FtsSearchRow>;
  })();

  const matches = rows.map((r) => toSemanticMatch(r, -Number(r.rank), opts.includeContent));
  return { query: q, top_k: opts.topK, mode: "fts", matches };
}

type FtsSearchRow = MemoryItemSearchRow & { rank: number };
type LikeSearchRow = MemoryItemSearchRow & { score: number };

function likeSearchInternal(opts: SemanticSearchOpts): SemanticSearchResult {
  const q = opts.query.trim();
  if (!q) return { query: "", top_k: opts.topK, mode: "like", matches: [] };
  const escaped = escapeLike(q);
  const like = `%${escaped}%`;

  const rows: Array<LikeSearchRow> = (() => {
    if (opts.kinds?.length) {
      const placeholders = opts.kinds.map(() => "?").join(", ");
      const stmt = db.prepare(`
        SELECT
          id,
          kind,
          title,
          content,
          file_path,
          start_line,
          end_line,
          req_id,
          metadata_json,
          updated_at,
          CASE
            WHEN title LIKE ? ESCAPE '\\' THEN 3
            WHEN file_path LIKE ? ESCAPE '\\' THEN 2
            ELSE 1
          END AS score
        FROM memory_items
        WHERE (content LIKE ? ESCAPE '\\'
            OR title LIKE ? ESCAPE '\\'
            OR file_path LIKE ? ESCAPE '\\')
          AND kind IN (${placeholders})
        ORDER BY score DESC, updated_at DESC, id DESC
        LIMIT ?
      `);
      return stmt.all(like, like, like, like, like, ...opts.kinds, opts.topK) as Array<LikeSearchRow>;
    }

    const stmt = db.prepare(`
      SELECT
        id,
        kind,
        title,
        content,
        file_path,
        start_line,
        end_line,
        req_id,
        metadata_json,
        updated_at,
        CASE
          WHEN title LIKE ? ESCAPE '\\' THEN 3
          WHEN file_path LIKE ? ESCAPE '\\' THEN 2
          ELSE 1
        END AS score
      FROM memory_items
      WHERE (content LIKE ? ESCAPE '\\'
          OR title LIKE ? ESCAPE '\\'
          OR file_path LIKE ? ESCAPE '\\')
      ORDER BY score DESC, updated_at DESC, id DESC
      LIMIT ?
    `);
    return stmt.all(like, like, like, like, like, opts.topK) as Array<LikeSearchRow>;
  })();

  const matches = rows.map((r) => toSemanticMatch(r, Number(r.score), opts.includeContent));
  return { query: q, top_k: opts.topK, mode: "like", matches };
}

async function semanticSearchHybridInternal(opts: SemanticSearchOpts): Promise<SemanticSearchResult> {
  if (embeddingsEnabled) {
    try {
      return await semanticSearchInternal(opts);
    } catch (err) {
      console.error("[vectormind] embeddings semantic_search failed; falling back:", err);
    }
  }

  if (ftsAvailable) {
    try {
      return ftsSearchInternal(opts);
    } catch (err) {
      console.error("[vectormind] fts semantic_search failed; falling back:", err);
    }
  }

  return likeSearchInternal(opts);
}

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  {
    capabilities: { tools: {} },
    instructions: [
      "VectorMind MCP is available in this session. Use it to avoid guessing project context.",
      "Project root resolution order: tool argument project_root (recommended for clients without roots/list), then VECTORMIND_ROOT (avoid hardcoding in global config), then MCP roots/list (best-effort; falls back quickly if unsupported), then process.cwd() (so start your MCP client in the project directory for per-project isolation).",
      "If root_source is fallback, file watching/indexing is disabled (pass project_root to enable per-project tracking).",
      "",
      "Required workflow:",
      "- On every new conversation/session: call bootstrap_context({ query: <current goal> }) first (or at least get_brain_dump()) to restore context and retrieve relevant matches from the local memory store (vector if enabled; otherwise FTS/LIKE).",
      "- BEFORE editing code: call start_requirement(title, background) to set the active requirement.",
      "- AFTER editing + saving: call get_pending_changes() to see unsynced files, then call sync_change_intent(intent, files). (You can omit files to auto-link all pending changes.)",
      "- After major milestones/decisions: call upsert_project_summary(summary) and/or add_note(...) to persist durable context locally.",
      "- When asked to locate code (class/function/type): call query_codebase(query) instead of guessing.",
      "- When you need to recall relevant context from history/code/docs: call semantic_search(query, ...) instead of guessing.",
      "",
      "If tool output conflicts with assumptions, trust the tool output.",
    ].join("\n"),
  },
);

async function resolveProjectRootFromMcpRoots(): Promise<string | null> {
  const caps = server.getClientCapabilities();
  if (!caps?.roots) return null;

  try {
    const result = await server.listRoots({}, { timeout: ROOTS_LIST_TIMEOUT_MS });
    for (const r of result.roots ?? []) {
      const p = parseFileUriToPath(r.uri);
      if (!p) continue;
      try {
        const st = fs.statSync(p);
        if (st.isDirectory()) return p;
      } catch {
        // ignore invalid roots
      }
    }
  } catch {
    // client may not support roots
  }
  return null;
}

async function resolveProjectRoot(): Promise<{ root: string; source: RootSource }> {
  const envResolved = resolveRootFromEnvOrThrow();
  if (envResolved) return envResolved;

  const rootFromMcp = await resolveProjectRootFromMcpRoots();
  if (rootFromMcp) return { root: rootFromMcp, source: "mcp_roots" };

  const cwd = process.cwd();
  if (isProbablyVscodeInstallDir(cwd) || isProbablySystemDir(cwd)) {
    return { root: resolveSafeFallbackRootDir(), source: "fallback" };
  }
  return { root: cwd, source: "cwd" };
}

function initMemoryItemsFts(): void {
  ftsAvailable = false;

  try {
    const existed = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
      .get(FTS_TABLE_NAME);
    const alreadyExists = !!existed;

    if (!alreadyExists) {
      try {
        db.exec(`
          CREATE VIRTUAL TABLE ${FTS_TABLE_NAME} USING fts5(
            kind,
            title,
            content,
            file_path,
            metadata_json,
            content='memory_items',
            content_rowid='id',
            tokenize='trigram'
          );
        `);
      } catch {
        db.exec(`
          CREATE VIRTUAL TABLE ${FTS_TABLE_NAME} USING fts5(
            kind,
            title,
            content,
            file_path,
            metadata_json,
            content='memory_items',
            content_rowid='id'
          );
        `);
      }

      try {
        db.exec(`INSERT INTO ${FTS_TABLE_NAME}(${FTS_TABLE_NAME}) VALUES('rebuild');`);
      } catch (err) {
        console.error("[vectormind] fts rebuild failed:", err);
      }
    }

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS vectormind_memory_items_fts_ai
      AFTER INSERT ON memory_items BEGIN
        INSERT INTO ${FTS_TABLE_NAME}(rowid, kind, title, content, file_path, metadata_json)
        VALUES (new.id, new.kind, new.title, new.content, new.file_path, new.metadata_json);
      END;

      CREATE TRIGGER IF NOT EXISTS vectormind_memory_items_fts_ad
      AFTER DELETE ON memory_items BEGIN
        INSERT INTO ${FTS_TABLE_NAME}(${FTS_TABLE_NAME}, rowid, kind, title, content, file_path, metadata_json)
        VALUES ('delete', old.id, old.kind, old.title, old.content, old.file_path, old.metadata_json);
      END;

      CREATE TRIGGER IF NOT EXISTS vectormind_memory_items_fts_au
      AFTER UPDATE ON memory_items BEGIN
        INSERT INTO ${FTS_TABLE_NAME}(${FTS_TABLE_NAME}, rowid, kind, title, content, file_path, metadata_json)
        VALUES ('delete', old.id, old.kind, old.title, old.content, old.file_path, old.metadata_json);
        INSERT INTO ${FTS_TABLE_NAME}(rowid, kind, title, content, file_path, metadata_json)
        VALUES (new.id, new.kind, new.title, new.content, new.file_path, new.metadata_json);
      END;
    `);

    db.prepare(`SELECT rowid FROM ${FTS_TABLE_NAME} LIMIT 1`).get();
    ftsAvailable = true;
  } catch (err) {
    ftsAvailable = false;
  }
}

function initDatabase(): void {
  const vmDir = path.join(projectRoot, ".vectormind");
  try {
    fs.mkdirSync(vmDir, { recursive: true });
  } catch {
    // ignore
  }

  const legacyDbPath = path.join(projectRoot, ".vectormind.db");
  const nextDbPath = path.join(vmDir, "vectormind.db");
  dbPath = nextDbPath;

  // One-time migration: move legacy root DB into .vectormind/ if the new DB doesn't exist yet.
  if (!fs.existsSync(nextDbPath) && fs.existsSync(legacyDbPath)) {
    const legacyWal = `${legacyDbPath}-wal`;
    const legacyShm = `${legacyDbPath}-shm`;
    const legacyJournal = `${legacyDbPath}-journal`;
    const nextWal = `${nextDbPath}-wal`;
    const nextShm = `${nextDbPath}-shm`;
    const nextJournal = `${nextDbPath}-journal`;

    try {
      fs.renameSync(legacyDbPath, nextDbPath);
      try {
        if (fs.existsSync(legacyWal) && !fs.existsSync(nextWal)) fs.renameSync(legacyWal, nextWal);
      } catch {}
      try {
        if (fs.existsSync(legacyShm) && !fs.existsSync(nextShm)) fs.renameSync(legacyShm, nextShm);
      } catch {}
      try {
        if (fs.existsSync(legacyJournal) && !fs.existsSync(nextJournal)) {
          fs.renameSync(legacyJournal, nextJournal);
        }
      } catch {}
    } catch {
      // If migration fails, fall back to opening the legacy DB in-place.
      dbPath = legacyDbPath;
    }
  }
  db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
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

    CREATE TABLE IF NOT EXISTS memory_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      title TEXT,
      content TEXT NOT NULL,
      file_path TEXT,
      start_line INTEGER,
      end_line INTEGER,
      req_id INTEGER,
      metadata_json TEXT,
      content_hash TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_items_chunk_locator
      ON memory_items(kind, file_path, start_line, end_line);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_items_project_summary
      ON memory_items(kind) WHERE kind = 'project_summary';

    CREATE INDEX IF NOT EXISTS idx_memory_items_kind_updated_at
      ON memory_items(kind, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_memory_items_file_path
      ON memory_items(file_path);

    CREATE INDEX IF NOT EXISTS idx_memory_items_req_id
      ON memory_items(req_id);

    CREATE TABLE IF NOT EXISTS embeddings (
      memory_id INTEGER PRIMARY KEY,
      dim INTEGER NOT NULL,
      vector BLOB NOT NULL,
      content_hash TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(memory_id) REFERENCES memory_items(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_embeddings_updated_at
      ON embeddings(updated_at DESC);

    CREATE TABLE IF NOT EXISTS pending_changes (
      file_path TEXT PRIMARY KEY,
      last_event TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_pending_changes_updated_at
      ON pending_changes(updated_at DESC);
  `);

  initMemoryItemsFts();

  insertRequirementStmt = db.prepare(
    `INSERT INTO requirements (title, context_data, status) VALUES (?, ?, 'active')`,
  );
  getActiveRequirementStmt = db.prepare(
    `SELECT id, title, status, context_data, created_at
     FROM requirements
     WHERE status = 'active'
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
  );
  listRecentRequirementsStmt = db.prepare(
    `SELECT id, title, status, context_data, created_at
     FROM requirements
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
  );
  listChangeLogsForRequirementStmt = db.prepare(
    `SELECT id, req_id, file_path, intent_summary, timestamp
     FROM change_logs
     WHERE req_id = ?
     ORDER BY timestamp DESC, id DESC
     LIMIT ?`,
  );
  insertChangeLogStmt = db.prepare(
    `INSERT INTO change_logs (req_id, file_path, intent_summary) VALUES (?, ?, ?)`,
  );

  insertMemoryItemStmt = db.prepare(
    `INSERT INTO memory_items
      (kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash)
     VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  getMemoryItemByIdStmt = db.prepare(
    `SELECT id, kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash, created_at, updated_at
     FROM memory_items
     WHERE id = ?`,
  );
  upsertProjectSummaryStmt = db.prepare(
    `INSERT INTO memory_items (kind, title, content, metadata_json, content_hash)
     VALUES ('project_summary', 'Project Summary', ?, ?, ?)
     ON CONFLICT DO UPDATE SET
       title = excluded.title,
       content = excluded.content,
       metadata_json = excluded.metadata_json,
       content_hash = excluded.content_hash,
       updated_at = CURRENT_TIMESTAMP`,
  );
  getProjectSummaryStmt = db.prepare(
    `SELECT id, kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash, created_at, updated_at
     FROM memory_items
     WHERE kind = 'project_summary'
     LIMIT 1`,
  );
  listRecentNotesStmt = db.prepare(
    `SELECT id, kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash, created_at, updated_at
     FROM memory_items
     WHERE kind = 'note'
     ORDER BY updated_at DESC, id DESC
     LIMIT ?`,
  );
  deleteFileChunkItemsStmt = db.prepare(
    `DELETE FROM memory_items
     WHERE file_path = ?
       AND (kind = 'code_chunk' OR kind = 'doc_chunk')`,
  );

  getEmbeddingMetaStmt = db.prepare(
    `SELECT memory_id, dim, content_hash
     FROM embeddings
     WHERE memory_id = ?`,
  );
  upsertEmbeddingStmt = db.prepare(
    `INSERT INTO embeddings (memory_id, dim, vector, content_hash)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(memory_id) DO UPDATE SET
       dim = excluded.dim,
       vector = excluded.vector,
       content_hash = excluded.content_hash,
       updated_at = CURRENT_TIMESTAMP`,
  );

  upsertPendingChangeStmt = db.prepare(
    `INSERT INTO pending_changes (file_path, last_event)
     VALUES (?, ?)
     ON CONFLICT(file_path) DO UPDATE SET
       last_event = excluded.last_event,
       updated_at = CURRENT_TIMESTAMP`,
  );
  listPendingChangesStmt = db.prepare(
    `SELECT file_path, last_event, updated_at
     FROM pending_changes
     ORDER BY updated_at DESC`,
  );
  deletePendingChangeStmt = db.prepare(
    `DELETE FROM pending_changes WHERE file_path = ?`,
  );
  deleteAllPendingChangesStmt = db.prepare(`DELETE FROM pending_changes`);

  deleteSymbolsForFileStmt = db.prepare(
    `DELETE FROM symbols WHERE file_path = ?`,
  );
  upsertSymbolStmt = db.prepare(
    `INSERT OR REPLACE INTO symbols (name, type, file_path, signature) VALUES (?, ?, ?, ?)`,
  );
  searchSymbolsStmt = db.prepare(
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

  indexFileSymbolsTx = db.transaction((filePath: string, symbols: ExtractedSymbol[]) => {
    deleteSymbolsForFileStmt.run(filePath);
    for (const s of symbols) {
      upsertSymbolStmt.run(s.name, s.type, filePath, s.signature);
    }
  });
}

function initWatcher(): void {
  watcherReady = false;
  watcher = chokidar.watch(projectRoot, {
    ignored: (p) => shouldIgnorePath(p),
    // Avoid indexing the entire tree on startup; track changes after the server is running.
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });

  watcher.on("add", (p: string) => {
    recordPendingChange(p, "add");
    indexFile(p, "add");
  });
  watcher.on("change", (p: string) => {
    recordPendingChange(p, "change");
    indexFile(p, "change");
  });
  watcher.on("unlink", (p: string) => {
    recordPendingChange(p, "unlink");
    removeFileIndexes(p);
  });
  watcher.on("ready", () => {
    watcherReady = true;
  });
  watcher.on("error", (err: unknown) => console.error("[vectormind] watcher error:", err));
}

async function initializeIfNeeded(forced?: { root: string; source: RootSource }): Promise<void> {
  if (initialized) return;
  const resolved = forced ?? (await resolveProjectRoot());
  projectRoot = resolved.root;
  rootSource = resolved.source;

  try {
    fs.mkdirSync(projectRoot, { recursive: true });
  } catch {
    // ignore
  }

  try {
    initDatabase();
    if (rootSource === "fallback") {
      // If we can't confidently determine the project root (e.g. Codex VS Code started us in System32),
      // don't watch/index the fallback directory. Callers should pass `project_root`.
      watcher = null;
      watcherReady = false;
    } else {
      initWatcher();
    }
    initialized = true;
    console.error(
      `[vectormind] project_root=${projectRoot} source=${rootSource} db=${dbPath} watcher=${watcher ? "on" : "off"}`,
    );
  } catch (err) {
    try {
      watcher?.close().catch(() => {});
    } catch {}
    watcher = null;
    try {
      db?.close();
    } catch {}
    // reset for retry
    initialized = false;
    throw err;
  }
}

async function ensureInitialized(forced?: { root: string; source: RootSource }): Promise<void> {
  if (initialized) return;
  if (!initializationPromise) {
    initializationPromise = initializeIfNeeded(forced).finally(() => {
      if (initialized) return;
      initializationPromise = null;
    });
  }
  await initializationPromise;
}

async function switchProjectRootIfNeeded(next: { root: string; source: RootSource }): Promise<void> {
  const same = projectRoot && path.resolve(projectRoot) === path.resolve(next.root) && initialized;
  if (same) return;

  try {
    await watcher?.close();
  } catch (err) {
    console.error("[vectormind] watcher close error:", err);
  }
  watcher = null;
  watcherReady = false;
  try {
    db?.close();
  } catch (err) {
    console.error("[vectormind] db close error:", err);
  }

  initialized = false;
  initializationPromise = null;
  await ensureInitialized(next);
}

async function ensureInitializedForArgs(rawArgs: Record<string, unknown>): Promise<void> {
  const fromToolArg = resolveRootFromToolArgOrThrow(rawArgs.project_root);
  if (fromToolArg) {
    await switchProjectRootIfNeeded(fromToolArg);
    return;
  }
  await ensureInitialized();
}

server.oninitialized = () => {
  // Do not eagerly initialize: prefer initializing on first tool call so callers can
  // provide `project_root` when the MCP client doesn't support roots/list.
};

process.on("unhandledRejection", (reason) => {
  console.error("[vectormind] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[vectormind] uncaughtException:", err);
});

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
          "MUST call AFTER you edit code and save files. Archives the intent summary and links affected files to the current active requirement. If you omit files, the server will auto-link all pending changed files since the last sync.",
        inputSchema: toJsonSchemaCompat(SyncChangeIntentArgsSchema),
      },
      {
        name: "get_brain_dump",
        description:
          "Restore recent requirements/changes/notes/summary/pending changes. Prefer bootstrap_context() at session start when you also want recall from the local memory store.",
        inputSchema: toJsonSchemaCompat(ProjectRootOnlyArgsSchema),
      },
      {
        name: "bootstrap_context",
        description:
          "MUST call at the start of every new chat/session. Returns brain dump + pending changes, and (if you pass query) matches from the local memory store to avoid guessing.",
        inputSchema: toJsonSchemaCompat(BootstrapContextArgsSchema),
      },
      {
        name: "get_pending_changes",
        description:
          "List files that changed locally but have not been acknowledged by sync_change_intent yet. Use this to see what needs syncing (or omit files in sync_change_intent to auto-link them).",
        inputSchema: toJsonSchemaCompat(ProjectRootOnlyArgsSchema),
      },
      {
        name: "query_codebase",
        description:
          "Search the symbol index for class/function/type names (or substrings) to locate definitions by file path and signature. Use this when you need to find code—do not guess locations.",
        inputSchema: toJsonSchemaCompat(QueryCodebaseArgsSchema),
      },
      {
        name: "upsert_project_summary",
        description:
          "Save/update the project-level context summary (written by the AI in the conversation). Call this after major milestones/decisions so future sessions can recover context quickly.",
        inputSchema: toJsonSchemaCompat(UpsertProjectSummaryArgsSchema),
      },
      {
        name: "add_note",
        description:
          "Save a durable project note (decision, constraint, TODO, architecture detail). Use this to persist important context locally instead of relying on chat memory.",
        inputSchema: toJsonSchemaCompat(AddNoteArgsSchema),
      },
      {
        name: "semantic_search",
        description:
          "Semantic search across the local memory store (requirements, change intents, notes, project summary, and indexed code/doc chunks). Use this to retrieve relevant context instead of guessing.",
        inputSchema: toJsonSchemaCompat(SemanticSearchArgsSchema),
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const rawArgs = (request.params.arguments ?? {}) as Record<string, unknown>;

  try {
    await ensureInitializedForArgs(rawArgs);

    if (toolName === "start_requirement") {
      const args = StartRequirementArgsSchema.parse(rawArgs);
      const info = insertRequirementStmt.run(args.title, args.background || null);
      const id = Number(info.lastInsertRowid);

      const background = args.background?.trim() ?? "";
      const content = background ? `${args.title}\n\n${background}` : args.title;
      const memoryInfo = insertMemoryItemStmt.run(
        "requirement",
        args.title,
        content,
        null,
        null,
        null,
        id,
        safeJson({ status: "active" }),
        sha256Hex(content),
      );
      const memory_id = Number(memoryInfo.lastInsertRowid);
      enqueueEmbedding(memory_id);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { ok: true, requirement: { id, title: args.title }, memory_item: { id: memory_id } },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (toolName === "sync_change_intent") {
      const args = SyncChangeIntentArgsSchema.parse(rawArgs);
      const explicitFiles = (args.files ?? args.affected_files ?? []).filter(
        (f): f is string => typeof f === "string" && f.length > 0,
      );
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

      const created: Array<{
        file_path: string;
        event: string;
        source: "args" | "pending" | "unspecified";
        change_log_id: number;
        memory_item_id: number;
      }> = [];
      const synced_files: Array<{
        file_path: string;
        event: string;
        source: "args" | "pending" | "unspecified";
      }> = [];
      const insertTx = db.transaction(() => {
        const targets: Array<{
          rawFile: string;
          dbFilePath: string;
          event: string;
          source: "args" | "pending" | "unspecified";
        }> = [];

        if (explicitFiles.length) {
          for (const rawFile of explicitFiles) {
            const dbFilePath = normalizeToDbPath(rawFile);
            targets.push({ rawFile, dbFilePath, event: "manual", source: "args" });
          }
          for (const t of targets) {
            deletePendingChangeStmt.run(t.dbFilePath);
          }
        } else {
          const pending = listPendingChangesStmt.all() as Array<{
            file_path: string;
            last_event: string;
            updated_at: string;
          }>;
          if (pending.length) {
            for (const p of pending) {
              targets.push({
                rawFile: p.file_path,
                dbFilePath: p.file_path,
                event: p.last_event,
                source: "pending",
              });
            }
            deleteAllPendingChangesStmt.run();
          } else {
            targets.push({
              rawFile: "(unspecified)",
              dbFilePath: "(unspecified)",
              event: "manual",
              source: "unspecified",
            });
          }
        }

        for (const t of targets) {
          const isUnspecified = t.dbFilePath === "(unspecified)";
          const changeInfo = insertChangeLogStmt.run(active.id, t.dbFilePath, args.intent);
          const change_log_id = Number(changeInfo.lastInsertRowid);

          const memoryInfo = insertMemoryItemStmt.run(
            "change_intent",
            active.title,
            args.intent,
            isUnspecified ? null : t.dbFilePath,
            null,
            null,
            active.id,
            safeJson({ change_log_id, event: t.event, source: t.source }),
            sha256Hex(args.intent),
          );
          const memory_item_id = Number(memoryInfo.lastInsertRowid);
          enqueueEmbedding(memory_item_id);

          synced_files.push({ file_path: t.dbFilePath, event: t.event, source: t.source });
          created.push({
            file_path: t.dbFilePath,
            event: t.event,
            source: t.source,
            change_log_id,
            memory_item_id,
          });

          if (!isUnspecified && t.event !== "unlink") {
            const abs = path.isAbsolute(t.rawFile)
              ? t.rawFile
              : path.join(projectRoot, t.rawFile);
            indexFile(abs, "manual");
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
                synced_files,
                created,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (toolName === "bootstrap_context") {
      const args = BootstrapContextArgsSchema.parse(rawArgs);

      const recent = listRecentRequirementsStmt.all(5) as RequirementRow[];
      const items = recent.map((req) => {
        const changes = listChangeLogsForRequirementStmt.all(req.id, 20) as ChangeLogRow[];
        return { requirement: req, recent_changes: changes };
      });
      const project_summary = getProjectSummaryStmt.get() as MemoryItemRow | undefined;
      const recent_notes = listRecentNotesStmt.all(10) as MemoryItemRow[];
      const pending_changes = listPendingChangesStmt.all() as Array<{
        file_path: string;
        last_event: string;
        updated_at: string;
      }>;

      const q = args.query?.trim() ?? "";
      const semantic =
        q
          ? await Promise.race([
              semanticSearchHybridInternal({
                query: q,
                topK: args.top_k,
                kinds: args.kinds?.length ? args.kinds : null,
                includeContent: args.include_content,
              }),
              new Promise<null>((resolve) => setTimeout(resolve, BOOTSTRAP_SEMANTIC_TIMEOUT_MS, null)),
            ]).catch((err) => {
              console.error("[vectormind] bootstrap semantic_search failed:", err);
              return null;
            })
          : null;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                generated_at: new Date().toISOString(),
                 project_root: projectRoot,
                 root_source: rootSource,
                 db_path: dbPath,
                 watcher_enabled: !!watcher,
                 watcher_ready: watcherReady,
                 embeddings: {
                   enabled: embeddingsEnabled,
                   model: embedModelName,
                  embed_files: embedFilesMode,
                },
                project_summary: project_summary ?? null,
                recent_notes,
                pending_changes,
                items,
                semantic,
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
      const project_summary = getProjectSummaryStmt.get() as MemoryItemRow | undefined;
      const recent_notes = listRecentNotesStmt.all(10) as MemoryItemRow[];
      const pending_changes = listPendingChangesStmt.all() as Array<{
        file_path: string;
        last_event: string;
        updated_at: string;
      }>;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                generated_at: new Date().toISOString(),
                 project_root: projectRoot,
                 root_source: rootSource,
                 db_path: dbPath,
                 watcher_enabled: !!watcher,
                 watcher_ready: watcherReady,
                 embeddings: {
                   enabled: embeddingsEnabled,
                   model: embedModelName,
                  embed_files: embedFilesMode,
                },
                project_summary: project_summary ?? null,
                recent_notes,
                pending_changes,
                items,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (toolName === "get_pending_changes") {
      const pending = listPendingChangesStmt.all() as Array<{
        file_path: string;
        last_event: string;
        updated_at: string;
      }>;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, pending }, null, 2),
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

    if (toolName === "upsert_project_summary") {
      const args = UpsertProjectSummaryArgsSchema.parse(rawArgs);
      const summary = args.summary.trim();
      const contentHash = sha256Hex(summary);
      upsertProjectSummaryStmt.run(summary, safeJson({ source: "assistant" }), contentHash);

      const row = getProjectSummaryStmt.get() as MemoryItemRow | undefined;
      if (row) enqueueEmbedding(row.id);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { ok: true, project_summary: row ?? null },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (toolName === "add_note") {
      const args = AddNoteArgsSchema.parse(rawArgs);
      const title = args.title?.trim() ?? "";
      const content = args.content.trim();
      const info = insertMemoryItemStmt.run(
        "note",
        title || null,
        content,
        null,
        null,
        null,
        null,
        safeJson({ tags: args.tags ?? [] }),
        sha256Hex(content),
      );
      const id = Number(info.lastInsertRowid);
      enqueueEmbedding(id);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, note: { id } }, null, 2),
          },
        ],
      };
    }

    if (toolName === "semantic_search") {
      const args = SemanticSearchArgsSchema.parse(rawArgs);
      const result = await semanticSearchHybridInternal({
        query: args.query,
        topK: args.top_k,
        kinds: args.kinds?.length ? args.kinds : null,
        includeContent: args.include_content,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { ok: true, ...result },
              null,
              2,
            ),
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
    await watcher?.close();
  } catch (err) {
    console.error("[vectormind] watcher close error:", err);
  }
  try {
    db?.close();
  } catch (err) {
    console.error("[vectormind] db close error:", err);
  }
  process.exit(signal === "SIGTERM" ? 143 : 130);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
