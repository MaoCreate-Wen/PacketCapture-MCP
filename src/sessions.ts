import type { HttpSession } from "./types.js";

export interface SessionListItem {
  id: string;
  index: number;
  method: string;
  url: string;
  host?: string;
  status?: number;
  durationMs?: number;
  requestContentType?: string;
  responseContentType?: string;
  responseSizeBytes?: number;
}

export function listSessionSummaries(sessions: HttpSession[], offset: number, limit: number): { total: number; offset: number; limit: number; sessions: SessionListItem[] } {
  const safeOffset = Math.max(0, offset);
  const safeLimit = Math.min(Math.max(1, limit), 200);
  return {
    total: sessions.length,
    offset: safeOffset,
    limit: safeLimit,
    sessions: sessions.slice(safeOffset, safeOffset + safeLimit).map((session) => ({
      id: session.id,
      index: session.sourceIndex,
      method: session.method,
      url: session.url,
      host: session.host,
      status: session.status,
      durationMs: session.durationMs,
      requestContentType: session.requestContentType,
      responseContentType: session.responseContentType,
      responseSizeBytes: session.responseSizeBytes,
    })),
  };
}

export function findSession(sessions: HttpSession[], sessionId: string): HttpSession {
  const session = sessions.find((item) => item.id === sessionId || String(item.sourceIndex) === sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  return session;
}

export function filterSessions(sessions: HttpSession[], options: { host?: string; method?: string; statusClass?: string; keyword?: string }): HttpSession[] {
  return sessions.filter((session) => {
    if (options.host && session.host !== options.host) return false;
    if (options.method && session.method !== options.method.toUpperCase()) return false;
    if (options.statusClass && statusClass(session.status) !== options.statusClass) return false;
    if (options.keyword) {
      const keyword = options.keyword.toLowerCase();
      const haystack = [session.url, session.requestBody, session.responseBody, JSON.stringify(session.requestHeaders), JSON.stringify(session.responseHeaders)]
        .filter(Boolean)
        .join("\n")
        .toLowerCase();
      if (!haystack.includes(keyword)) return false;
    }
    return true;
  });
}

function statusClass(status?: number): string {
  if (status === undefined || status <= 0) return "unknown";
  return `${Math.floor(status / 100)}xx`;
}
