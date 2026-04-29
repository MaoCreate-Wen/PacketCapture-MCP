import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { CaptureDataset, HeaderMap, HttpSession } from "./types.js";

const DEFAULT_INBOX_DIR = resolve(process.cwd(), "reqable-inbox");
const DEFAULT_EVENTS_FILE = "events.ndjson";
const TEXT_LIMIT = 256_000;
const BRIDGE_NOTES = [
  "Reqable script writes one completed HTTP session per JSON line.",
  "MCP reads only the configured local inbox; it does not control Reqable or capture traffic itself.",
  "The generated script uses official onRequest/onResponse callbacks and context.shared to pair requests with responses.",
  "Reqable Report Server HAR push payloads can be appended as JSON lines for local ingest.",
];

type UnknownRecord = Record<string, unknown>;

interface BodyMetadata {
  sizeBytes?: number;
  encoding?: string;
  isBinary?: boolean;
  isTruncated?: boolean;
  sha256?: string;
  base64Sample?: string;
  contentType?: string;
}

export interface ReqableBridgeConfig {
  inboxDir: string;
  eventsFile: string;
  absoluteEventsPath: string;
  scriptPath: string;
  receiverUrl?: string;
  schema: string;
  notes: string[];
}

export interface ReqableInboxStatus {
  inboxDir: string;
  exists: boolean;
  files: Array<{ name: string; path: string; sizeBytes: number; modifiedAt: string }>;
  activeFile?: { path: string; sizeBytes: number; modifiedAt: string };
}

export async function getBridgeConfig(options: { inboxDir?: string; eventsFile?: string; receiverUrl?: string } = {}): Promise<ReqableBridgeConfig> {
  const inboxDir = resolve(options.inboxDir ?? process.env.REQABLE_MCP_INBOX ?? DEFAULT_INBOX_DIR);
  const eventsFile = options.eventsFile ?? process.env.REQABLE_MCP_EVENTS_FILE ?? DEFAULT_EVENTS_FILE;
  const absoluteEventsPath = join(inboxDir, eventsFile);
  const receiverUrl = options.receiverUrl ?? process.env.REQABLE_MCP_RECEIVER_URL;
  return {
    inboxDir,
    eventsFile,
    absoluteEventsPath,
    scriptPath: resolve(process.cwd(), "scripts", "reqable-mcp-bridge.py"),
    receiverUrl,
    schema: "reqable-mcp-bridge.v2.ndjson",
    notes: BRIDGE_NOTES,
  };
}

export async function ensureBridgeInbox(options: { inboxDir?: string; eventsFile?: string; receiverUrl?: string } = {}): Promise<ReqableBridgeConfig> {
  const config = await getBridgeConfig(options);
  await mkdir(config.inboxDir, { recursive: true });
  try {
    await stat(config.absoluteEventsPath);
  } catch {
    await writeFile(config.absoluteEventsPath, "", { flag: "wx" });
  }
  return config;
}

export async function getInboxStatus(options: { inboxDir?: string; eventsFile?: string } = {}): Promise<ReqableInboxStatus> {
  const config = await getBridgeConfig(options);
  try {
    const entries = await readdir(config.inboxDir, { withFileTypes: true });
    const files = await Promise.all(entries
      .filter((entry) => entry.isFile() && /\.ndjson$/i.test(entry.name))
      .map(async (entry) => {
        const path = join(config.inboxDir, entry.name);
        const fileStat = await stat(path);
        return { name: entry.name, path, sizeBytes: fileStat.size, modifiedAt: fileStat.mtime.toISOString() };
      }));
    const active = files.find((file) => file.name === config.eventsFile);
    return { inboxDir: config.inboxDir, exists: true, files: files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)), activeFile: active ? { path: active.path, sizeBytes: active.sizeBytes, modifiedAt: active.modifiedAt } : undefined };
  } catch {
    return { inboxDir: config.inboxDir, exists: false, files: [] };
  }
}

export async function writeReqableBridgeScript(options: { inboxDir?: string; eventsFile?: string; scriptPath?: string; overwrite?: boolean; receiverUrl?: string } = {}): Promise<Record<string, unknown>> {
  const config = await ensureBridgeInbox(options);
  const scriptPath = resolve(options.scriptPath ?? config.scriptPath);
  let exists = false;
  try {
    await stat(scriptPath);
    exists = true;
  } catch {
    exists = false;
  }

  const resultConfig = { ...config, scriptPath };
  if (exists && !options.overwrite) {
    return {
      config: resultConfig,
      written: false,
      overwritten: false,
      notes: ["Script already exists. Pass overwrite=true to replace it.", ...config.notes],
      nextSteps: reqableBridgeNextSteps(scriptPath, config.absoluteEventsPath),
    };
  }

  await mkdir(dirname(scriptPath), { recursive: true });
  await writeFile(scriptPath, renderReqableBridgeScript(config.absoluteEventsPath, config.receiverUrl), "utf8");
  return {
    config: resultConfig,
    written: true,
    overwritten: exists,
    notes: config.notes,
    nextSteps: reqableBridgeNextSteps(scriptPath, config.absoluteEventsPath),
  };
}

export function renderReqableBridgeScript(eventsPath: string, receiverUrl?: string): string {
  return renderReqableBridgeScriptV2(eventsPath, receiverUrl);
}

function renderReqableBridgeScriptV1(eventsPath: string): string {
  return `# Reqable MCP Bridge
#
# Purpose: write captured HTTP transactions from Reqable scripting into NDJSON
# so PacketCapture-MCP can import and analyze them with import_reqable_inbox or
# analyze_reqable_inbox.
#
# Local evidence from Reqable assets confirms Python scripting support, but
# Reqable callback names may vary by version. Keep emit_transaction(...) and
# adapt the small callback functions at the bottom if your Reqable version uses
# different hook names. This script is passive: it does not modify requests or
# responses.

import datetime
import json
import os
import time
import traceback

EVENTS_PATH = ${JSON.stringify(eventsPath)}
SCHEMA = "reqable-mcp-bridge.v1.ndjson"
TEXT_LIMIT = 256 * 1024


def _now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _get(obj, *names, default=None):
    if obj is None:
        return default
    for name in names:
        if isinstance(obj, dict) and name in obj:
            return obj.get(name)
        if hasattr(obj, name):
            try:
                return getattr(obj, name)
            except Exception:
                pass
        getter = getattr(obj, "get", None)
        if callable(getter):
            try:
                value = getter(name)
                if value is not None:
                    return value
            except Exception:
                pass
    return default


def _to_text(value):
    if value is None:
        return None
    if isinstance(value, bytes):
        for encoding in ("utf-8", "gb18030", "latin-1"):
            try:
                text = value.decode(encoding)
                break
            except Exception:
                text = repr(value)
    elif isinstance(value, (str, int, float, bool)):
        text = str(value)
    else:
        try:
            text = json.dumps(value, ensure_ascii=False)
        except Exception:
            text = str(value)
    if len(text) > TEXT_LIMIT:
        return text[:TEXT_LIMIT] + "\\n...[truncated %d chars]" % (len(text) - TEXT_LIMIT)
    return text


def _headers(value):
    headers = _get(value, "headers", "header", default=value)
    result = {}
    if headers is None:
        return result
    if isinstance(headers, dict):
        iterable = headers.items()
    elif isinstance(headers, (list, tuple)):
        iterable = []
        for item in headers:
            if isinstance(item, dict):
                name = item.get("name") or item.get("key")
                val = item.get("value") or item.get("val")
                if name is not None and val is not None:
                    result[str(name)] = _to_text(val) or ""
            elif isinstance(item, str) and ":" in item:
                name, val = item.split(":", 1)
                result[name.strip()] = val.strip()
        return result
    else:
        items = getattr(headers, "items", None)
        if callable(items):
            try:
                iterable = items()
            except Exception:
                iterable = []
        else:
            iterable = []
    for name, val in iterable:
        result[str(name)] = _to_text(val) or ""
    return result


def _body(message):
    return _to_text(_get(message, "body", "text", "content", "data", "payload"))


def _request_record(request):
    return {
        "method": _to_text(_get(request, "method", default="GET")) or "GET",
        "url": _to_text(_get(request, "url", "uri", "href", "requestUrl", "fullUrl")) or "",
        "headers": _headers(request),
        "body": _body(request),
    }


def _response_record(response):
    if response is None:
        return {}
    return {
        "status": _get(response, "status", "statusCode", "code"),
        "statusText": _to_text(_get(response, "statusText", "reason", "message")),
        "headers": _headers(response),
        "body": _body(response),
    }


def emit_transaction(request=None, response=None, **extra):
    record = {
        "schema": SCHEMA,
        "startedAt": _to_text(extra.get("startedAt")) or _now_iso(),
        "durationMs": extra.get("durationMs") or extra.get("duration") or extra.get("elapsedMs"),
        "request": _request_record(request),
        "response": _response_record(response),
    }
    if extra:
        record["extra"] = {key: _to_text(value) for key, value in extra.items() if key not in ("startedAt", "durationMs", "duration", "elapsedMs")}
    os.makedirs(os.path.dirname(EVENTS_PATH), exist_ok=True)
    with open(EVENTS_PATH, "a", encoding="utf-8") as file:
        file.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\\n")
    return record


# Candidate passive callbacks. If your Reqable scripting panel expects different
# names/signatures, call emit_transaction(request, response, ...) from that hook.

def on_response(context=None, request=None, response=None):
    try:
        if response is None and request is not None:
            response = _get(request, "response", "res")
        emit_transaction(request, response)
    except Exception:
        traceback.print_exc()
    return response


def on_request_response(request=None, response=None):
    try:
        emit_transaction(request, response)
    except Exception:
        traceback.print_exc()
    return response


def response(context=None, flow=None):
    try:
        request = _get(flow, "request", "req") if flow is not None else _get(context, "request", "req")
        response_obj = _get(flow, "response", "res") if flow is not None else _get(context, "response", "res")
        emit_transaction(request, response_obj)
    except Exception:
        traceback.print_exc()
    return flow


def request(context=None, flow=None):
    return flow


if __name__ == "__main__":
    emit_transaction(
        {"method": "GET", "url": "https://example.local/reqable-mcp-bridge-test", "headers": {"x-source": "manual-test"}},
        {"status": 200, "headers": {"content-type": "application/json"}, "body": {"ok": True, "ts": time.time()}},
    )
    print(EVENTS_PATH)
`;
}

function renderReqableBridgeScriptV2(eventsPath: string, receiverUrl?: string): string {
  return `# Reqable MCP Bridge
#
# Purpose: write completed Reqable HTTP sessions into NDJSON so
# PacketCapture-MCP can import and analyze them.
#
# Reqable official script callbacks are onRequest(context, request) and
# onResponse(context, response). The request snapshot is stored in
# context.shared during onRequest and joined with the response in onResponse.
# This script is passive: it does not modify requests or responses.

import base64
import datetime
import hashlib
import json
import os
import time
import traceback
import urllib.parse
import urllib.request

EVENTS_PATH = ${JSON.stringify(eventsPath)}
RECEIVER_URL = ${JSON.stringify(receiverUrl ?? "")}
SCHEMA = "reqable-mcp-bridge.v2.ndjson"
TEXT_LIMIT = 256 * 1024
SHARED_REQUEST_KEY = "reqable_mcp_request"
SHARED_STARTED_EPOCH_MS_KEY = "reqable_mcp_started_epoch_ms"


def _now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _epoch_ms():
    return int(time.time() * 1000)


def _get(obj, *names, default=None):
    if obj is None:
        return default
    for name in names:
        if isinstance(obj, dict) and name in obj:
            return obj.get(name)
        if hasattr(obj, name):
            try:
                return getattr(obj, name)
            except Exception:
                pass
        getter = getattr(obj, "get", None)
        if callable(getter):
            try:
                value = getter(name)
                if value is not None:
                    return value
            except Exception:
                pass
    return default


def _first(*values):
    for value in values:
        if value is not None:
            return value
    return None


def _text(value):
    if value is None:
        return None
    if isinstance(value, bytes):
        for encoding in ("utf-8", "gb18030"):
            try:
                return value.decode(encoding)
            except Exception:
                pass
        return None
    if isinstance(value, bytearray):
        return _text(bytes(value))
    if isinstance(value, memoryview):
        return _text(value.tobytes())
    if isinstance(value, (str, int, float, bool)):
        return str(value)
    try:
        return json.dumps(value, ensure_ascii=False, default=str)
    except Exception:
        return str(value)


def _limit_text(text):
    if text is None:
        return None, False
    if len(text) <= TEXT_LIMIT:
        return text, False
    return text[:TEXT_LIMIT] + "\\n...[truncated %d chars]" % (len(text) - TEXT_LIMIT), True


def _is_probably_binary(text):
    if text is None:
        return False
    sample = text[:4096]
    if "\\x00" in sample:
        return True
    control = 0
    for char in sample:
        code = ord(char)
        if code < 32 and char not in ("\\r", "\\n", "\\t"):
            control += 1
    return control > max(8, len(sample) // 20)


def _as_bytes(value):
    if isinstance(value, bytes):
        return value
    if isinstance(value, bytearray):
        return bytes(value)
    if isinstance(value, memoryview):
        return value.tobytes()
    return None


def _extract_body_value(message):
    body = _get(message, "body", "text", "content", "data", "payload")
    if body is None:
        return None
    if isinstance(body, (bytes, bytearray, memoryview, str, int, float, bool)):
        return body
    nested = _first(
        _get(body, "text", "string", "content", "data", "payload", "value"),
        _get(body, "bytes", "raw", "buffer"),
    )
    return nested if nested is not None else body


def _body_info(message):
    value = _extract_body_value(message)
    if value is None:
        return {"body": None, "bodySizeBytes": 0}

    raw_bytes = _as_bytes(value)
    if raw_bytes is not None:
        size = len(raw_bytes)
        sha256 = hashlib.sha256(raw_bytes).hexdigest()
        decoded = None
        decoded_encoding = None
        for encoding in ("utf-8", "gb18030"):
            try:
                decoded = raw_bytes.decode(encoding)
                decoded_encoding = encoding
                break
            except Exception:
                pass

        if decoded is None or _is_probably_binary(decoded):
            sample = base64.b64encode(raw_bytes[:1024]).decode("ascii") if raw_bytes else ""
            return {
                "body": None,
                "bodyEncoding": "binary",
                "bodyIsBinary": True,
                "bodySizeBytes": size,
                "bodySha256": sha256,
                "bodyBase64Sample": sample,
            }

        limited, truncated = _limit_text(decoded)
        return {
            "body": limited,
            "bodyEncoding": decoded_encoding or "text",
            "bodyIsBinary": False,
            "bodySizeBytes": size,
            "bodySha256": sha256,
            "bodyTruncated": truncated,
        }

    text = _text(value)
    limited, truncated = _limit_text(text)
    return {
        "body": limited,
        "bodyEncoding": "text",
        "bodyIsBinary": bool(_is_probably_binary(text)),
        "bodySizeBytes": len(text.encode("utf-8")) if text is not None else 0,
        "bodyTruncated": truncated,
    }


def _headers(value):
    headers = _get(value, "headers", "header", default=value)
    result = {}
    if headers is None:
        return result
    if isinstance(headers, dict):
        iterable = headers.items()
    elif isinstance(headers, (list, tuple)):
        iterable = []
        for item in headers:
            if isinstance(item, dict):
                name = item.get("name") or item.get("key")
                val = item.get("value") if "value" in item else item.get("val")
                if name is not None:
                    result[str(name)] = _text(val) or ""
            elif isinstance(item, (list, tuple)) and len(item) >= 2:
                result[str(item[0])] = _text(item[1]) or ""
            elif isinstance(item, str) and ":" in item:
                name, val = item.split(":", 1)
                result[name.strip()] = val.strip()
        return result
    else:
        items = getattr(headers, "items", None)
        if callable(items):
            try:
                iterable = items()
            except Exception:
                iterable = []
        else:
            iterable = []
    for name, val in iterable:
        result[str(name)] = _text(val) or ""
    return result


def _query_items(value):
    if value is None:
        return []
    if isinstance(value, str):
        return urllib.parse.parse_qsl(value[1:] if value.startswith("?") else value, keep_blank_values=True)
    if isinstance(value, dict):
        items = []
        for key, raw in value.items():
            if isinstance(raw, (list, tuple)):
                for item in raw:
                    items.append((str(key), _text(item) or ""))
            else:
                items.append((str(key), _text(raw) or ""))
        return items
    if isinstance(value, (list, tuple)):
        items = []
        for item in value:
            if isinstance(item, dict):
                name = item.get("name") or item.get("key")
                val = item.get("value") if "value" in item else item.get("val")
                if name is not None:
                    items.append((str(name), _text(val) or ""))
            elif isinstance(item, (list, tuple)) and len(item) >= 2:
                items.append((str(item[0]), _text(item[1]) or ""))
            elif isinstance(item, str):
                items.extend(urllib.parse.parse_qsl(item[1:] if item.startswith("?") else item, keep_blank_values=True))
        return items
    return []


def _query_string(value):
    items = _query_items(value)
    return urllib.parse.urlencode(items, doseq=True) if items else None


def _queries_record(value):
    result = {}
    for name, val in _query_items(value):
        if name in result:
            existing = result[name]
            if isinstance(existing, list):
                existing.append(val)
            else:
                result[name] = [existing, val]
        else:
            result[name] = val
    return result


def _path_only(path):
    text = _text(path)
    if not text:
        return None
    if "://" in text:
        try:
            parsed = urllib.parse.urlsplit(text)
            return parsed.path or "/"
        except Exception:
            return text
    return text.split("?", 1)[0] or "/"


def _build_url(context, request):
    direct = _first(
        _get(context, "url", "href", "requestUrl", "fullUrl"),
        _get(request, "url", "uri", "href", "requestUrl", "fullUrl"),
    )
    direct_text = _text(direct)
    if direct_text and "://" in direct_text:
        return direct_text

    scheme = _text(_first(_get(context, "scheme"), _get(request, "scheme"))) or "http"
    host = _text(_first(_get(context, "host"), _get(request, "host")))
    port = _text(_first(_get(context, "port"), _get(request, "port")))
    path = _path_only(_first(_get(request, "path"), _get(context, "path"), direct_text)) or "/"
    query = _query_string(_first(_get(request, "queries", "query"), _get(context, "queries", "query")))

    if not host:
        return direct_text or path

    port_suffix = ""
    if port and ":" not in host and not ((scheme == "http" and port == "80") or (scheme == "https" and port == "443")):
        port_suffix = ":" + port
    url = "%s://%s%s%s" % (scheme, host, port_suffix, path if path.startswith("/") else "/" + path)
    if query:
        url += "?" + query
    return url


def _timestamp_to_iso(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        timestamp = float(value)
        if timestamp > 100000000000:
            timestamp = timestamp / 1000.0
        try:
            return datetime.datetime.fromtimestamp(timestamp, datetime.timezone.utc).isoformat()
        except Exception:
            return _text(value)
    text = _text(value)
    if not text:
        return None
    try:
        number = float(text)
        if number > 100000000000:
            number = number / 1000.0
        if number > 1000000000:
            return datetime.datetime.fromtimestamp(number, datetime.timezone.utc).isoformat()
    except Exception:
        pass
    return text


def _context_record(context):
    if context is None:
        return {}
    return {
        "id": _text(_get(context, "id")),
        "uid": _text(_get(context, "uid")),
        "url": _text(_get(context, "url")),
        "scheme": _text(_get(context, "scheme")),
        "host": _text(_get(context, "host")),
        "port": _text(_get(context, "port")),
        "timestamp": _timestamp_to_iso(_get(context, "timestamp", "time", "startedAt", "startTime")),
    }


def _app_record(context, request=None, response=None):
    app = _first(_get(context, "app", "application"), _get(request, "app", "application"), _get(response, "app", "application"))
    return {
        "name": _text(_first(_get(app, "name", "appName"), _get(context, "appName"), _get(request, "appName"))),
        "package": _text(_first(_get(app, "package", "packageName", "bundleId"), _get(context, "packageName"), _get(request, "packageName"))),
        "process": _text(_first(_get(app, "process", "processName"), _get(context, "processName"), _get(request, "processName"))),
        "pid": _text(_first(_get(app, "pid", "processId"), _get(context, "pid", "processId"), _get(request, "pid", "processId"))),
    }


def _connection_record(context, request=None, response=None):
    connection = _first(_get(context, "connection"), _get(request, "connection"), _get(response, "connection"))
    return {
        "clientIp": _text(_first(_get(connection, "clientIp", "clientAddress"), _get(context, "clientIp", "clientAddress"))),
        "clientPort": _text(_first(_get(connection, "clientPort"), _get(context, "clientPort"))),
        "serverIp": _text(_first(_get(connection, "serverIp", "remoteAddress", "serverAddress"), _get(context, "serverIp", "remoteAddress"))),
        "serverPort": _text(_first(_get(connection, "serverPort", "remotePort"), _get(context, "serverPort", "remotePort"))),
        "tls": _text(_first(_get(connection, "tls", "ssl"), _get(context, "tls", "ssl"))),
    }


def _compact(record):
    return {key: value for key, value in record.items() if value is not None and value != {}}


def _append_event(record):
    os.makedirs(os.path.dirname(EVENTS_PATH), exist_ok=True)
    line = json.dumps(record, ensure_ascii=False, separators=(",", ":"), default=str)
    with open(EVENTS_PATH, "a", encoding="utf-8") as file:
        file.write(line + "\\n")
    return line


def _post_event(record):
    receiver_url = _text(os.environ.get("REQABLE_MCP_RECEIVER_URL")) or RECEIVER_URL
    if not receiver_url:
        return False
    data = json.dumps(record, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8")
    request = urllib.request.Request(
        receiver_url,
        data=data,
        headers={
            "content-type": "application/json; charset=utf-8",
            "x-reqable-mcp-source": "script-bridge",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=2.0) as response:
            response.read()
        return True
    except Exception:
        traceback.print_exc()
        return False


def _request_record(context, request):
    query_source = _first(_get(request, "queries", "query"), _get(context, "queries", "query"))
    body = _body_info(request)
    return _compact({
        "method": (_text(_get(request, "method", default="GET")) or "GET").upper(),
        "url": _build_url(context, request) or "",
        "scheme": _text(_first(_get(context, "scheme"), _get(request, "scheme"))),
        "host": _text(_first(_get(context, "host"), _get(request, "host"))),
        "port": _text(_first(_get(context, "port"), _get(request, "port"))),
        "path": _path_only(_first(_get(request, "path"), _get(context, "path"))),
        "query": _query_string(query_source),
        "queries": _queries_record(query_source),
        "protocol": _text(_first(_get(request, "protocol", "httpVersion"), _get(context, "protocol", "httpVersion"))),
        "headers": _headers(request),
        **body,
    })


def _response_record(context, response):
    if response is None:
        return {}
    body = _body_info(response)
    return _compact({
        "status": _get(response, "status", "statusCode", "code"),
        "code": _get(response, "code", "status", "statusCode"),
        "statusText": _text(_get(response, "statusText", "reason", "message")),
        "protocol": _text(_first(_get(response, "protocol", "httpVersion"), _get(context, "protocol", "httpVersion"))),
        "headers": _headers(response),
        **body,
    })


def _shared_get(context, key):
    shared = _get(context, "shared")
    if shared is None:
        return None
    if isinstance(shared, dict):
        return shared.get(key)
    getter = getattr(shared, "get", None)
    if callable(getter):
        try:
            return getter(key)
        except Exception:
            pass
    return _get(shared, key)


def _shared_set(context, key, value):
    shared = _get(context, "shared")
    if shared is None:
        return False
    if isinstance(shared, dict):
        shared[key] = value
        return True
    setter = getattr(shared, "set", None)
    if callable(setter):
        try:
            setter(key, value)
            return True
        except Exception:
            pass
    try:
        setattr(shared, key, value)
        return True
    except Exception:
        return False


def emit_transaction(context=None, request=None, response=None, **extra):
    started_epoch_ms = extra.get("startedEpochMs")
    duration_ms = extra.get("durationMs")
    if duration_ms is None and started_epoch_ms:
        try:
            duration_ms = max(0, _epoch_ms() - int(started_epoch_ms))
        except Exception:
            duration_ms = None

    request_record = request if isinstance(request, dict) and request.get("url") is not None else _request_record(context, request)
    response_record = _response_record(context, response)
    context_record = _context_record(context)
    started_at = _first(
        request_record.get("startedAt") if isinstance(request_record, dict) else None,
        context_record.get("timestamp"),
        extra.get("startedAt"),
        _now_iso(),
    )
    record = {
        "schema": SCHEMA,
        "type": "http-session",
        "id": _first(context_record.get("id"), context_record.get("uid")),
        "uid": context_record.get("uid"),
        "startedAt": _timestamp_to_iso(started_at),
        "endedAt": _now_iso(),
        "durationMs": duration_ms if duration_ms is not None else _first(extra.get("duration"), extra.get("elapsedMs"), _get(response, "duration", "durationMs", "elapsedMs")),
        "context": _compact(context_record),
        "app": _compact(_app_record(context, request, response)),
        "connection": _compact(_connection_record(context, request, response)),
        "request": request_record,
        "response": response_record,
    }
    clean_extra = {key: _text(value) for key, value in extra.items() if key not in ("startedAt", "startedEpochMs", "durationMs", "duration", "elapsedMs") and value is not None}
    if clean_extra:
        record["extra"] = clean_extra
    _append_event(record)
    _post_event(record)
    return record


def onRequest(context, request):
    try:
        request_record = _request_record(context, request)
        request_record["startedAt"] = _timestamp_to_iso(_get(context, "timestamp", "time", "startedAt", "startTime")) or _now_iso()
        _shared_set(context, SHARED_REQUEST_KEY, request_record)
        _shared_set(context, SHARED_STARTED_EPOCH_MS_KEY, _epoch_ms())
    except Exception:
        traceback.print_exc()
    return request


def onResponse(context, response):
    try:
        request_record = _shared_get(context, SHARED_REQUEST_KEY)
        if request_record is None:
            request_record = _request_record(context, _get(response, "request"))
        emit_transaction(context, request_record, response, startedEpochMs=_shared_get(context, SHARED_STARTED_EPOCH_MS_KEY))
    except Exception:
        traceback.print_exc()
    return response


if __name__ == "__main__":
    emit_transaction(
        {"url": "https://example.local/reqable-mcp-bridge-test", "scheme": "https", "host": "example.local", "id": "manual-test"},
        {"method": "GET", "path": "/reqable-mcp-bridge-test", "headers": {"x-source": "manual-test"}},
        {"status": 200, "headers": {"content-type": "application/json"}, "body": {"ok": True, "ts": time.time()}},
    )
    print(EVENTS_PATH)
`;
}

function reqableBridgeNextSteps(scriptPath: string, eventsPath: string): string[] {
  return [
    `Open Reqable scripting and add/load ${scriptPath}.`,
    "Keep Reqable capture/proxy running for the target app or browser.",
    `The script appends one JSON transaction per line to ${eventsPath}.`,
    "Call get_reqable_inbox_status to verify data, then analyze_reqable_inbox to import and analyze it.",
  ];
}

export async function importReqableInbox(options: { inboxDir?: string; eventsFile?: string; archive?: boolean; captureId?: string } = {}): Promise<CaptureDataset> {
  const config = await getBridgeConfig(options);
  const content = await readFile(config.absoluteEventsPath, "utf8");
  const capture = parseReqableBridgeNdjson(content, {
    source: config.absoluteEventsPath,
    datasetId: options.captureId,
  });

  if (options.archive) {
    const archivePath = join(config.inboxDir, `events-${new Date().toISOString().replace(/[:.]/g, "-")}.ndjson`);
    await rename(config.absoluteEventsPath, archivePath);
    await writeFile(config.absoluteEventsPath, "");
    capture.metadata.archivedTo = archivePath;
  }

  return capture;
}

export function parseReqableBridgeNdjson(content: string, options: { source: string; datasetId?: string }): CaptureDataset {
  const records: UnknownRecord[] = [];
  const errors: Array<{ line: number; error: string }> = [];
  const lines = content.split(/\r?\n/);

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed);
      if (isRecord(parsed)) records.push(parsed);
    } catch (error) {
      errors.push({ line: index + 1, error: error instanceof Error ? error.message : String(error) });
    }
  });

  const sessions = records.flatMap((record, index) => recordToSession(record, index));
  if (sessions.length === 0) {
    throw new Error(errors.length > 0 ? `No valid Reqable bridge events found. First parse error: line ${errors[0]?.line} ${errors[0]?.error}` : "No Reqable bridge events found.");
  }

  const schemas = uniqueStrings(records.map((record) => firstString(record.schema, getPath(record, ["har", "log", "version"]), getPath(record, ["log", "version"]))));
  const id = options.datasetId?.trim() || createId(`${options.source}:reqable-bridge:${Date.now()}`);
  return {
    id,
    source: options.source,
    format: "reqable-bridge-ndjson",
    importedAt: new Date().toISOString(),
    sessionCount: sessions.length,
    sessions,
    metadata: {
      parser: "reqable-bridge-ndjson",
      records: records.length,
      enhancedRecords: records.filter(isEnhancedReqableRecord).length,
      harPushRecords: records.filter(hasHarPayload).length,
      schemas,
      appSamples: uniqueStrings(records.map(appSummary)).slice(0, 20),
      connectionSamples: uniqueStrings(records.map(connectionSummary)).slice(0, 20),
      reportServerHarPushIngest: true,
      parseErrors: errors,
    },
  };
}

function recordToSession(record: UnknownRecord, index: number): HttpSession[] {
  const harPayload = findHarPayload(record);
  if (harPayload) return harToSessions(harPayload, index);

  const harEntry = findHarEntry(record);
  if (harEntry) return harEntryToSession(harEntry, index, 0, "Reqable Report Server HAR push");

  const context = firstRecord(record.context, record.ctx) ?? {};
  const request = firstRecord(record.request, record.req) ?? record;
  const response = firstRecord(record.response, record.res) ?? {};
  const url = buildSessionUrl(record, request, context);
  if (!url) return [];

  const method = normalizeMethod(firstString(request.method, record.method) ?? "GET");
  const parsedUrl = parseUrl(url);
  const requestHeaders = normalizeHeaders(firstValue(request.headers, request.header, record.requestHeaders));
  const responseHeaders = normalizeHeaders(firstValue(response.headers, response.header, record.responseHeaders));
  const requestBody = bodyFromMessage(request, record.requestBody);
  const responseBody = bodyFromMessage(response, record.responseBody);
  const requestBodyMetadata = bodyMetadata(request);
  const responseBodyMetadata = bodyMetadata(response);
  const startedAt = firstString(record.startedAt, record.timestamp, record.time, request.startedAt, request.timestamp, context.timestamp);
  const query = firstString(
    queryToString(firstValue(request.query, request.queries, context.query, context.queries, record.query, record.queries)),
    parsedUrl?.search ? parsedUrl.search.slice(1) : undefined,
  );
  const notes = collectNotes([
    "Imported from Reqable script bridge NDJSON.",
    ...bodyNotes("request", requestBodyMetadata),
    ...bodyNotes("response", responseBodyMetadata),
    appSummary(record),
    connectionSummary(record),
  ]);

  return [{
    id: firstString(record.id, record.uid, record.sessionId, context.id, context.uid) ?? createId(`${index}:${method}:${url}:${startedAt ?? ""}`),
    sourceIndex: index,
    method,
    url,
    scheme: firstString(request.scheme, context.scheme, record.scheme, parsedUrl?.protocol.replace(":", "")),
    host: firstString(request.host, context.host, record.host, parsedUrl?.host),
    path: firstString(request.path, context.path, record.path, parsedUrl?.pathname),
    query,
    protocol: firstString(record.protocol, request.protocol, response.protocol, request.httpVersion, response.httpVersion),
    startedAt,
    durationMs: firstNumber(record.durationMs, record.duration, record.elapsedMs, record.cost, response.durationMs, response.duration, response.elapsedMs),
    status: firstNumber(response.status, response.statusCode, response.code, record.status, record.statusCode, record.code),
    statusText: firstString(response.statusText, response.message, response.reason, record.statusText, record.message),
    requestHeaders,
    responseHeaders,
    requestBody,
    responseBody,
    requestSizeBytes: firstNumber(record.requestSizeBytes, record.requestBodySizeBytes, requestBodyMetadata.sizeBytes, request.size, request.bodySize) ?? byteLength(requestBody),
    responseSizeBytes: firstNumber(record.responseSizeBytes, record.responseBodySizeBytes, responseBodyMetadata.sizeBytes, response.size, response.bodySize) ?? byteLength(responseBody),
    requestContentType: headerValue(requestHeaders, "content-type") ?? requestBodyMetadata.contentType,
    responseContentType: headerValue(responseHeaders, "content-type") ?? responseBodyMetadata.contentType,
    notes,
  }];
}

function buildSessionUrl(record: UnknownRecord, request: UnknownRecord, context: UnknownRecord): string | undefined {
  const direct = firstString(request.url, request.href, request.requestUrl, request.fullUrl, record.url, record.requestUrl, context.url);
  if (direct && /^[a-z][a-z0-9+.-]*:\/\//i.test(direct)) return direct;

  const scheme = firstString(request.scheme, context.scheme, record.scheme) ?? "http";
  const host = firstString(request.host, context.host, record.host);
  const port = firstString(request.port, context.port, record.port);
  const pathSource = firstString(request.path, context.path, record.path, direct);
  const splitPath = splitPathAndQuery(pathSource);
  const path = splitPath.path ?? "/";
  const query = queryToString(firstValue(request.query, request.queries, context.query, context.queries, record.query, record.queries)) ?? splitPath.query;

  if (!host) return direct || pathSource;

  const portSuffix = port && !host.includes(":") && !((scheme === "http" && port === "80") || (scheme === "https" && port === "443")) ? `:${port}` : "";
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${scheme}://${host}${portSuffix}${normalizedPath}${query ? `?${query}` : ""}`;
}

function splitPathAndQuery(value: string | undefined): { path?: string; query?: string } {
  if (!value) return {};
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const parsed = parseUrl(value);
    return { path: parsed?.pathname, query: parsed?.search ? parsed.search.slice(1) : undefined };
  }

  const index = value.indexOf("?");
  if (index < 0) return { path: value || "/" };
  return {
    path: value.slice(0, index) || "/",
    query: value.slice(index + 1) || undefined,
  };
}

function queryToString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed.replace(/^\?/, "") : undefined;
  }

  const pairs: Array<[string, string]> = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (Array.isArray(item) && item.length >= 2) {
        pairs.push([String(item[0]), bodyToString(item[1]) ?? ""]);
      } else if (isRecord(item)) {
        const name = firstString(item.name, item.key);
        if (name) pairs.push([name, bodyToString(firstValue(item.value, item.val)) ?? ""]);
      } else if (typeof item === "string") {
        const text = item.replace(/^\?/, "");
        if (text) pairs.push(...new URLSearchParams(text).entries());
      }
    }
  } else if (isRecord(value)) {
    for (const [key, raw] of Object.entries(value)) {
      if (Array.isArray(raw)) {
        for (const item of raw) pairs.push([key, bodyToString(item) ?? ""]);
      } else {
        pairs.push([key, bodyToString(raw) ?? ""]);
      }
    }
  }

  if (pairs.length === 0) return undefined;
  const params = new URLSearchParams();
  for (const [key, val] of pairs) params.append(key, val);
  return params.toString() || undefined;
}

function bodyFromMessage(message: UnknownRecord, fallback: unknown): string | undefined {
  if (bodyMetadata(message).isBinary === true) return undefined;
  const direct = firstValue(message.body, message.text, message.content, message.data, message.payload, fallback);
  const bodyValue = extractBodyValue(direct);
  return limitText(bodyToString(bodyValue));
}

function extractBodyValue(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return firstValue(value.text, value.string, value.content, value.data, value.payload, value.value, value.raw, value.bytes, value);
}

function bodyMetadata(message: UnknownRecord): BodyMetadata {
  const body = firstRecord(message.body, message.content, message.data, message.payload) ?? {};
  return {
    sizeBytes: firstNumber(message.bodySizeBytes, message.bodyBytes, message.bodySize, body.bodySizeBytes, body.sizeBytes, body.size, body.length),
    encoding: firstString(message.bodyEncoding, message.encoding, body.bodyEncoding, body.encoding),
    isBinary: firstBoolean(message.bodyIsBinary, message.isBinary, body.bodyIsBinary, body.isBinary),
    isTruncated: firstBoolean(message.bodyTruncated, message.truncated, body.bodyTruncated, body.truncated),
    sha256: firstString(message.bodySha256, message.sha256, body.bodySha256, body.sha256),
    base64Sample: firstString(message.bodyBase64Sample, message.base64Sample, body.bodyBase64Sample, body.base64Sample),
    contentType: firstString(message.bodyContentType, message.contentType, body.bodyContentType, body.contentType),
  };
}

function bodyNotes(label: "request" | "response", metadata: BodyMetadata): string[] {
  return presentStrings([
    metadata.isBinary === true ? `Reqable ${label} body was binary; text body omitted.` : undefined,
    metadata.isTruncated === true ? `Reqable ${label} body was truncated by bridge.` : undefined,
    metadata.encoding && !/^text$/i.test(metadata.encoding) ? `Reqable ${label} body encoding: ${metadata.encoding}.` : undefined,
    metadata.sizeBytes !== undefined ? `Reqable ${label} body size: ${metadata.sizeBytes} bytes.` : undefined,
    metadata.sha256 ? `Reqable ${label} body sha256: ${metadata.sha256}.` : undefined,
    metadata.base64Sample ? `Reqable ${label} body base64 sample preserved.` : undefined,
  ]);
}

function appSummary(record: UnknownRecord): string | undefined {
  const app = firstRecord(record.app, record.application, getPath(record, ["context", "app"]), getPath(record, ["context", "application"]));
  if (!app) return undefined;
  const name = firstString(app.name, app.appName);
  const pkg = firstString(app.package, app.packageName, app.bundleId);
  const processName = firstString(app.process, app.processName);
  const pid = firstString(app.pid, app.processId);
  const parts = [name, pkg ? `package=${pkg}` : undefined, processName ? `process=${processName}` : undefined, pid ? `pid=${pid}` : undefined].filter(Boolean);
  return parts.length > 0 ? `Reqable app: ${parts.join(", ")}.` : undefined;
}

function connectionSummary(record: UnknownRecord): string | undefined {
  const connection = firstRecord(record.connection, getPath(record, ["context", "connection"]));
  if (!connection) return undefined;
  const client = joinHostPort(firstString(connection.clientIp, connection.clientAddress), firstString(connection.clientPort));
  const server = joinHostPort(firstString(connection.serverIp, connection.remoteAddress, connection.serverAddress), firstString(connection.serverPort, connection.remotePort));
  const tls = firstString(connection.tls, connection.ssl);
  const parts = [client && server ? `${client} -> ${server}` : client || server, tls ? `tls=${tls}` : undefined].filter(Boolean);
  return parts.length > 0 ? `Reqable connection: ${parts.join(", ")}.` : undefined;
}

function joinHostPort(host: string | undefined, port: string | undefined): string | undefined {
  if (!host) return undefined;
  return port ? `${host}:${port}` : host;
}

function isEnhancedReqableRecord(record: UnknownRecord): boolean {
  return firstString(record.schema)?.startsWith("reqable-mcp-bridge.v2") === true
    || isRecord(record.context)
    || isRecord(record.app)
    || isRecord(record.connection)
    || getPath(record, ["request", "bodyEncoding"]) !== undefined
    || getPath(record, ["response", "bodyEncoding"]) !== undefined;
}

function hasHarPayload(record: UnknownRecord): boolean {
  return findHarPayload(record) !== undefined || findHarEntry(record) !== undefined;
}

function findHarPayload(record: UnknownRecord): UnknownRecord | undefined {
  const direct = isHarPayload(record) ? record : undefined;
  if (direct) return direct;

  for (const key of ["har", "payload", "body", "data"]) {
    const value = record[key];
    if (isHarPayload(value)) return value;
    if (typeof value === "string") {
      const parsed = parseJsonObject(value);
      if (isHarPayload(parsed)) return parsed;
    }
  }

  return undefined;
}

function isHarPayload(value: unknown): value is UnknownRecord {
  if (!isRecord(value)) return false;
  const log = firstRecord(value.log);
  return (log !== undefined && Array.isArray(log.entries)) || Array.isArray(value.entries);
}

function findHarEntry(record: UnknownRecord): UnknownRecord | undefined {
  for (const value of [record, record.harEntry, record.entry, record.payload, record.body, record.data]) {
    if (isHarEntry(value)) return value;
    if (typeof value === "string") {
      const parsed = parseJsonObject(value);
      if (isHarEntry(parsed)) return parsed;
    }
  }
  return undefined;
}

function isHarEntry(value: unknown): value is UnknownRecord {
  if (!isRecord(value)) return false;
  const request = firstRecord(value.request);
  const response = firstRecord(value.response);
  if (!request || !response || !firstString(request.url)) return false;
  return value.startedDateTime !== undefined
    || value.timings !== undefined
    || value.serverIPAddress !== undefined
    || value.connection !== undefined
    || request.httpVersion !== undefined
    || isRecord(response.content);
}

function harToSessions(har: UnknownRecord, recordIndex: number): HttpSession[] {
  const entries = getHarEntries(har);
  return entries.flatMap((entry, entryIndex) => harEntryToSession(entry, recordIndex, entryIndex, "Reqable Report Server HAR push"));
}

function getHarEntries(har: UnknownRecord): UnknownRecord[] {
  const entries = isRecord(har.log) && Array.isArray(har.log.entries) ? har.log.entries : Array.isArray(har.entries) ? har.entries : [];
  return entries.filter(isRecord);
}

function harEntryToSession(entry: UnknownRecord, recordIndex: number, entryIndex: number, source: string): HttpSession[] {
  const request = firstRecord(entry.request) ?? {};
  const response = firstRecord(entry.response) ?? {};
  const url = firstString(request.url, entry.url);
  if (!url) return [];

  const method = normalizeMethod(firstString(request.method, entry.method) ?? "GET");
  const parsedUrl = parseUrl(url);
  const requestHeaders = normalizeHeaders(request.headers);
  const responseHeaders = normalizeHeaders(response.headers);
  const requestBody = getHarRequestBody(request);
  const responseBody = getHarResponseBody(response);
  const requestPostDataMimeType = firstString(getPath(request, ["postData", "mimeType"]));
  const responseMimeType = firstString(getPath(response, ["content", "mimeType"]));
  const startedAt = firstString(entry.startedDateTime, entry.startedAt, entry.timestamp);
  const notes = collectNotes([
    `Imported from ${source}.`,
    getPath(response, ["content", "encoding"]) === "base64" ? "HAR response content is base64 encoded." : undefined,
    requestPostDataMimeType ? `HAR request mimeType: ${requestPostDataMimeType}` : undefined,
  ]);

  return [{
    id: createId(`${recordIndex}:${entryIndex}:${method}:${url}:${startedAt ?? ""}`),
    sourceIndex: recordIndex,
    method,
    url,
    scheme: parsedUrl?.protocol.replace(":", ""),
    host: parsedUrl?.host,
    path: parsedUrl?.pathname,
    query: parsedUrl?.search ? parsedUrl.search.slice(1) : undefined,
    protocol: firstString(entry._protocol, request.httpVersion, response.httpVersion),
    startedAt,
    durationMs: firstNumber(entry.time, entry.durationMs, entry.duration),
    status: firstNumber(response.status, response.statusCode),
    statusText: firstString(response.statusText),
    requestHeaders,
    responseHeaders,
    requestBody,
    responseBody,
    requestSizeBytes: firstNumber(request.bodySize, entry.requestBodySize) ?? byteLength(requestBody),
    responseSizeBytes: firstNumber(response.bodySize, getPath(response, ["content", "size"]), entry.responseBodySize) ?? byteLength(responseBody),
    requestContentType: headerValue(requestHeaders, "content-type") ?? requestPostDataMimeType,
    responseContentType: headerValue(responseHeaders, "content-type") ?? responseMimeType,
    notes,
  }];
}

function getHarRequestBody(request: UnknownRecord): string | undefined {
  const postData = firstRecord(request.postData);
  if (!postData) return undefined;
  return limitText(bodyToString(postData.text) ?? harParamsToBody(postData.params));
}

function getHarResponseBody(response: UnknownRecord): string | undefined {
  const content = firstRecord(response.content);
  if (!content) return undefined;
  return limitText(bodyToString(content.text));
}

function harParamsToBody(params: unknown): string | undefined {
  if (!Array.isArray(params)) return bodyToString(params);

  const encoded = new URLSearchParams();
  for (const param of params) {
    if (!isRecord(param)) return bodyToString(params);
    const name = firstString(param.name, param.key);
    if (!name || param.fileName !== undefined || param.contentType !== undefined) return bodyToString(params);
    encoded.append(name, bodyToString(firstValue(param.value, param.val)) ?? "");
  }

  return encoded.toString() || undefined;
}

function parseJsonObject(value: string): UnknownRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function presentStrings(values: Array<string | undefined>): string[] {
  return values.filter((value): value is string => Boolean(value));
}

function collectNotes(values: Array<string | undefined>): string[] {
  const notes = presentStrings(values);
  return notes.length > 0 ? notes : ["Imported from Reqable script bridge NDJSON."];
}

function normalizeHeaders(value: unknown): HeaderMap {
  const headers: HeaderMap = {};
  if (Array.isArray(value)) {
    for (const item of value) {
      if (isRecord(item)) {
        const name = firstString(item.name, item.key);
        const text = firstString(item.value, item.val);
        if (name && text !== undefined) headers[name] = text;
      } else if (typeof item === "string") {
        addHeaderLine(headers, item);
      }
    }
  } else if (isRecord(value)) {
    for (const [key, raw] of Object.entries(value)) {
      const text = bodyToString(raw);
      if (text !== undefined) headers[key] = text;
    }
  } else if (typeof value === "string") {
    for (const line of value.split(/\r?\n/)) addHeaderLine(headers, line);
  }
  return headers;
}

function addHeaderLine(headers: HeaderMap, line: string): void {
  const index = line.indexOf(":");
  if (index <= 0) return;
  headers[line.slice(0, index).trim()] = line.slice(index + 1).trim();
}

function headerValue(headers: HeaderMap, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === wanted)?.[1];
}

function bodyToString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function limitText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length <= TEXT_LIMIT) return value;
  return `${value.slice(0, TEXT_LIMIT)}\n...[truncated ${value.length - TEXT_LIMIT} chars]`;
}

function byteLength(value?: string): number | undefined {
  return value ? Buffer.byteLength(value) : undefined;
}

function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

function normalizeMethod(method: string): string {
  return method.trim().toUpperCase() || "GET";
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstRecord(...values: unknown[]): UnknownRecord | undefined {
  return values.find(isRecord);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return undefined;
}

function firstValue(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function getPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
  }
  return undefined;
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    if (typeof value === "string" && value.trim()) {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true") return true;
      if (normalized === "false") return false;
    }
  }
  return undefined;
}

function createId(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}
