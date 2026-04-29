import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const captureId = "gui-mcp-shared-state";
let stderrText = "";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  cwd: process.cwd(),
  stderr: "pipe",
  env: {
    ...process.env,
    PACKETCAPTURE_GUI: "1",
    PACKETCAPTURE_GUI_PORT: "0",
  },
});

transport.stderr?.on("data", (chunk) => {
  stderrText += chunk.toString();
});

const client = new Client({ name: "packetcapture-gui-shared-state-smoke", version: "0.1.0" });

try {
  await client.connect(transport);
  const guiUrl = await waitForGuiUrl();

  await callJson("import_capture_file", {
    path: "examples/sample.har",
    format: "har",
    captureId,
  });

  const captures = await fetchJson(`${guiUrl}api/captures`);
  assert(captures.captures.some((capture) => capture.id === captureId), "GUI did not see capture imported through MCP");

  const sessions = await fetchJson(`${guiUrl}api/captures/${captureId}/sessions?limit=1`);
  assertEqual(sessions.sessions.length, 1, "GUI shared session count");

  console.log("gui mcp shared-state smoke ok: MCP import is visible through GUI API");
} finally {
  await client.close();
}

async function waitForGuiUrl() {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    const match = stderrText.match(/PacketCapture-MCP GUI listening at (http:\/\/[^\s]+)/);
    if (match) return match[1];
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for GUI URL in stderr: ${stderrText}`);
}

async function callJson(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const item = result.content[0];
  assert(item?.type === "text", `tool ${name} did not return text content`);
  return JSON.parse(item.text);
}

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}: ${text}`);
  return JSON.parse(text);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
