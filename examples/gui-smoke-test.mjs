import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["dist/gui.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PACKETCAPTURE_GUI_PORT: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let stdout = "";
let stderr = "";

child.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

try {
  const baseUrl = await waitForGuiUrl();
  const html = await fetchText(baseUrl);
  assert(html.includes("PacketCapture-MCP Console"), "GUI HTML title missing");
  const apiToken = extractApiToken(html);

  const info = await fetchJson(`${baseUrl}api/server/info`);
  assertEqual(info.name, "packetcapture-mcp", "server info name");

  const imported = await postJson(`${baseUrl}api/import/file`, apiToken, {
    path: "examples/sample.har",
    format: "har",
    captureId: "gui-smoke-har",
  });
  assertEqual(imported.capture.id, "gui-smoke-har", "imported capture id");

  const captures = await fetchJson(`${baseUrl}api/captures`);
  assert(captures.captures.some((capture) => capture.id === "gui-smoke-har"), "capture list missing imported capture");

  const sessions = await fetchJson(`${baseUrl}api/captures/gui-smoke-har/sessions?limit=1`);
  assertEqual(sessions.sessions.length, 1, "session list count");
  const sessionId = sessions.sessions[0].id;

  const exchange = await fetchJson(`${baseUrl}api/captures/gui-smoke-har/sessions/${sessionId}/exchange?includeBodies=true&includeRawText=true&bodyLimit=64`);
  assert(exchange.exchange.request.rawText.includes("POST"), "request raw text missing method");
  assert(exchange.exchange.response.rawText.includes("200"), "response raw text missing status");

  const analysis = await fetchJson(`${baseUrl}api/captures/gui-smoke-har/analysis?maxFindings=20`);
  assertEqual(analysis.analysis.summary.totalSessions, 1, "analysis session count");

  const reportStatus = await postJson(`${baseUrl}api/reqable/report-server/start`, apiToken, {
    port: 0,
    captureId: "gui-smoke-live",
  });
  assert(reportStatus.running, "report server did not start");
  assert(reportStatus.ingestUrls?.har, "report server missing HAR URL");

  const stopped = await postJson(`${baseUrl}api/reqable/report-server/stop`, apiToken, {});
  assertEqual(stopped.running, false, "report server did not stop");

  console.log("gui smoke ok: HTML, import, sessions, exchange, analysis, and report server controls passed");
} finally {
  child.kill();
}

function waitForGuiUrl() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const match = stderr.match(/PacketCapture-MCP GUI listening at (http:\/\/[^\s]+)/);
      if (match) {
        clearInterval(timer);
        resolve(match[1]);
        return;
      }
      if (Date.now() - started > 10000) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for GUI URL. stdout=${stdout} stderr=${stderr}`));
      }
    }, 50);
    child.once("exit", (code) => {
      clearInterval(timer);
      reject(new Error(`GUI process exited early with code ${code}. stdout=${stdout} stderr=${stderr}`));
    });
  });
}

async function fetchText(url) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}: ${text}`);
  return text;
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

async function postJson(url, apiToken, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-packetcapture-gui-token": apiToken,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`POST ${url} failed with ${response.status}: ${text}`);
  return JSON.parse(text);
}

function extractApiToken(html) {
  const match = html.match(/name="packetcapture-api-token" content="([^"]+)"/);
  assert(match, "API token meta tag missing");
  return match[1];
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
