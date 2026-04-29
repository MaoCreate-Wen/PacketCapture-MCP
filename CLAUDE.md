# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

PacketCapture-MCP is a TypeScript/Node.js MCP server for importing and analyzing HTTP packet capture exports. It runs over stdio and exposes MCP tools for Reqable inspection/bridge import, capture import, session browsing, analysis, reporting, and clearing in-memory datasets.

The project uses ESM with TypeScript `NodeNext` module resolution. Source is under `src/`; compiled output goes to `dist/`.

## Commands

- Install dependencies: `npm install`
- Type-check without emitting: `npm run check`
- Build: `npm run build`
- Run built MCP server: `npm start`
- Run MCP server in development with tsx: `npm run dev`
- Run the smoke test: `npm run build && node examples/smoke-test.mjs`

There is no configured test runner or `npm test` script. `examples/smoke-test.mjs` is the current executable validation path; it starts `dist/index.js`, lists tools, imports `examples/sample.har`, and runs `analyze_capture`.

## Architecture

- `src/index.ts` is the MCP entrypoint. It creates `McpServer`, registers tools, connects via `StdioServerTransport`, and formats MCP text/JSON responses.
- `src/types.ts` defines the shared domain model: `HttpSession`, `CaptureDataset`, `Finding`, and `CaptureAnalysis`.
- `src/parsers.ts` imports HAR 1.2, heuristic Reqable/common JSON, and cURL text into normalized `CaptureDataset` objects. It derives session IDs from SHA-1 hashes and truncates parsed body text at 256 KB.
- `src/reqableBridge.ts` handles the Reqable script bridge inbox. Defaults are `reqable-inbox/events.ndjson`, overridable with `REQABLE_MCP_INBOX` and `REQABLE_MCP_EVENTS_FILE`. It imports newline-delimited JSON events into `CaptureDataset` objects and can archive the active events file after import.
- `src/reqable.ts` only inspects a local Reqable install path for capability hints; it does not launch Reqable or assume an unpublished CLI.
- `src/store.ts` is an in-memory `Map` of captures. Captures are process-local and disappear when the MCP server restarts.
- `src/sessions.ts` provides listing, filtering, pagination, and session lookup helpers.
- `src/analyzer.ts` computes capture summaries and built-in findings for transport, status errors, performance, secrets, privacy indicators, URL parameters, and cookie attributes.
- `src/report.ts` renders Markdown reports from a capture plus analysis.

## MCP tool behavior notes

- Imported captures are stored only in memory. Tools that need a `captureId` operate on the current MCP process state.
- `get_session` excludes request/response bodies by default. When `includeBodies` is true, bodies are truncated by `bodyLimit` (default 8000, max 200000).
- `import_capture_file` reads local files as UTF-8 and supports `auto`, `har`, `json`, and `curl` formats.
- `import_reqable_inbox` reads bridge NDJSON from the configured inbox and optionally archives the active file.

## Current caveats

- `src/index.ts` should be checked with `npm run check` before further work; the `list_captures` registration area is important to preserve when editing tool registrations.
- `scripts/reqable-mcp-bridge.py` is referenced by bridge config as the expected script template path, but verify the file exists before documenting or relying on it.
