import { Buffer } from "node:buffer";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { HeaderMap, HttpSession } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const BODY_PREVIEW_BYTES = 8_192;
const MAX_REDIRECTS = 5;
const HTTP_TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "x-session-token",
  "x-csrf-token",
  "x-xsrf-token",
]);

const ALWAYS_REMOVE_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "te",
  "trailer",
  "upgrade",
  "expect",
]);

export interface ReplayRequestOptions {
  urlOverride?: string;
  methodOverride?: string;
  headerOverrides?: HeaderMap;
  removeHeaders?: string[];
  bodyOverride?: string;
  includeSensitiveHeaders?: boolean;
  timeoutMs?: number;
  maxResponseBytes?: number;
  followRedirects?: boolean;
  allowOriginalUrl?: boolean;
  allowPrivateNetwork?: boolean;
  dryRun?: boolean;
}

export interface ReplayRequestPlan {
  method: string;
  url: string;
  headers: HeaderMap;
  bodyPreview?: string;
  bodyBytes: number;
  removedHeaders: Array<{ name: string; reason: string }>;
  warnings: string[];
}

export interface ReplayResponseResult {
  status?: number;
  statusText?: string;
  headers: HeaderMap;
  body: string;
  bodyTruncated: boolean;
  durationMs: number;
  error?: string;
}

export interface ReplayResult {
  executed: boolean;
  plan: ReplayRequestPlan;
  response?: ReplayResponseResult;
  warning?: string;
}

export function buildReplayRequest(session: HttpSession, options: ReplayRequestOptions = {}): ReplayRequestPlan {
  const removedHeaders: Array<{ name: string; reason: string }> = [];
  const warnings: string[] = [];
  const method = normalizeMethod(options.methodOverride ?? session.method);
  const url = normalizeUrl(options.urlOverride ?? session.url);
  const targetHostname = hostnameFor(url);
  const connectionHeaderValues: string[] = [];

  const headers: HeaderMap = {};
  for (const [name, value] of Object.entries(session.requestHeaders)) {
    const normalizedName = normalizeHeaderName(name);
    const lowerName = normalizedName.toLowerCase();
    if (!normalizedName) {
      removedHeaders.push({ name, reason: "invalid header name" });
      continue;
    }
    if (normalizedName.startsWith(":")) {
      removedHeaders.push({ name, reason: "http2 pseudo header" });
      continue;
    }
    if (!isValidHttpToken(normalizedName)) {
      removedHeaders.push({ name, reason: "invalid header name" });
      continue;
    }
    if (lowerName === "connection") {
      connectionHeaderValues.push(value);
    }
    if (ALWAYS_REMOVE_HEADERS.has(lowerName)) {
      removedHeaders.push({ name, reason: "connection-managed header" });
      continue;
    }
    if (!options.includeSensitiveHeaders && isSensitiveHeader(lowerName)) {
      removedHeaders.push({ name, reason: "sensitive header omitted by default" });
      continue;
    }
    headers[normalizedName] = sanitizeHeaderValue(value);
  }

  for (const connectionValue of connectionHeaderValues) {
    for (const listedHeader of parseConnectionHeaderNames(connectionValue)) {
      removeHeader(headers, removedHeaders, listedHeader, "listed by Connection header");
    }
  }

  for (const name of options.removeHeaders ?? []) {
    removeHeader(headers, removedHeaders, name, "removed by user option");
  }

  for (const [name, value] of Object.entries(options.headerOverrides ?? {})) {
    const normalizedName = normalizeHeaderName(name);
    if (!normalizedName || normalizedName.startsWith(":") || !isValidHttpToken(normalizedName)) {
      removedHeaders.push({ name, reason: "invalid override header" });
      continue;
    }
    const lowerName = normalizedName.toLowerCase();
    if (ALWAYS_REMOVE_HEADERS.has(lowerName)) {
      removedHeaders.push({ name, reason: "unsafe override header ignored" });
      continue;
    }
    headers[normalizedName] = sanitizeHeaderValue(value);
  }

  const body = requestBodyFor(method, options.bodyOverride ?? session.requestBody);
  const bodyBytes = body === undefined ? 0 : Buffer.byteLength(body, "utf8");
  const bodyPreview = body === undefined ? undefined : truncateUtf8(body, BODY_PREVIEW_BYTES).text;

  if (method === "GET" || method === "HEAD") {
    if (options.bodyOverride !== undefined || session.requestBody !== undefined) {
      warnings.push(`${method} replay omits captured request body.`);
    }
  }
  if (!options.includeSensitiveHeaders && removedHeaders.some((header) => header.reason.includes("sensitive"))) {
    warnings.push("Sensitive headers were omitted. Pass includeSensitiveHeaders=true or headerOverrides only when replaying against a safe target.");
  }
  if (!options.urlOverride) {
    warnings.push("Replaying the original URL can affect a real service. replay_http_request requires allowOriginalUrl=true when urlOverride is not provided.");
  }
  if (targetHostname && isNonPublicHostname(targetHostname) && !options.allowPrivateNetwork) {
    warnings.push("Target host is localhost, private, link-local, or reserved. replay_http_request requires allowPrivateNetwork=true for this target.");
  }

  return { method, url, headers, bodyPreview, bodyBytes, removedHeaders, warnings };
}

export async function replayHttpRequest(session: HttpSession, options: ReplayRequestOptions = {}): Promise<ReplayResult> {
  const plan = buildReplayRequest(session, options);
  if (options.dryRun ?? false) {
    return { executed: false, plan, warning: "Dry run only; no request was sent." };
  }

  const started = Date.now();
  const guardError = await validateReplayExecutionTarget(plan.url, options);
  if (guardError) {
    return blockedReplayResult(plan, started, guardError);
  }

  const timeoutMs = clampInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS);
  const maxResponseBytes = clampInteger(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, 0, MAX_RESPONSE_BYTES);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const body = requestBodyFor(plan.method, options.bodyOverride ?? session.requestBody);
    const response = await fetchWithValidatedRedirects(plan.url, {
      method: plan.method,
      headers: plan.headers,
      body,
      signal: controller.signal,
    }, options);
    const { bodyText, truncated } = await readLimitedResponseBody(response, maxResponseBytes);
    return {
      executed: true,
      plan,
      response: {
        status: response.status,
        statusText: response.statusText,
        headers: headersFromResponse(response.headers),
        body: bodyText,
        bodyTruncated: truncated,
        durationMs: Date.now() - started,
      },
    };
  } catch (error) {
    return {
      executed: true,
      plan,
      response: {
        headers: {},
        body: "",
        bodyTruncated: false,
        durationMs: Date.now() - started,
        error: formatReplayError(error),
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeMethod(method: string | undefined): string {
  const normalized = (method?.trim() || "GET").toUpperCase();
  if (!isValidHttpToken(normalized)) {
    throw new Error(`Invalid HTTP method for replay: ${method ?? ""}`);
  }
  return normalized;
}

function normalizeUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Request replay only supports absolute http(s) URLs.");
  }
  if (parsed.username || parsed.password) {
    parsed.username = "";
    parsed.password = "";
  }
  return parsed.toString();
}

function normalizeHeaderName(name: string): string {
  return name.replace(/[\r\n]/g, "").trim();
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function isValidHttpToken(value: string): boolean {
  return HTTP_TOKEN_PATTERN.test(value);
}

function isSensitiveHeader(lowerName: string): boolean {
  return SENSITIVE_HEADERS.has(lowerName)
    || lowerName.includes("token")
    || lowerName.includes("secret")
    || lowerName.includes("password")
    || lowerName.includes("api-key")
    || lowerName.includes("apikey");
}

function parseConnectionHeaderNames(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function removeHeader(headers: HeaderMap, removedHeaders: Array<{ name: string; reason: string }>, name: string, reason: string): void {
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) {
      delete headers[key];
      removedHeaders.push({ name: key, reason });
    }
  }
}

function requestBodyFor(method: string, body: string | undefined): string | undefined {
  if (method === "GET" || method === "HEAD") return undefined;
  return body;
}

async function fetchWithValidatedRedirects(
  initialUrl: string,
  init: { method: string; headers: HeaderMap; body?: string; signal: AbortSignal },
  options: ReplayRequestOptions,
): Promise<Response> {
  let currentUrl = initialUrl;
  let method = init.method;
  let body = init.body;

  for (let redirects = 0; ; redirects += 1) {
    const guardError = await validateReplayTargetUrl(currentUrl, options);
    if (guardError) throw new Error(guardError);

    const response = await fetch(currentUrl, {
      method,
      headers: init.headers,
      body,
      redirect: "manual",
      signal: init.signal,
    });

    if (!options.followRedirects || !isRedirectResponse(response)) return response;
    if (redirects >= MAX_REDIRECTS) throw new Error(`Redirect limit exceeded (${MAX_REDIRECTS}).`);

    const location = response.headers.get("location");
    if (!location) return response;

    const nextUrl = new URL(location, currentUrl).toString();
    const redirectGuardError = await validateReplayTargetUrl(nextUrl, options);
    if (redirectGuardError) throw new Error(redirectGuardError);

    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
    }
    currentUrl = nextUrl;
  }
}

function isRedirectResponse(response: Response): boolean {
  return REDIRECT_STATUSES.has(response.status);
}

async function readLimitedResponseBody(response: Response, maxBytes: number): Promise<{ bodyText: string; truncated: boolean }> {
  if (!response.body) return { bodyText: "", truncated: false };
  if (maxBytes === 0) {
    await response.body.cancel();
    return { bodyText: "", truncated: true };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const remaining = maxBytes - total;
    if (remaining <= 0) {
      truncated = true;
      await reader.cancel();
      break;
    }
    if (value.byteLength > remaining) {
      chunks.push(value.slice(0, remaining));
      total += remaining;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }

  return {
    bodyText: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8"),
    truncated,
  };
}

async function validateReplayExecutionTarget(url: string, options: ReplayRequestOptions): Promise<string | undefined> {
  if (!options.urlOverride && !options.allowOriginalUrl) {
    return "Replay execution blocked: provide urlOverride or pass allowOriginalUrl=true to replay the captured original URL.";
  }
  return await validateReplayTargetUrl(url, options);
}

async function validateReplayTargetUrl(url: string, options: ReplayRequestOptions): Promise<string | undefined> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `Replay execution blocked: invalid target URL ${url}.`;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "Replay execution blocked: only http(s) targets are supported.";
  }

  if (options.allowPrivateNetwork) return undefined;

  const hostname = normalizeHostname(parsed.hostname);
  if (isNonPublicHostname(hostname)) {
    return `Replay execution blocked: target host ${hostname} is localhost, private, link-local, or reserved. Pass allowPrivateNetwork=true for local test services.`;
  }

  try {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    for (const address of addresses) {
      if (isNonPublicIp(address.address)) {
        return `Replay execution blocked: target host ${hostname} resolves to non-public address ${address.address}. Pass allowPrivateNetwork=true for approved local or private targets.`;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Replay execution blocked: could not validate target host ${hostname}: ${message}`;
  }

  return undefined;
}

function blockedReplayResult(plan: ReplayRequestPlan, started: number, error: string): ReplayResult {
  return {
    executed: false,
    plan,
    warning: error,
    response: {
      headers: {},
      body: "",
      bodyTruncated: false,
      durationMs: Date.now() - started,
      error,
    },
  };
}

function hostnameFor(url: string): string | undefined {
  try {
    return normalizeHostname(new URL(url).hostname);
  } catch {
    return undefined;
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
}

function isNonPublicHostname(hostname: string): boolean {
  if (!hostname) return true;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname.endsWith(".local") || hostname.endsWith(".test") || hostname.endsWith(".invalid")) return true;
  return isNonPublicIp(hostname);
}

function isNonPublicIp(address: string): boolean {
  const normalized = address.toLowerCase().split("%", 1)[0] ?? address.toLowerCase();
  const ipv4Mapped = normalized.includes(":") && normalized.includes(".") ? normalized.slice(normalized.lastIndexOf(":") + 1) : undefined;
  if (ipv4Mapped && isIP(ipv4Mapped) === 4) return isNonPublicIpv4(ipv4Mapped);

  const version = isIP(normalized);
  if (version === 4) return isNonPublicIpv4(normalized);
  if (version === 6) return isNonPublicIpv6(normalized);
  return false;
}

function isNonPublicIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [first, second, third] = parts;

  if (first === 0 || first === 10 || first === 127) return true;
  if (first === 100 && second >= 64 && second <= 127) return true;
  if (first === 169 && second === 254) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  if (first === 192 && second === 0 && third === 0) return true;
  if (first === 192 && second === 0 && third === 2) return true;
  if (first === 198 && (second === 18 || second === 19)) return true;
  if (first === 198 && second === 51 && third === 100) return true;
  if (first === 203 && second === 0 && third === 113) return true;
  if (first >= 224) return true;
  return false;
}

function isNonPublicIpv6(address: string): boolean {
  if (address === "::" || address === "::1") return true;
  if (address.startsWith("fc") || address.startsWith("fd")) return true;
  if (address.startsWith("fe8") || address.startsWith("fe9") || address.startsWith("fea") || address.startsWith("feb")) return true;
  if (address.startsWith("ff")) return true;
  return false;
}

function headersFromResponse(headers: Headers): HeaderMap {
  const result: HeaderMap = {};
  headers.forEach((value, name) => {
    result[name] = value;
  });
  return result;
}

function truncateUtf8(value: string, limitBytes: number): { text: string; truncated: boolean } {
  const totalBytes = Buffer.byteLength(value, "utf8");
  if (totalBytes <= limitBytes) return { text: value, truncated: false };
  if (limitBytes <= 0) return { text: "", truncated: totalBytes > 0 };
  const parts: string[] = [];
  let usedBytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (usedBytes + characterBytes > limitBytes) break;
    parts.push(character);
    usedBytes += characterBytes;
  }
  return { text: parts.join(""), truncated: true };
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function formatReplayError(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "Request timed out.";
  return error instanceof Error ? error.message : String(error);
}
