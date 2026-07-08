# Transparency Proxy

**You asked for one small thing. Here is what was actually sent for you.**

A punk-software demo: a local passthrough proxy for the OpenAI Responses API
that sits between **Codex** and OpenAI. Codex can't tell the difference —
every request is forwarded byte-for-byte and the SSE response streams back
untouched. On the side, an inspector panel shows the hidden payload that went
out in your name: the instruction block you never saw, the tools it can fire
(shell access, file patching), the full input, a token count, and a dollar
cost.

```
[ Codex CLI ]  -->  [ transparency proxy :8080 ]  -->  [ api.openai.com/v1/responses ]
                            |
                            v
                  [ inspector: http://127.0.0.1:8080/ ]
```

## Run it

```sh
npm install
OPENAI_API_KEY=sk-...  npm start        # the real key lives ONLY here
open http://127.0.0.1:8080/             # the inspector
```

The proxy binds to 127.0.0.1 only. The key is never logged and never reaches
the browser; `/inspect` exposes decomposed request bodies, not auth headers.

## Point Codex at it

Add to `~/.codex/config.toml` (verified against the current Codex config
reference, 2026-07-07 — `wire_api = "responses"` is now the only supported
value; Codex appends `/responses` to `base_url`):

```toml
model = "gpt-5.3-codex"                 # current Codex model; any model your key can call
model_provider = "transparency"

[model_providers.transparency]
name = "Transparency Proxy"
base_url = "http://localhost:8080/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
requires_openai_auth = false            # Codex sends a Bearer token instead of forcing ChatGPT login
```

Then launch `codex` in any directory (with `OPENAI_API_KEY` set in that shell
— Codex requires the env var named by `env_key` to exist; the proxy replaces
it with its own key upstream). Type something tiny. Watch the panel.

Use the Codex **CLI** on stage; the desktop app reads the same config but its
custom-provider support has rough edges.

## Test without an API key / without Codex

```sh
npm run smoke     # mock upstream + proxy + curl round trips (stream & non-stream)
```

Or by hand: `npm run mock` in one terminal, then
`UPSTREAM_URL=http://127.0.0.1:9090/v1/responses npm start` in another, and
curl a Responses body at `http://127.0.0.1:8080/v1/responses`.

## Demo script (< 2 min)

1. Terminal with Codex pointed at the proxy; inspector open beside it, already
   populated from a rehearsal request.
2. Ask Codex for something tiny — "say hi".
3. Turn to the inspector: the ratio strip shows your ~2 tokens against the
   thousands sent in your name; instructions block and machine-access tools
   called out in orange and red; a dollar figure on top.
4. The line: *"You asked for one small thing. This is the instruction set and
   the machine access that went out in your name — none of it shown to you.
   Honest software would show you this by default."*

## Notes

- Pricing table in `server.js` was verified against the live pricing page on
  2026-07-07. Re-check before demo day.
- Usage/cost come from the `usage` object on the `response.completed` event;
  until it arrives the panel shows a `≈ bytes/4` estimate.
- The proxy holds the last 20 requests in memory at `GET /inspect`. Nothing is
  persisted to disk.
