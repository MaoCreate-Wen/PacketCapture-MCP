# Repository Guidelines

## Project Structure & Module Organization

PacketCapture-MCP is a TypeScript/Node.js MCP server for importing, browsing, analyzing, and reporting on HTTP capture data. Source lives in `src/`; compiled output is emitted to `dist/` and should not be edited directly. Key modules include `src/index.ts` for MCP tool registration, `src/parsers.ts` for HAR/JSON/cURL import, `src/analyzer.ts` for findings, `src/report.ts` for Markdown output, and `src/store.ts` for process-local capture storage. `examples/` contains validation fixtures such as `sample.har` and `smoke-test.mjs`. `scripts/` is reserved for generated or support scripts such as the Reqable bridge.

## Build, Test, and Development Commands

- `npm install`: install dependencies; Node.js 20 or newer is required.
- `npm run dev`: run the MCP server from `src/index.ts` with `tsx`.
- `npm run check`: type-check with `tsc --noEmit`.
- `npm run build`: compile TypeScript into `dist/`.
- `npm start`: run the built server from `dist/index.js`.
- `npm run build && node examples/smoke-test.mjs`: build and run the current smoke test against `examples/sample.har`.

## Coding Style & Naming Conventions

Use strict TypeScript with ESM and `NodeNext` imports. Keep imports explicit and include `.js` extensions for local runtime imports, matching the existing files. Use two-space indentation, `camelCase` for functions and variables, `PascalCase` for exported types, and descriptive MCP tool names in `snake_case`. Prefer small pure helpers in domain modules and keep tool wiring in `src/index.ts`.

## Testing Guidelines

There is no configured test runner or coverage threshold yet. Treat `npm run check` plus the smoke test as the minimum validation before submitting changes. Add new fixtures under `examples/` when changing parsers or analysis rules, and name executable checks clearly, for example `examples/<feature>-smoke-test.mjs`.

## Commit & Pull Request Guidelines

This repository currently has no Git commit history, so no established commit convention exists. Use concise imperative commit subjects such as `Add Reqable inbox status tool` or `Fix HAR response body parsing`. Pull requests should include a short behavior summary, validation commands run, linked issues when available, and sample output or screenshots only when user-visible MCP responses change.

## Security & Configuration Tips

Do not commit packet captures containing secrets, production tokens, or private user data. Keep `.env` files local; `.env.example` may be committed for safe defaults. Reqable inbox paths can be overridden with `REQABLE_MCP_INBOX` and `REQABLE_MCP_EVENTS_FILE`; document any new environment variables near the code that reads them.
