# Transparency Proxy — Design

**Date:** 2026-07-07
**Status:** Approved (design supplied fully-formed by the user as a master build prompt; see `docs/master-build-prompt.md` for the authoritative spec. This doc records the concrete decisions made within it.)

## What it is

A demo for a "punk software" hack night. A local HTTP proxy sits between OpenAI Codex and the real OpenAI Responses API. Codex is pointed at the proxy via a custom `model_provider` in `~/.codex/config.toml` and cannot tell the difference. The proxy captures every request, forwards it byte-for-byte, streams the response back untouched, and renders the *hidden payload* — Codex's instruction block, tool schemas (shell access, file patching), full input, token count, and dollar cost — in a web inspector panel.

The demo beat: user types "hi", the panel shows the thousands of tokens, machine-access tools, and dollars that went out in their name.

## Fixed constraints (from the spec — do not deviate)

- **Client:** Codex CLI only. No other clients or wire formats.
- **Endpoint:** `POST /v1/responses` (Responses API). NOT `/v1/chat/completions`.
- **Upstream:** `https://api.openai.com/v1/responses`, pure passthrough, no translation.
- **The reveal is in the request**, not the response.
- Codex must behave exactly as if talking to OpenAI directly: forward status, relevant headers, and raw SSE bytes without buffering or reshaping. No `[DONE]` assumptions; Responses streams typed semantic events.

## Decisions made in this build

- **Stack:** Node 24 + Express (spec's default recommendation). Inspector is plain HTML/CSS/JS served by the same Express process — same origin, so no CORS needed.
- **Capture:** `express.raw()` captures the exact request bytes; a parsed copy is decomposed for display; the raw bytes are what get forwarded upstream (perfect fidelity).
- **Auth:** real `OPENAI_API_KEY` lives only in the proxy's environment. The Bearer token Codex sends is ignored and never logged or displayed. If the proxy has no key, it falls back to passing through the client's Authorization header (dev convenience), still never logging it.
- **Storage:** in-memory ring buffer of the last 20 captures, exposed at `GET /inspect`. UI polls every 500 ms (spec: WebSocket is optional polish, not required).
- **Usage/cost:** primary source is the `usage` object on the `response.completed` SSE event, read from a non-blocking tee of the stream (client writes are never delayed). Fallback while pending: rough estimate (bytes/4). Prices per 1M tokens live in one hardcoded table verified against the live pricing page on build day.
- **Response tee cap:** the tee accumulates at most a few MB for parsing; beyond that it stops accumulating but keeps piping — passthrough is never at risk.
- **Server binds to 127.0.0.1** — this is a local demo tool holding an API key; it must not listen on all interfaces.
- **Test harness:** `test/mock-upstream.js` (a fake `/v1/responses` that emits realistic SSE) + `test/smoke.sh` curl round-trips. Lets every milestone be verified without an API key and without launching Codex.

## Architecture

```
[ Codex CLI ] --> [ transparency proxy :8080 ] --> [ api.openai.com/v1/responses ]
                        |            |
                   GET /inspect   GET / (inspector UI, polls /inspect)
```

Components:
- `server.js` — proxy, capture, tee-parser, `/inspect`, static UI. The only thing that must be solid.
- `public/index.html` — two-pane inspector. Left: what the user saw (their ask + the reply). Right: what actually went out (instructions block and tools visually called out, params, tokens, cost).
- `test/` — mock upstream + curl smoke tests.

## Error handling

- Upstream unreachable → 502 JSON error to client; capture marked `upstream_error`.
- Unparseable request body → still forwarded verbatim (passthrough first); capture shows raw size and a parse-failure note.
- Non-streaming (`stream:false`) responses → same path; usage parsed from the JSON body instead of SSE.

## Milestones (build order, from the spec)

1. Passthrough proxy (must land) → 2. capture + `/inspect` → 3. inspector UI → 4. streaming correctness → 5. usage + cost → 6. point Codex at it.

Cut order if time-boxed: cost meter → token count → UI polish. Never cut proxy or capture.
