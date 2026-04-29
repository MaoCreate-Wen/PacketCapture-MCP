export function renderGuiHtml(options: { apiToken: string }): string {
  const token = escapeHtml(options.apiToken);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="packetcapture-api-token" content="${token}">
  <title>PacketCapture-MCP Console</title>
  <style>
    :root {
      --bg: #f5f7fb;
      --panel: #ffffff;
      --text: #172033;
      --muted: #657089;
      --line: #dbe2ef;
      --accent: #0f766e;
      --accent-dark: #0b5f59;
      --danger: #b42318;
      --warn: #a15c07;
      --code: #0b1220;
      --code-text: #d8e7ff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 14px 18px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
      position: sticky;
      top: 0;
      z-index: 2;
    }
    h1 { font-size: 18px; margin: 0; }
    h2 { font-size: 15px; margin: 0 0 10px; }
    button, input, select {
      font: inherit;
      border: 1px solid var(--line);
      border-radius: 6px;
    }
    button {
      background: var(--accent);
      color: white;
      border-color: var(--accent);
      padding: 7px 10px;
      cursor: pointer;
    }
    button.secondary {
      background: #fff;
      color: var(--text);
      border-color: var(--line);
    }
    button.danger {
      background: var(--danger);
      border-color: var(--danger);
    }
    button:hover { filter: brightness(0.96); }
    input, select {
      padding: 7px 8px;
      background: #fff;
      color: var(--text);
      min-width: 0;
    }
    .layout {
      display: grid;
      grid-template-columns: 280px minmax(360px, 1fr) minmax(420px, 1.35fr);
      gap: 12px;
      padding: 12px;
      min-height: calc(100vh - 58px);
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      min-width: 0;
      overflow: hidden;
    }
    .panel-head {
      padding: 12px;
      border-bottom: 1px solid var(--line);
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
    }
    .panel-body { padding: 12px; }
    .stack { display: flex; flex-direction: column; gap: 10px; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .muted { color: var(--muted); font-size: 12px; }
    .status-ok { color: var(--accent-dark); font-weight: 600; }
    .status-off { color: var(--warn); font-weight: 600; }
    .list {
      display: flex;
      flex-direction: column;
      max-height: 56vh;
      overflow: auto;
    }
    .item {
      text-align: left;
      color: var(--text);
      background: #fff;
      border: 0;
      border-bottom: 1px solid var(--line);
      border-radius: 0;
      padding: 10px 12px;
    }
    .item.active { background: #e9f7f4; border-left: 4px solid var(--accent); }
    .table-wrap { overflow: auto; max-height: 72vh; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
    th { text-align: left; background: #f7f9fc; position: sticky; top: 0; z-index: 1; }
    tr.active { background: #e9f7f4; }
    tr.clickable { cursor: pointer; }
    .method { font-weight: 700; color: var(--accent-dark); }
    .status-bad { color: var(--danger); font-weight: 700; }
    .tabs { display: flex; gap: 6px; margin-bottom: 10px; }
    .tab {
      background: #fff;
      color: var(--text);
      border-color: var(--line);
    }
    .tab.active { background: var(--accent); color: white; border-color: var(--accent); }
    pre {
      margin: 0;
      padding: 12px;
      border-radius: 7px;
      background: var(--code);
      color: var(--code-text);
      overflow: auto;
      max-height: 58vh;
      white-space: pre-wrap;
      word-break: break-word;
      font: 12px/1.5 Consolas, "Cascadia Mono", monospace;
    }
    .pill {
      display: inline-flex;
      padding: 2px 7px;
      border-radius: 999px;
      background: #eef2f7;
      color: var(--muted);
      font-size: 12px;
    }
    .notice {
      padding: 9px 10px;
      border-radius: 7px;
      background: #fff7ed;
      border: 1px solid #fed7aa;
      color: #7c2d12;
      font-size: 13px;
    }
    .error {
      background: #fff1f0;
      border-color: #ffccc7;
      color: var(--danger);
    }
    @media (max-width: 1100px) {
      .layout { grid-template-columns: 1fr; }
      .list, .table-wrap, pre { max-height: none; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>PacketCapture-MCP Console</h1>
      <div class="muted" id="serverInfo">Loading server info...</div>
    </div>
    <div class="row">
      <button id="refreshBtn" class="secondary">Refresh</button>
      <span class="pill" id="captureCount">0 captures</span>
    </div>
  </header>
  <main class="layout">
    <section class="panel">
      <div class="panel-head">
        <h2>Captures</h2>
        <button id="reloadCapturesBtn" class="secondary">Reload</button>
      </div>
      <div class="panel-body stack">
        <div class="stack">
          <strong>Import file</strong>
          <input id="importPath" placeholder="examples/sample.har">
          <div class="row">
            <select id="importFormat">
              <option value="auto">auto</option>
              <option value="har">har</option>
              <option value="json">json</option>
              <option value="curl">curl</option>
            </select>
            <input id="importCaptureId" placeholder="captureId">
            <button id="importBtn">Import</button>
          </div>
        </div>
        <div class="notice" id="message" hidden></div>
        <div class="list" id="captureList"></div>
      </div>
      <div class="panel-head">
        <h2>Reqable Report Server</h2>
      </div>
      <div class="panel-body stack">
        <div id="reportStatus" class="muted">Loading...</div>
        <div class="grid2">
          <input id="reportHost" value="127.0.0.1" placeholder="host">
          <input id="reportPort" type="number" value="9419" placeholder="port">
          <input id="reportCaptureId" value="reqable-report-live" placeholder="captureId">
          <input id="reportRecentLimit" type="number" value="200" placeholder="recentLimit">
        </div>
        <div class="row">
          <button id="startReportBtn">Start</button>
          <button id="stopReportBtn" class="danger">Stop</button>
        </div>
      </div>
    </section>
    <section class="panel">
      <div class="panel-head">
        <h2>Sessions</h2>
        <span class="pill" id="sessionCount">0 sessions</span>
      </div>
      <div class="panel-body stack">
        <div class="row">
          <input id="sessionKeyword" placeholder="keyword">
          <input id="sessionHost" placeholder="host">
          <select id="sessionStatus">
            <option value="">status</option>
            <option value="2xx">2xx</option>
            <option value="3xx">3xx</option>
            <option value="4xx">4xx</option>
            <option value="5xx">5xx</option>
            <option value="unknown">unknown</option>
          </select>
          <button id="filterBtn" class="secondary">Filter</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>#</th><th>Method</th><th>Status</th><th>URL</th><th>Time</th></tr></thead>
            <tbody id="sessionRows"></tbody>
          </table>
        </div>
      </div>
    </section>
    <section class="panel">
      <div class="panel-head">
        <h2>HTTP Exchange</h2>
        <div class="row">
          <label class="muted"><input id="includeBodies" type="checkbox" checked> body</label>
          <label class="muted"><input id="includeRaw" type="checkbox" checked> raw</label>
          <label class="muted"><input id="redact" type="checkbox" checked> redact</label>
        </div>
      </div>
      <div class="panel-body">
        <div class="tabs">
          <button class="tab active" data-tab="request">Request</button>
          <button class="tab" data-tab="response">Response</button>
          <button class="tab" data-tab="analysis">Analysis</button>
        </div>
        <pre id="detail">Select a session to inspect the captured request and response.</pre>
      </div>
    </section>
  </main>
  <script>
    const apiToken = document.querySelector('meta[name="packetcapture-api-token"]').content;
    const state = { captures: [], captureId: "", sessionId: "", sessions: [], exchange: null, analysis: null, tab: "request" };

    const $ = (id) => document.getElementById(id);
    const esc = (value) => String(value ?? "");

    async function api(path, options = {}) {
      const headers = { ...(options.headers || {}) };
      if (options.body && !headers["content-type"]) headers["content-type"] = "application/json";
      if (options.method && options.method !== "GET") headers["x-packetcapture-gui-token"] = apiToken;
      const response = await fetch(path, { ...options, headers });
      const type = response.headers.get("content-type") || "";
      const body = type.includes("application/json") ? await response.json() : await response.text();
      if (!response.ok) throw new Error(typeof body === "string" ? body : body.error || response.statusText);
      return body;
    }

    function showMessage(text, isError = false) {
      const node = $("message");
      node.hidden = false;
      node.textContent = text;
      node.classList.toggle("error", isError);
      window.clearTimeout(showMessage.timer);
      showMessage.timer = window.setTimeout(() => { node.hidden = true; }, 5000);
    }

    async function refreshAll() {
      await Promise.all([loadServerInfo(), loadReportStatus(), loadCaptures()]);
    }

    async function loadServerInfo() {
      const info = await api("/api/server/info");
      $("serverInfo").textContent = "Node " + info.nodeVersion + " · uptime " + Math.round(info.uptimeSeconds) + "s · GUI " + info.gui.host + ":" + info.gui.port;
      $("captureCount").textContent = info.captureCount + " captures";
    }

    async function loadReportStatus() {
      const status = await api("/api/reqable/report-server/status");
      const running = status.running ? '<span class="status-ok">running</span>' : '<span class="status-off">stopped</span>';
      const url = status.ingestUrls?.har || status.receiverUrl || "";
      $("reportStatus").innerHTML = running + (url ? "<br><span class='muted'>" + url + "</span>" : "");
    }

    async function loadCaptures() {
      const result = await api("/api/captures");
      state.captures = result.captures;
      $("captureCount").textContent = result.captures.length + " captures";
      $("captureList").innerHTML = result.captures.map((capture) => {
        const active = capture.id === state.captureId ? " active" : "";
        return '<button class="item' + active + '" data-capture="' + capture.id + '"><strong>' + capture.id + '</strong><br><span class="muted">' + capture.format + " · " + capture.sessionCount + " sessions</span></button>";
      }).join("") || '<div class="muted">No captures yet. Import a file or start Reqable Report Server.</div>';
      document.querySelectorAll("[data-capture]").forEach((button) => {
        button.onclick = () => selectCapture(button.dataset.capture);
      });
    }

    async function selectCapture(captureId) {
      state.captureId = captureId;
      state.sessionId = "";
      state.exchange = null;
      state.analysis = null;
      renderDetail();
      await loadCaptures();
      await Promise.all([loadSessions(), loadAnalysis()]);
    }

    async function loadSessions() {
      if (!state.captureId) return;
      const params = new URLSearchParams({ limit: "100" });
      if ($("sessionKeyword").value) params.set("keyword", $("sessionKeyword").value);
      if ($("sessionHost").value) params.set("host", $("sessionHost").value);
      if ($("sessionStatus").value) params.set("statusClass", $("sessionStatus").value);
      const result = await api("/api/captures/" + encodeURIComponent(state.captureId) + "/sessions?" + params);
      state.sessions = result.sessions;
      $("sessionCount").textContent = result.total + " sessions";
      $("sessionRows").innerHTML = result.sessions.map((session) => {
        const active = session.id === state.sessionId ? " active" : "";
        const statusClass = session.status >= 400 ? "status-bad" : "";
        return '<tr class="clickable' + active + '" data-session="' + session.id + '"><td>' + session.index + '</td><td class="method">' + session.method + '</td><td class="' + statusClass + '">' + esc(session.status ?? "") + '</td><td>' + esc(session.url) + '</td><td>' + esc(session.durationMs ?? "") + '</td></tr>';
      }).join("");
      document.querySelectorAll("[data-session]").forEach((row) => {
        row.onclick = () => selectSession(row.dataset.session);
      });
    }

    async function selectSession(sessionId) {
      state.sessionId = sessionId;
      await loadExchange();
      await loadSessions();
    }

    async function loadExchange() {
      const params = new URLSearchParams({
        includeBodies: $("includeBodies").checked ? "true" : "false",
        includeRawText: $("includeRaw").checked ? "true" : "false",
        redactSensitive: $("redact").checked ? "true" : "false",
        bodyLimit: "24000",
      });
      const result = await api("/api/captures/" + encodeURIComponent(state.captureId) + "/sessions/" + encodeURIComponent(state.sessionId) + "/exchange?" + params);
      state.exchange = result.exchange;
      renderDetail();
    }

    async function loadAnalysis() {
      if (!state.captureId) return;
      state.analysis = await api("/api/captures/" + encodeURIComponent(state.captureId) + "/analysis?maxFindings=20");
      renderDetail();
    }

    function renderDetail() {
      const detail = $("detail");
      document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === state.tab));
      if (state.tab === "analysis") {
        detail.textContent = state.analysis ? JSON.stringify(state.analysis.analysis, null, 2) : "No analysis loaded.";
        return;
      }
      if (!state.exchange) {
        detail.textContent = "Select a session to inspect the captured request and response.";
        return;
      }
      const message = state.exchange[state.tab];
      detail.textContent = message.rawText || (message.startLine + "\\n" + JSON.stringify(message.headers, null, 2) + (message.body ? "\\n\\n" + message.body : ""));
    }

    async function importFile() {
      await api("/api/import/file", {
        method: "POST",
        body: JSON.stringify({
          path: $("importPath").value || "examples/sample.har",
          format: $("importFormat").value,
          captureId: $("importCaptureId").value || undefined,
        }),
      });
      showMessage("Capture imported.");
      await refreshAll();
    }

    async function startReport() {
      const status = await api("/api/reqable/report-server/start", {
        method: "POST",
        body: JSON.stringify({
          host: $("reportHost").value || "127.0.0.1",
          port: Number($("reportPort").value || 9419),
          captureId: $("reportCaptureId").value || "reqable-report-live",
          recentLimit: Number($("reportRecentLimit").value || 200),
        }),
      });
      showMessage("Report Server started: " + (status.ingestUrls?.har || status.receiverUrl));
      await refreshAll();
    }

    async function stopReport() {
      await api("/api/reqable/report-server/stop", { method: "POST" });
      showMessage("Report Server stopped.");
      await refreshAll();
    }

    $("refreshBtn").onclick = () => refreshAll().catch((error) => showMessage(error.message, true));
    $("reloadCapturesBtn").onclick = () => loadCaptures().catch((error) => showMessage(error.message, true));
    $("importBtn").onclick = () => importFile().catch((error) => showMessage(error.message, true));
    $("filterBtn").onclick = () => loadSessions().catch((error) => showMessage(error.message, true));
    $("startReportBtn").onclick = () => startReport().catch((error) => showMessage(error.message, true));
    $("stopReportBtn").onclick = () => stopReport().catch((error) => showMessage(error.message, true));
    $("includeBodies").onchange = () => state.sessionId && loadExchange();
    $("includeRaw").onchange = () => state.sessionId && loadExchange();
    $("redact").onchange = () => state.sessionId && loadExchange();
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.onclick = () => {
        state.tab = tab.dataset.tab;
        renderDetail();
      };
    });

    refreshAll().catch((error) => showMessage(error.message, true));
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
