import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

function getFlag(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const rootsMode = (getFlag("roots") ?? "on").toLowerCase();
const enableRoots = rootsMode !== "off";

const embeddings = (getFlag("embeddings") ?? "off").toLowerCase();
const enableEmbeddings = embeddings === "on" || embeddings === "true" || embeddings === "1";

const allowRemoteModels = (getFlag("allow-remote-models") ?? "true").toLowerCase();
const keepFiles = hasFlag("keep-files");
const inPlace = hasFlag("in-place");

const env = {
  ...process.env,
  VECTORMIND_EMBEDDINGS: enableEmbeddings ? "on" : "off",
  VECTORMIND_ALLOW_REMOTE_MODELS: allowRemoteModels,
};

const runDir = inPlace
  ? process.cwd()
  : fs.mkdtempSync(path.join(os.tmpdir(), "vectormind-smoke-"));
const serverEntry = path.resolve(process.cwd(), "dist/index.js");

const transport = new StdioClientTransport({
  command: "node",
  args: [serverEntry],
  cwd: runDir,
  env,
  stderr: "inherit",
});

const client = new Client(
  { name: "vectormind-smoke", version: "0.0.0" },
  { capabilities: enableRoots ? { roots: {} } : {} },
);

function readText(result) {
  const first = result?.content?.find((c) => c.type === "text");
  return first?.text ?? JSON.stringify(result, null, 2);
}

async function main() {
  if (rootsMode === "on") {
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: [{ uri: pathToFileURL(runDir).toString(), name: "vectormind-smoke" }],
    }));
  } else if (rootsMode === "hang") {
    client.setRequestHandler(ListRootsRequestSchema, async () => new Promise(() => {}));
  }

  await client.connect(transport);

  const serverInstructions = client.getInstructions();
  if (serverInstructions) {
    console.log("\n--- server instructions ---\n");
    console.log(serverInstructions);
  }

  const toolList = await client.listTools();
  console.log("\n--- tools ---\n");
  console.log(toolList.tools.map((t) => t.name).sort().join(", "));

  const bootStart = Date.now();
  const boot = await client.callTool(
    {
      name: "bootstrap_context",
      arguments: { query: "smoke test: what is VectorMind?", top_k: 5 },
    },
    undefined,
    { timeout: 10_000 },
  );
  const bootElapsedMs = Date.now() - bootStart;
  console.log("\n--- bootstrap_context ---\n");
  const bootText = readText(boot);
  console.log(bootText);
  try {
    const parsed = JSON.parse(bootText);
    const expectedRootSource = rootsMode === "on" ? "mcp_roots" : "cwd";
    if (parsed?.root_source !== expectedRootSource) {
      throw new Error(`expected root_source=${expectedRootSource}, got ${parsed?.root_source}`);
    }
    if (rootsMode === "hang" && bootElapsedMs > 5_000) {
      throw new Error(`expected bootstrap_context to finish fast when roots hang (got ${bootElapsedMs}ms)`);
    }
    const expectedDbPath = path.join(runDir, ".vectormind", "vectormind.db");
    if (!parsed?.db_path) {
      throw new Error("expected db_path in bootstrap_context output");
    }
    if (path.resolve(parsed.db_path) !== path.resolve(expectedDbPath)) {
      throw new Error(`expected db_path=${expectedDbPath}, got ${parsed.db_path}`);
    }
    if (!fs.existsSync(expectedDbPath)) {
      throw new Error(`expected db file to exist at ${expectedDbPath}`);
    }
  } catch (err) {
    console.error("\n[smoke] root resolution check failed:", err);
    process.exitCode = 1;
    return;
  }

  const req = await client.callTool({
    name: "start_requirement",
    arguments: { title: "VectorMind smoke test", background: "basic end-to-end flow" },
  });
  console.log("\n--- start_requirement ---\n");
  console.log(readText(req));

  await new Promise((r) => setTimeout(r, 1000));

  const token = `VM_SMOKE_${Date.now()}`;
  const testPath = path.join(runDir, "vm_smoke_test.md");
  fs.writeFileSync(testPath, `# Smoke\n\n${token}\n\nThis file should be indexed.\n`);

  await new Promise((r) => setTimeout(r, 1000));

  const pending1 = await client.callTool({ name: "get_pending_changes", arguments: {} });
  console.log("\n--- get_pending_changes (before) ---\n");
  console.log(readText(pending1));

  const sync = await client.callTool({
    name: "sync_change_intent",
    arguments: {
      intent: `smoke: created/changed vm_smoke_test.md (${token})`,
    },
  });
  console.log("\n--- sync_change_intent (auto-link pending) ---\n");
  console.log(readText(sync));

  const pending2 = await client.callTool({ name: "get_pending_changes", arguments: {} });
  console.log("\n--- get_pending_changes (after) ---\n");
  console.log(readText(pending2));

  const summary = await client.callTool({
    name: "upsert_project_summary",
    arguments: { summary: `Smoke summary: created ${path.basename(testPath)} token=${token}` },
  });
  console.log("\n--- upsert_project_summary ---\n");
  console.log(readText(summary));

  const note = await client.callTool({
    name: "add_note",
    arguments: { title: "smoke-note", content: `Remember token: ${token}`, tags: ["smoke"] },
  });
  console.log("\n--- add_note ---\n");
  console.log(readText(note));

  if (enableEmbeddings) {
    console.log("\n(waiting a bit for background embedding...)\n");
    await new Promise((r) => setTimeout(r, 8000));

    const search = await client.callTool({
      name: "semantic_search",
      arguments: { query: token, top_k: 5, include_content: false },
    });
    console.log("\n--- semantic_search ---\n");
    console.log(readText(search));
  } else {
    console.log("\n(embeddings disabled; skip semantic_search)\n");
  }

  if (!keepFiles && inPlace) {
    try {
      fs.unlinkSync(testPath);
      await new Promise((r) => setTimeout(r, 800));
      const cleanup = await client.callTool({
        name: "sync_change_intent",
        arguments: {
          intent: `smoke cleanup: removed ${path.basename(testPath)}`,
          files: [testPath],
        },
      });
      console.log("\n--- sync_change_intent (cleanup) ---\n");
      console.log(readText(cleanup));
    } catch {}
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await transport.close();
    } catch {}
    if (!keepFiles && !inPlace) {
      try {
        fs.rmSync(runDir, { recursive: true, force: true });
      } catch {}
    }
  });
