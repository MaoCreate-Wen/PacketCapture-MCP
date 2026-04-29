import type { CaptureDataset } from "./types.js";

const captures = new Map<string, CaptureDataset>();

export function saveCapture(capture: CaptureDataset): CaptureDataset {
  captures.set(capture.id, capture);
  return capture;
}

export function getCapture(id: string): CaptureDataset {
  const capture = captures.get(id);
  if (!capture) {
    throw new Error(`Capture not found: ${id}`);
  }
  return capture;
}

export function listCaptures(): Array<Omit<CaptureDataset, "sessions">> {
  return Array.from(captures.values()).map(({ sessions: _sessions, ...capture }) => capture);
}

export function clearCapture(id?: string): { cleared: number } {
  if (id) {
    const existed = captures.delete(id);
    return { cleared: existed ? 1 : 0 };
  }

  const count = captures.size;
  captures.clear();
  return { cleared: count };
}
