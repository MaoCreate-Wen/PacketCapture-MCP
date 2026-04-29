import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { access } from "node:fs/promises";

const REQUIRED_TOOLS = [
  "import_capture_file",
  "list_captures",
  "list_sessions",
  "analyze_capture",
  "generate_report",
  "get_http_exchange",
];

const captureId = "mcp-stdio-acceptance-sample";

await assertDistEntryExists();

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  cwd: process.cwd(),
  stderr: "pipe",
});

const client = new Client({
  name: "packetcapture-mcp-stdio-acceptance",
  version: "0.1.0",
});

try {
  await client.connect(transport);

  const toolsResult = await client.listTools();
  const toolNames = new Set(toolsResult.tools.map((tool) => tool.name));
  for (const toolName of REQUIRED_TOOLS) {
    assert(toolNames.has(toolName), `missing required MCP tool: ${toolName}`);
  }

  const imported = await callJson("import_capture_file", {
    path: "examples/sample.har",
    format: "har",
    captureId,
  });
  assertEqual(imported.id, captureId, "imported capture id");
  assertEqual(imported.sessionCount, 1, "imported session count");

  const captures = await callJson("list_captures", {});
  assert(
    captures.captures.some((capture) => capture.id === captureId),
    `list_captures did not include ${captureId}`,
  );

  const sessions = await callJson("list_sessions", { captureId, limit: 1 });
  assertEqual(sessions.sessions.length, 1, "listed session count");
  assertEqual(sessions.sessions[0].method, "POST", "sample session method");

  const analysis = await callJson("analyze_capture", { captureId, maxFindings: 10 });
  assertEqual(analysis.summary.totalSessions, 1, "analysis total sessions");
  assert(
    analysis.findings.some((finding) => finding.category === "secret"),
    "analysis did not report the expected sample secret finding",
  );

  const report = await callText("generate_report", { captureId, format: "markdown" });
  assert(report.includes("# Packet Capture Analysis Report"), "markdown report heading missing");

  console.log(
    `mcp stdio acceptance ok: ${toolsResult.tools.length} tools listed, sample HAR imported and analyzed`,
  );
} finally {
  await client.close();
}

async function assertDistEntryExists() {
  try {
    await access("dist/index.js");
  } catch (error) {
    throw new Error("dist/index.js is missing. Run `npm run build` before this acceptance script.", {
      cause: error,
    });
  }
}

async function callJson(name, args) {
  const text = await callText(name, args);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`tool ${name} returned non-JSON text: ${text}`, { cause: error });
  }
}

async function callText(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const item = result.content[0];
  assert(item?.type === "text", `tool ${name} did not return text content`);
  return item.text;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
