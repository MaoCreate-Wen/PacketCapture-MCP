import { headerValue } from "./parsers.js";
import type { CaptureAnalysis, CaptureDataset, Finding, FindingSeverity, HeaderMap, HttpSession } from "./types.js";

const SENSITIVE_HEADER_RE =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-session-token|x-csrf-token|x-xsrf-token|x-amz-security-token)$/i;
const SECRET_NAME_RE =
  /(password|passwd|pwd|passcode|token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|secret|client[_-]?secret|session|jwt|credential|authorization|auth|bearer|private[_-]?key)/i;
const SENSITIVE_ENDPOINT_RE = /\/(?:auth|login|logout|token|oauth|session|account|profile|user|users|me|password|billing|payment|checkout)(?:\/|$)/i;
const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
const PRIVATE_KEY_RE = /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/i;
const AWS_ACCESS_KEY_RE = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/;
const GITHUB_TOKEN_RE = /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{30,}\b/;
const GOOGLE_API_KEY_RE = /\bAIza[0-9A-Za-z_-]{35}\b/;
const SLACK_TOKEN_RE = /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/i;
const STRIPE_SECRET_RE = /\b(?:sk_live|rk_live)_[0-9A-Za-z]{16,}\b/;
const BEARER_TOKEN_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/i;
const SECRET_FIELD_RE =
  /["']?([A-Za-z0-9_.-]*(?:password|passwd|pwd|passcode|token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|secret|client[_-]?secret|session|jwt|credential|authorization|auth|bearer|private[_-]?key)[A-Za-z0-9_.-]*)["']?\s*[:=]\s*["']?([^"'&\s,}]{6,})/gi;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_RE = /(?:\+?\d{1,3}[-\s]?)?(?:\d[-\s]?){10,13}\d/;
const STACK_TRACE_RE =
  /(Traceback \(most recent call last\):|(?:^|\n)\s*at\s+[\w.$<>]+\(.+:\d+(?::\d+)?\)|\b(?:TypeError|ReferenceError|SyntaxError|RangeError):\s|(?:java\.lang\.)?\w+Exception\b|Caused by:|System\.\w+Exception|Stack trace:|StackTrace|Fatal error:)/i;
const SQL_ERROR_RE = /\b(SQL syntax|PSQLException|SQLiteException|SQLException|ORA-\d{4,}|SQLSTATE|mysql_fetch|ODBC Driver)\b/i;
const HTTP_SUBRESOURCE_RE = /\b(?:src|href|action)\s*=\s*["']http:\/\/[^"']+/i;

const MAX_BODY_FINDINGS_PER_SESSION = 8;
const MAX_HEADER_FINDINGS_PER_DIRECTION = 6;
const MAX_URL_FINDINGS_PER_SESSION = 6;
const SLOW_ENDPOINT_MS = 3000;
const VERY_SLOW_ENDPOINT_MS = 10000;
const LARGE_REQUEST_BYTES = 1024 * 1024;
const LARGE_RESPONSE_BYTES = 2 * 1024 * 1024;
const VERY_LARGE_RESPONSE_BYTES = 5 * 1024 * 1024;

type UnknownRecord = Record<string, unknown>;

interface AnalyzerState {
  emittedRuleKeys: Set<string>;
}

export function analyzeCapture(capture: CaptureDataset): CaptureAnalysis {
  const methods: Record<string, number> = {};
  const statusClasses: Record<string, number> = {};
  const contentTypes: Record<string, number> = {};
  const hostCounts = new Map<string, number>();
  const durations: number[] = [];
  let totalRequestBytes = 0;
  let totalResponseBytes = 0;
  const findings: Finding[] = [];
  const state: AnalyzerState = { emittedRuleKeys: new Set() };

  for (const session of capture.sessions) {
    increment(methods, session.method || "UNKNOWN");
    increment(statusClasses, statusClass(session.status));

    const host = session.host || "<unknown>";
    hostCounts.set(host, (hostCounts.get(host) ?? 0) + 1);

    const contentType = normalizeContentType(
      session.responseContentType ||
        session.requestContentType ||
        headerValue(session.responseHeaders, "content-type") ||
        headerValue(session.requestHeaders, "content-type"),
    );
    if (contentType) increment(contentTypes, contentType);

    if (session.durationMs !== undefined) durations.push(session.durationMs);
    totalRequestBytes += session.requestSizeBytes ?? byteLength(session.requestBody);
    totalResponseBytes += session.responseSizeBytes ?? byteLength(session.responseBody);

    findings.push(...analyzeSession(session, state));
  }

  const slowestSessions = capture.sessions
    .filter((session) => session.durationMs !== undefined)
    .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
    .slice(0, 10)
    .map((session) => ({
      sessionId: session.id,
      method: session.method,
      url: session.url,
      durationMs: session.durationMs ?? 0,
      status: session.status,
    }));

  const largestResponses = capture.sessions
    .filter((session) => (session.responseSizeBytes ?? byteLength(session.responseBody)) > 0)
    .sort((a, b) => (b.responseSizeBytes ?? byteLength(b.responseBody)) - (a.responseSizeBytes ?? byteLength(a.responseBody)))
    .slice(0, 10)
    .map((session) => ({
      sessionId: session.id,
      method: session.method,
      url: session.url,
      responseSizeBytes: session.responseSizeBytes ?? byteLength(session.responseBody),
      status: session.status,
    }));

  return {
    captureId: capture.id,
    summary: {
      totalSessions: capture.sessions.length,
      hosts: hostCounts.size,
      methods: sortRecord(methods),
      statusClasses: sortRecord(statusClasses),
      contentTypes: sortRecord(contentTypes),
      totalRequestBytes,
      totalResponseBytes,
      averageDurationMs: durations.length > 0 ? Math.round(durations.reduce((sum, item) => sum + item, 0) / durations.length) : undefined,
    },
    topHosts: Array.from(hostCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([host, count]) => ({ host, count })),
    slowestSessions,
    largestResponses,
    findings: sortFindings(dedupeFindings(findings)),
  };
}

function analyzeSession(session: HttpSession, state: AnalyzerState): Finding[] {
  const findings: Finding[] = [];

  findings.push(...analyzeTransport(session));
  findings.push(...analyzeStatus(session));
  findings.push(...analyzePerformance(session));
  findings.push(...analyzePayloadSizes(session));
  findings.push(...analyzeSecurityHeaders(session, state));
  findings.push(...analyzeCors(session, state));
  findings.push(...analyzeCacheableSensitiveResponse(session));
  findings.push(...analyzeHeaders(session, "request", session.requestHeaders));
  findings.push(...analyzeHeaders(session, "response", session.responseHeaders));
  findings.push(...analyzeUrl(session));
  findings.push(...analyzeCookies(session, state));

  const bodyFindings = [
    ...analyzeJsonErrorLeakage(session),
    ...analyzeMixedContentBody(session),
    ...analyzeBody(session, "request", session.requestBody),
    ...analyzeBody(session, "response", session.responseBody),
  ].slice(0, MAX_BODY_FINDINGS_PER_SESSION);
  findings.push(...bodyFindings);

  return findings;
}

function analyzeTransport(session: HttpSession): Finding[] {
  const findings: Finding[] = [];
  if (session.scheme !== "http") return findings;

  findings.push(
    finding(
      "high",
      "transport",
      "Cleartext HTTP request",
      `${session.method} ${session.url}`,
      "Use HTTPS for all authenticated, personal-data, and API traffic; block cleartext transport in clients where possible.",
      session.id,
    ),
  );

  const source = headerValue(session.requestHeaders, "referer") || headerValue(session.requestHeaders, "origin");
  if (source?.toLowerCase().startsWith("https://")) {
    findings.push(
      finding(
        "high",
        "transport",
        "HTTPS page loaded HTTP resource",
        `${redactLong(source)} -> ${session.method} ${session.url}`,
        "Serve subresources over HTTPS and update page references. Validate dependencies before enabling automatic upgrade policies.",
        session.id,
      ),
    );
  }

  return findings;
}

function analyzeStatus(session: HttpSession): Finding[] {
  if (session.status === undefined) return [];

  if (session.status >= 500) {
    return [
      finding(
        "medium",
        "availability",
        "Server error response",
        `${session.status} ${session.method} ${session.url}`,
        "Inspect server logs, upstream dependencies, and retry behavior; prioritize high-frequency 5xx endpoints.",
        session.id,
      ),
    ];
  }

  if (session.status >= 400) {
    return [
      finding(
        "low",
        "http",
        "Client or authorization error response",
        `${session.status} ${session.method} ${session.url}`,
        "Confirm request parameters, authentication state, authorization policy, and user-facing error handling.",
        session.id,
      ),
    ];
  }

  return [];
}

function analyzePerformance(session: HttpSession): Finding[] {
  const durationMs = session.durationMs ?? 0;
  if (durationMs >= VERY_SLOW_ENDPOINT_MS) {
    return [
      finding(
        "high",
        "performance",
        "Very slow endpoint",
        `${durationMs}ms ${session.method} ${session.url}`,
        "Profile server work, database queries, upstream calls, payload size, and timeout or retry behavior for this endpoint.",
        session.id,
      ),
    ];
  }

  if (durationMs >= SLOW_ENDPOINT_MS) {
    return [
      finding(
        "medium",
        "performance",
        "Slow endpoint",
        `${durationMs}ms ${session.method} ${session.url}`,
        "Review server latency, network path, request payload size, and response payload size.",
        session.id,
      ),
    ];
  }

  return [];
}

function analyzePayloadSizes(session: HttpSession): Finding[] {
  const findings: Finding[] = [];
  const requestSize = session.requestSizeBytes ?? byteLength(session.requestBody);
  const responseSize = session.responseSizeBytes ?? byteLength(session.responseBody);

  if (requestSize >= LARGE_REQUEST_BYTES) {
    findings.push(
      finding(
        "medium",
        "performance",
        "Oversized request payload",
        `${formatBytes(requestSize)} ${session.method} ${session.url}`,
        "Validate upload limits, compress where appropriate, and split or stream large client payloads.",
        session.id,
      ),
    );
  }

  if (responseSize >= VERY_LARGE_RESPONSE_BYTES) {
    findings.push(
      finding(
        "medium",
        "performance",
        "Very large response payload",
        `${formatBytes(responseSize)} ${session.method} ${session.url}`,
        "Reduce returned fields, paginate collections, compress responses, or switch to streaming for large downloads.",
        session.id,
      ),
    );
  } else if (responseSize >= LARGE_RESPONSE_BYTES) {
    findings.push(
      finding(
        "low",
        "performance",
        "Large response payload",
        `${formatBytes(responseSize)} ${session.method} ${session.url}`,
        "Consider pagination, compression, field trimming, or streaming to reduce latency and client memory use.",
        session.id,
      ),
    );
  }

  return findings;
}

function analyzeSecurityHeaders(session: HttpSession, state: AnalyzerState): Finding[] {
  if (!hasResponse(session) || !isSuccessfulResponse(session)) return [];

  const responseType = responseKind(session);
  if (!responseType) return [];

  const headers = session.responseHeaders;
  const missing: string[] = [];
  const csp = headerValue(headers, "content-security-policy");

  if (session.scheme === "https" && !headerValue(headers, "strict-transport-security")) {
    missing.push("Strict-Transport-Security");
  }

  const xContentTypeOptions = headerValue(headers, "x-content-type-options");
  if (!xContentTypeOptions || !/\bnosniff\b/i.test(xContentTypeOptions)) {
    missing.push("X-Content-Type-Options=nosniff");
  }

  if (responseType === "html") {
    if (!csp) missing.push("Content-Security-Policy");
    if (!headerValue(headers, "referrer-policy")) missing.push("Referrer-Policy");
    if (!headerValue(headers, "x-frame-options") && !/\bframe-ancestors\b/i.test(csp ?? "")) {
      missing.push("X-Frame-Options or CSP frame-ancestors");
    }
  }

  if (missing.length === 0) return [];

  const key = `security-headers:${session.host ?? "<unknown>"}:${responseType}`;
  return emitOnce(state, key, () =>
    finding(
      responseType === "html" ? "medium" : "low",
      "security_headers",
      `${responseType === "html" ? "HTML" : "API"} response missing security headers`,
      `missing: ${missing.join(", ")}; example: ${session.method} ${session.url}`,
      "Add response hardening headers at the edge or application layer and verify them on representative HTML and API responses.",
      session.id,
    ),
  );
}

function analyzeCors(session: HttpSession, state: AnalyzerState): Finding[] {
  const allowOrigin = headerValue(session.responseHeaders, "access-control-allow-origin")?.trim();
  if (!allowOrigin) return [];

  const allowCredentials = /^true$/i.test(headerValue(session.responseHeaders, "access-control-allow-credentials")?.trim() ?? "");
  if (!allowCredentials) return [];

  if (allowOrigin === "*" || /^null$/i.test(allowOrigin)) {
    const key = `cors-credentials:${session.host ?? "<unknown>"}:${allowOrigin.toLowerCase()}`;
    return emitOnce(state, key, () =>
      finding(
        "high",
        "cors",
        "Permissive CORS with credentials",
        `Access-Control-Allow-Origin: ${allowOrigin}; Access-Control-Allow-Credentials: true; ${session.method} ${session.url}`,
        "Do not combine credentialed CORS with wildcard or null origins. Return only explicit trusted origins and reject all others.",
        session.id,
      ),
    );
  }

  const requestOrigin = headerValue(session.requestHeaders, "origin")?.trim();
  const vary = headerValue(session.responseHeaders, "vary") ?? "";
  if (requestOrigin && sameOriginText(allowOrigin, requestOrigin) && !/\borigin\b/i.test(vary)) {
    const key = `cors-reflection:${session.host ?? "<unknown>"}:${allowOrigin.toLowerCase()}`;
    return emitOnce(state, key, () =>
      finding(
        "medium",
        "cors",
        "Credentialed CORS response lacks Vary Origin",
        `Origin: ${requestOrigin}; Access-Control-Allow-Origin: ${allowOrigin}; Vary: ${vary || "<missing>"}`,
        "When reflecting trusted origins, include Vary: Origin and enforce a server-side allowlist before setting credentialed CORS headers.",
        session.id,
      ),
    );
  }

  return [];
}

function analyzeCacheableSensitiveResponse(session: HttpSession): Finding[] {
  if (!hasResponse(session) || !isSuccessfulResponse(session)) return [];

  const sensitivity = responseSensitivityReasons(session);
  if (sensitivity.length === 0) return [];

  const cacheState = cacheableState(session.responseHeaders);
  if (!cacheState) return [];

  const severity: FindingSeverity = /public|s-maxage|max-age|Expires/i.test(cacheState) ? "high" : "medium";
  return [
    finding(
      severity,
      "cache",
      "Sensitive response may be cacheable",
      `${sensitivity.join(", ")}; ${cacheState}; ${session.method} ${session.url}`,
      "Use Cache-Control: no-store for token, account, and personal-data responses; avoid shared-cache directives for sensitive content.",
      session.id,
    ),
  ];
}

function analyzeHeaders(session: HttpSession, direction: "request" | "response", headers: HeaderMap): Finding[] {
  const findings: Finding[] = [];

  for (const [name, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADER_RE.test(name) || SECRET_NAME_RE.test(name)) {
      findings.push(
        finding(
          "medium",
          "secret",
          `Sensitive ${direction} header captured`,
          `${name}: ${redact(value)}`,
          "Avoid storing complete sensitive headers in reports, logs, or shared captures; verify transport, storage, and redaction controls.",
          session.id,
        ),
      );
    }

    for (const detected of detectSecretPatterns(value)) {
      findings.push(
        finding(
          detected.severity,
          "secret",
          `${direction === "request" ? "Request" : "Response"} header contains secret-like value`,
          `${name}: ${snippet(value, detected.pattern)}`,
          "Treat the captured value as exposed until proven otherwise; rotate live secrets and redact them from stored captures and logs.",
          session.id,
        ),
      );
    }

    if (findings.length >= MAX_HEADER_FINDINGS_PER_DIRECTION) break;
  }

  return findings;
}

function analyzeBody(session: HttpSession, direction: "request" | "response", body?: string): Finding[] {
  if (!body) return [];

  const findings: Finding[] = [];
  const evidencePrefix = direction === "request" ? "Request body" : "Response body";

  for (const detected of detectSecretPatterns(body)) {
    findings.push(
      finding(
        detected.severity,
        "secret",
        `${evidencePrefix} contains ${detected.label}`,
        snippet(body, detected.pattern),
        "Treat exposed credentials as compromised until validated; rotate live secrets and remove them from API payloads and logs.",
        session.id,
      ),
    );
  }

  for (const match of body.matchAll(SECRET_FIELD_RE)) {
    findings.push(
      finding(
        "high",
        "secret",
        `${evidencePrefix} contains secret-like field`,
        `${match[1]}=${redact(match[2] ?? "")}`,
        "Confirm the field must be transmitted. Redact passwords, API keys, and tokens, and minimize credential scope and lifetime.",
        session.id,
      ),
    );
    if (findings.length >= MAX_BODY_FINDINGS_PER_SESSION) return findings;
  }

  if (direction === "response" && EMAIL_RE.test(body)) {
    findings.push(
      finding(
        "low",
        "privacy",
        "Response body contains email address",
        snippet(body, EMAIL_RE),
        "Verify that personal data in the response is necessary, minimized, authorized, and not cached unnecessarily.",
        session.id,
      ),
    );
  }

  if (direction === "response" && PHONE_RE.test(body)) {
    findings.push(
      finding(
        "low",
        "privacy",
        "Response body contains phone-like number",
        snippet(body, PHONE_RE),
        "Verify that personal data in the response is necessary, minimized, authorized, and not cached unnecessarily.",
        session.id,
      ),
    );
  }

  return findings.slice(0, MAX_BODY_FINDINGS_PER_SESSION);
}

function analyzeJsonErrorLeakage(session: HttpSession): Finding[] {
  const body = session.responseBody;
  if (!body || !isJsonResponse(session)) return [];

  const leakage: string[] = [];
  const parsed = parseJsonObject(body);
  if (parsed && containsSensitiveErrorKey(parsed)) leakage.push("debug error fields");
  if (STACK_TRACE_RE.test(body)) leakage.push("stack trace");
  if (SQL_ERROR_RE.test(body)) leakage.push("database error detail");

  if (leakage.length === 0) return [];

  const severity: FindingSeverity = session.status !== undefined && session.status >= 500 ? "high" : "medium";
  return [
    finding(
      severity,
      "error_handling",
      "JSON error response leaks implementation details",
      `${session.status ?? "-"} ${session.method} ${session.url}; ${unique(leakage).join(", ")}; ${snippet(body, STACK_TRACE_RE.test(body) ? STACK_TRACE_RE : SQL_ERROR_RE)}`,
      "Return stable client-safe error codes and messages. Keep stack traces, SQL errors, file paths, and debug fields in server-side logs only.",
      session.id,
    ),
  ];
}

function analyzeMixedContentBody(session: HttpSession): Finding[] {
  const body = session.responseBody;
  if (!body || session.scheme !== "https" || !isHtmlResponse(session) || !HTTP_SUBRESOURCE_RE.test(body)) return [];

  return [
    finding(
      "medium",
      "transport",
      "HTML response references HTTP subresources",
      snippet(body, HTTP_SUBRESOURCE_RE),
      "Replace HTTP subresource URLs with HTTPS URLs and validate scripts, styles, images, forms, and redirects.",
      session.id,
    ),
  ];
}

function analyzeUrl(session: HttpSession): Finding[] {
  const findings: Finding[] = [];
  let parsed: URL;
  try {
    parsed = new URL(session.url);
  } catch {
    return findings;
  }

  if (parsed.username || parsed.password) {
    findings.push(
      finding(
        "high",
        "secret",
        "URL contains embedded credentials",
        `${parsed.protocol}//${redact(parsed.username)}:${redact(parsed.password)}@${parsed.host}${parsed.pathname}`,
        "Do not place credentials in URLs. Use Authorization headers or short-lived exchange flows and ensure URL logs are redacted.",
        session.id,
      ),
    );
  }

  for (const [name, value] of parsed.searchParams.entries()) {
    if (value && SECRET_NAME_RE.test(name)) {
      findings.push(
        finding(
          "high",
          "secret",
          "URL query parameter contains secret-like value",
          `${name}=${redact(value)}`,
          "Do not put tokens, passwords, or API keys in URLs. Use request bodies or Authorization headers and redact URL logs.",
          session.id,
        ),
      );
    }

    for (const detected of detectSecretPatterns(value)) {
      findings.push(
        finding(
          detected.severity,
          "secret",
          "URL query parameter contains recognizable secret",
          `${name}=${snippet(value, detected.pattern)}`,
          "Move secrets out of URLs and rotate any live credential that appeared in captured query strings.",
          session.id,
        ),
      );
    }

    if (findings.length >= MAX_URL_FINDINGS_PER_SESSION) break;
  }

  return findings;
}

function analyzeCookies(session: HttpSession, state: AnalyzerState): Finding[] {
  const setCookie = headerValue(session.responseHeaders, "set-cookie");
  if (!setCookie) return [];

  const problems: string[] = [];
  for (const cookie of parseSetCookie(setCookie)) {
    const missing: string[] = [];
    const sameSite = cookie.attributes.get("samesite")?.toLowerCase();
    const sensitive = isSensitiveCookieName(cookie.name);

    if (!cookie.attributes.has("secure") && (session.scheme === "https" || sameSite === "none")) {
      missing.push("Secure");
    }
    if (sensitive && !cookie.attributes.has("httponly") && !isCsrfCookieName(cookie.name)) {
      missing.push("HttpOnly");
    }
    if (sensitive && !sameSite) {
      missing.push("SameSite");
    }
    if (sameSite === "none" && !cookie.attributes.has("secure")) {
      missing.push("Secure required with SameSite=None");
    }

    if (missing.length > 0) {
      problems.push(`${cookie.name}: ${unique(missing).join(", ")}`);
    }
  }

  if (problems.length === 0) return [];

  const evidence = problems.slice(0, 5).join("; ");
  const key = `cookie-flags:${session.host ?? "<unknown>"}:${evidence}`;
  return emitOnce(state, key, () =>
    finding(
      "medium",
      "cookie",
      "Cookie flags are missing",
      evidence,
      "Set Secure, HttpOnly, and SameSite on session or authentication cookies. Use SameSite=None only when Secure is also set.",
      session.id,
    ),
  );
}

function responseKind(session: HttpSession): "html" | "api" | undefined {
  if (isHtmlResponse(session)) return "html";
  if (isApiResponse(session)) return "api";
  return undefined;
}

function isHtmlResponse(session: HttpSession): boolean {
  const contentType = responseContentType(session);
  return /\btext\/html\b|\bapplication\/xhtml\+xml\b/i.test(contentType ?? "");
}

function isJsonResponse(session: HttpSession): boolean {
  const contentType = responseContentType(session);
  if (/\bjson\b/i.test(contentType ?? "")) return true;
  const body = session.responseBody?.trim();
  return Boolean(body && (body.startsWith("{") || body.startsWith("[")));
}

function isApiResponse(session: HttpSession): boolean {
  if (isJsonResponse(session)) return true;
  if (SENSITIVE_ENDPOINT_RE.test(session.path ?? "")) return true;
  const accept = headerValue(session.requestHeaders, "accept") ?? "";
  return /\bapplication\/(?:[\w.+-]+\+)?json\b/i.test(accept);
}

function responseContentType(session: HttpSession): string | undefined {
  return normalizeContentType(session.responseContentType || headerValue(session.responseHeaders, "content-type"));
}

function hasResponse(session: HttpSession): boolean {
  return (
    session.status !== undefined ||
    Object.keys(session.responseHeaders).length > 0 ||
    session.responseBody !== undefined ||
    session.responseContentType !== undefined
  );
}

function isSuccessfulResponse(session: HttpSession): boolean {
  return session.status === undefined || (session.status >= 200 && session.status < 400);
}

function responseSensitivityReasons(session: HttpSession): string[] {
  const reasons: string[] = [];
  const path = session.path ?? safePath(session.url);

  if (SENSITIVE_ENDPOINT_RE.test(path)) reasons.push("sensitive endpoint");
  if (headerValue(session.responseHeaders, "set-cookie")) reasons.push("sets cookie");

  const body = session.responseBody ?? "";
  if (detectSecretPatterns(body).length > 0 || SECRET_FIELD_RE.test(body)) reasons.push("secret-like response body");
  SECRET_FIELD_RE.lastIndex = 0;
  if (EMAIL_RE.test(body) || PHONE_RE.test(body)) reasons.push("personal data in response body");

  return unique(reasons).slice(0, 3);
}

function cacheableState(headers: HeaderMap): string | undefined {
  const cacheControl = headerValue(headers, "cache-control");
  const pragma = headerValue(headers, "pragma");
  const expires = headerValue(headers, "expires");

  if (/\bno-store\b|\bno-cache\b|\bprivate\b/i.test(cacheControl ?? "") || /\bno-cache\b/i.test(pragma ?? "")) {
    return undefined;
  }

  if (!cacheControl) return "Cache-Control: <missing>";
  if (/\bpublic\b/i.test(cacheControl)) return `Cache-Control: ${cacheControl}`;

  const sharedMaxAge = numericDirective(cacheControl, "s-maxage");
  if (sharedMaxAge !== undefined && sharedMaxAge > 0) return `Cache-Control: ${cacheControl}`;

  const maxAge = numericDirective(cacheControl, "max-age");
  if (maxAge !== undefined && maxAge > 0) return `Cache-Control: ${cacheControl}`;

  if (expires && !isExpired(expires)) return `Expires: ${expires}`;
  return undefined;
}

function numericDirective(cacheControl: string, name: string): number | undefined {
  const match = new RegExp(`(?:^|,)\\s*${name}\\s*=\\s*(\\d+)`, "i").exec(cacheControl);
  if (!match?.[1]) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function isExpired(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= Date.now();
}

function detectSecretPatterns(value: string): Array<{ label: string; pattern: RegExp; severity: FindingSeverity }> {
  const patterns: Array<{ label: string; pattern: RegExp; severity: FindingSeverity }> = [
    { label: "private key", pattern: PRIVATE_KEY_RE, severity: "critical" },
    { label: "JWT", pattern: JWT_RE, severity: "high" },
    { label: "AWS access key", pattern: AWS_ACCESS_KEY_RE, severity: "high" },
    { label: "GitHub token", pattern: GITHUB_TOKEN_RE, severity: "high" },
    { label: "Google API key", pattern: GOOGLE_API_KEY_RE, severity: "high" },
    { label: "Slack token", pattern: SLACK_TOKEN_RE, severity: "high" },
    { label: "Stripe live secret", pattern: STRIPE_SECRET_RE, severity: "high" },
    { label: "Bearer token", pattern: BEARER_TOKEN_RE, severity: "high" },
  ];

  return patterns.filter((item) => item.pattern.test(value));
}

interface CookieInfo {
  name: string;
  attributes: Map<string, string>;
}

function parseSetCookie(value: string): CookieInfo[] {
  return value
    .split(/,(?=\s*[^;,=\s]+=)/)
    .flatMap((cookieText) => {
      const parts = cookieText
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean);
      const [nameValue, ...attributeParts] = parts;
      if (!nameValue) return [];

      const equalsIndex = nameValue.indexOf("=");
      if (equalsIndex <= 0) return [];

      const attributes = new Map<string, string>();
      for (const attribute of attributeParts) {
        const index = attribute.indexOf("=");
        if (index === -1) {
          attributes.set(attribute.toLowerCase(), "");
        } else {
          attributes.set(attribute.slice(0, index).trim().toLowerCase(), attribute.slice(index + 1).trim());
        }
      }

      return [{ name: nameValue.slice(0, equalsIndex).trim(), attributes }];
    });
}

function isSensitiveCookieName(name: string): boolean {
  return /^(?:sid|session|sessionid|jsessionid|phpsessid|connect\.sid|auth|token|jwt|sso|remember|id_token)$/i.test(name)
    || /(?:^|[_-])(sid|session|auth|token|jwt|access|refresh|login|sso|remember)(?:$|[_-])/i.test(name);
}

function isCsrfCookieName(name: string): boolean {
  return /(?:csrf|xsrf)/i.test(name);
}

function parseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function containsSensitiveErrorKey(value: unknown, depth = 0): boolean {
  if (depth > 5 || value === null || value === undefined) return false;

  if (Array.isArray(value)) {
    return value.some((item) => containsSensitiveErrorKey(item, depth + 1));
  }

  if (!isRecord(value)) return false;

  for (const [key, nested] of Object.entries(value)) {
    if (/^(stack|stacktrace|trace|exception|debug|file|line|sql|query)$/i.test(key)) return true;
    if (containsSensitiveErrorKey(nested, depth + 1)) return true;
  }

  return false;
}

function sameOriginText(a: string, b: string): boolean {
  try {
    return new URL(a).origin.toLowerCase() === new URL(b).origin.toLowerCase();
  } catch {
    return a.toLowerCase() === b.toLowerCase();
  }
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

function emitOnce(state: AnalyzerState, key: string, build: () => Finding): Finding[] {
  if (state.emittedRuleKeys.has(key)) return [];
  state.emittedRuleKeys.add(key);
  return [build()];
}

function finding(severity: FindingSeverity, category: string, title: string, evidence: string, recommendation: string, sessionId?: string): Finding {
  return { severity, category, title, evidence, recommendation, sessionId };
}

function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function statusClass(status?: number): string {
  if (status === undefined || status <= 0) return "unknown";
  return `${Math.floor(status / 100)}xx`;
}

function normalizeContentType(value?: string): string | undefined {
  return value?.split(";")[0]?.trim().toLowerCase() || undefined;
}

function byteLength(value?: string): number {
  return value ? Buffer.byteLength(value) : 0;
}

function sortRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((item) => {
    const key = `${item.sessionId}:${item.severity}:${item.category}:${item.title}:${item.evidence}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortFindings(findings: Finding[]): Finding[] {
  const order: Record<FindingSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity] || a.category.localeCompare(b.category));
}

function redact(value: string): string {
  if (!value) return "<redacted>";
  if (value.length <= 8) return "<redacted>";
  return `${value.slice(0, 4)}...${value.slice(-4)} (${value.length} chars)`;
}

function redactLong(value: string): string {
  if (value.length <= 160) return value;
  return `${value.slice(0, 120)}...${value.slice(-20)}`;
}

function snippet(value: string, pattern: RegExp): string {
  const flags = pattern.flags.replace(/g/g, "");
  const match = new RegExp(pattern.source, flags).exec(value);
  if (!match || match.index === undefined) return "<matched>";
  const start = Math.max(0, match.index - 20);
  const end = Math.min(value.length, match.index + match[0].length + 20);
  return redact(value.slice(start, end));
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value}B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)}KB`;
  return `${(value / 1024 / 1024).toFixed(1)}MB`;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
