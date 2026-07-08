# Hackathon Transparency Proxy: Master Build Prompt (Codex target)

Hand this whole document to a coding assistant. It contains the concept, the target client, the architecture, the build order, the research you still need to do, and the traps to avoid. Read the "Context" section first so your decisions serve the demo, not just the code.

This build targets one client only: OpenAI's Codex. That decision fixes the wire format and the upstream. Do not add support for other clients or formats. Narrowing to Codex is deliberate; it keeps the build small enough to finish in a couple of hours.

## Context (read this first)

We are building a demo for a hack night about "punk software," a reaction to AI products that quietly work against the user. One of the named problems is that agent tools send a large hidden payload on your behalf every time you type: a system prompt you never saw, tool schemas that let the tool take actions silently, and a token cost you are paying without knowing. You type a few words. The wire tells a different story.

This tool makes that hidden layer visible. It is a proxy that sits between Codex and the real model provider. Codex thinks it is talking to a normal endpoint. In reality every request passes through us, and we render the full payload in a side panel: the instruction block, the input, the tool definitions, a token count, and a dollar cost.

Codex is a strong target for this because it sends a genuinely large instruction set and a batch of real tools, including shell access and file patching. That makes the reveal honest and vivid. The hidden payload is Codex's own, not something you wrote to stage the trick.

The demo beat is the whole point. Someone gives Codex a tiny task, or just says hi. Then the panel lights up and shows that Codex sent thousands of tokens in their name, including instructions and tools that can touch their machine, none of it shown to the person who typed. The line is: "You asked for one small thing. Here is what was actually sent for you."

Build so that this reveal is impossible to miss and impossible to break on stage. We own the proxy and the inspector, and Codex talks to a plain HTTP endpoint, so nothing depends on reverse-engineering undocumented behavior. Keep it that way.

## Target and wire format (this is fixed, do not deviate)

- Client: OpenAI Codex. Drive it with the Codex CLI for the demo. The Codex desktop app reads the same config and works too, but its custom-provider support has rough edges (a missing model switcher and reported auth-key mixups have been filed), so the CLI is the reliable stage driver. The desktop app is a fallback, not the primary.
- Wire format: the Responses API. Current Codex speaks only the Responses API and dropped Chat Completions. So the proxy exposes POST /v1/responses, not /v1/chat/completions. If you build the Chat Completions path by mistake, Codex gets 404s and empty streams. The endpoint path and shape matter.
- Upstream: OpenAI direct. Forward to https://api.openai.com/v1/responses. This is a true passthrough: Responses in, Responses out, no translation. Do not point the upstream at OpenRouter or most aggregators for this build, because many of them serve Chat Completions only and would break a pure passthrough.

Point Codex at the proxy with a custom model provider in ~/.codex/config.toml. Reserved provider IDs (openai, ollama, lmstudio) cannot be reused, so give it a custom ID:

```toml
model = "gpt-5.4"                       # use a model your OpenAI key can actually call
model_provider = "transparency"

[model_providers.transparency]
name = "Transparency Proxy"
base_url = "http://localhost:8080/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
requires_openai_auth = false            # so Codex sends the Bearer token instead of forcing ChatGPT login
```

Codex then sends its Bearer token (from OPENAI_API_KEY) to your proxy. The proxy forwards upstream to OpenAI with the real key, which lives only on the server.

## What it does (functional spec)

1. Exposes POST /v1/responses matching the OpenAI Responses API, so Codex can point at it with the config above.
2. Captures the full incoming request body before doing anything else.
3. Forwards the request unchanged to https://api.openai.com/v1/responses using an API key held only on the server.
4. Streams the upstream response back to Codex byte for byte, so Codex behaves exactly as if it were talking to OpenAI directly.
5. Decomposes the captured request and shows it in a web panel: the instruction block on its own, the input items, the tool schemas, model and parameters, a token count, and an estimated cost.

Codex must not be able to tell the difference between the proxy and the real endpoint. The transparency happens on the side, for the human, not in the response.

## Architecture

Three moving parts:

```
[ Codex CLI ]  -->  [ TRANSPARENCY PROXY ]  -->  [ OpenAI Responses API ]
                            |
                            v
                    [ inspector web UI ]
```

- The proxy is the only thing that has to be solid. It receives, captures, forwards, and streams back.
- The inspector UI reads the captured requests from the proxy and renders them. Keep it dead simple: the proxy holds the last few requests in memory and exposes them at GET /inspect; the UI polls that route a couple of times a second. A WebSocket push is nicer but is an optional upgrade, not a requirement.
- Keep a raw curl smoke test as your test harness so you can exercise milestone one without launching Codex. This is for testing only, not a second supported client. Post a minimal Responses body to http://localhost:8080/v1/responses and confirm a round trip before you ever wire up Codex.

Where this runs. The proxy is a standalone server process running locally, listening on something like http://localhost:8080/v1. It is not a browser extension and it is not injected into Codex. Nothing gets modified inside Codex. The only change on the client side is the config file pointing its base URL at the proxy. For a solo stage demo, everything (Codex, proxy, inspector) runs on one laptop, and the only outbound connection is the proxy reaching OpenAI. You do not need to host anything.

## Recommended stack

Pick one language for the whole thing to cut context-switching. Two good options:

- Node with Express (or Hono on Bun). Natural fit because the inspector is also JS, and streaming a proxied SSE response is straightforward with fetch and readable streams.
- Python with FastAPI. Also fine; use httpx with streaming and StreamingResponse.

Default recommendation: Node + Express, plain HTML/CSS/JS for the inspector (no framework needed for a two-hour build). Only reach for React if the UI genuinely needs it, which it does not.

Upstream: OpenAI direct at https://api.openai.com/v1/responses. That is the whole point of targeting Codex only. One format in, the same format out, no translation layer.

## Build order (get each milestone fully working before the next)

Milestone 1: passthrough proxy. Accept POST /v1/responses, forward the exact body to https://api.openai.com/v1/responses with the server-side key, return the response unchanged (including the streamed SSE). Test with a raw curl first. This is the only milestone that absolutely must land. Do not move on until a round trip works.

Milestone 2: request capture and decomposition. Before forwarding, store the parsed body. Split it into the top-level Responses fields: model, instructions (the big instruction block, this is the headline of the reveal), input (the conversation items), tools (the tool schemas Codex exposes, including shell and file editing), and parameters like temperature. Verify the exact field names against the Responses API reference, since this is the part most likely to drift. Expose the last N captured requests at GET /inspect.

Milestone 3: the inspector UI. A single page, two panes. Left pane shows the task and the reply. Right pane shows the decomposed hidden payload from /inspect, with the instruction block and the tools visually called out because those are the gotcha. Poll /inspect every 500ms and re-render.

Milestone 4: streaming. Handle "stream": true. The Responses API streams typed semantic events over SSE (for example response.created, response.output_text.delta, response.completed), not the choices[0].delta chunks of Chat Completions. For a passthrough you do not need to understand these events; relay the raw SSE bytes as they arrive without buffering the whole thing. Only parse events if you want to display streamed text or read usage.

Milestone 5: token count and cost. The cleanest number is the usage the API reports back in the response.completed event (input and output token counts). Read it there, multiply by a small hardcoded price table (look up current numbers, do not trust old memory), and show a dollar figure. Local counting with tiktoken is a fallback, not the primary path here.

Milestone 6: point Codex at the proxy. Drop in the ~/.codex/config.toml block from above, launch codex, and confirm the inspector fills with a real Codex request. This is the moment the demo exists.

If you fall behind, cut in this order: cost meter, then token count, then the fancy UI. The proxy plus a raw dump of the captured instructions and tools is enough for the reveal to work.

## Research you still need to do

Do not guess on these. Look them up and verify, because several are version-sensitive.

1. Responses API request schema. Confirm the exact top-level fields: model, instructions, input (string or array of input items), tools, tool_choice, temperature, stream. Search: "OpenAI Responses API reference create response."
2. Responses API streaming events. Understand the semantic event stream: Content-Type: text/event-stream, typed events like response.created, response.output_text.delta, and response.completed. Confirm how completion is signaled and whether any terminal sentinel is sent, then relay everything verbatim. Search: "OpenAI Responses API streaming events."
3. Usage reporting. Confirm the usage object on the response.completed event and its token fields. Search: "OpenAI Responses API usage tokens streaming."
4. Current pricing. Pull live per-token input and output prices for whatever model you demo. These change. Do not hardcode remembered numbers. Search: "OpenAI API pricing per token."
5. Codex custom provider config. Confirm the model_providers block, wire_api = "responses", requires_openai_auth = false, and that both the CLI and the desktop app read ~/.codex/config.toml. Search: "Codex CLI config.toml model_providers base_url wire_api."
6. Codex desktop caveats. If you plan to demo with the desktop app rather than the CLI, check the open issues on custom providers first (missing model switcher, auth-key handling) so you are not surprised on stage. Search: "Codex desktop app custom model provider issue."
7. CORS, only if the inspector page calls the proxy from the browser. A server-side poll has no CORS issue. Search: "Express CORS" or "FastAPI CORS middleware."

## Gotchas that will eat your time

- Wrong endpoint path. It must be /v1/responses. If you build /v1/chat/completions, Codex 404s even though a curl to the wrong path might look fine. The host is up; the protocol is wrong.
- Do not buffer the stream. If you read the entire upstream response before returning it, Codex loses live output and may time out. Pipe chunks through as they arrive.
- Preserve the response exactly. Codex must behave normally. Forward status code, the headers that matter, and the raw SSE bytes. Your inspection happens on a copy of the request, not by mutating the response.
- Relay events verbatim. The Responses stream is typed events, not choices[0].delta. Do not assume a [DONE] sentinel or try to reshape events. Pass the bytes through untouched.
- The reveal is in the request, not the response. The instructions block and the tools array are what you display. Capture the raw body and decompose those. Do not spend time parsing model output for the demo.
- Auth handoff. Set requires_openai_auth = false so Codex sends the Bearer token to your proxy instead of forcing a ChatGPT login. The real OpenAI key lives only on the proxy, in an environment variable, and never reaches the browser. Leaking it on stage would be an ironic way to lose.
- GUI env vars. If you do use the desktop app, remember a macOS app launched from the Dock does not inherit shell environment variables. Rely on the config file, not an exported variable.

## Demo script (build toward this)

1. Show a terminal with Codex pointed at the proxy, and the inspector panel open and empty on screen.
2. Give Codex something small. A one-line task, or just "say hi."
3. Turn to the inspector. It now shows the real request Codex sent: a large instruction block the user never wrote, the tools Codex can fire including shell access and file patching, the full input, and a counter reading thousands of tokens and a cost in dollars.
4. Land the line: you asked for one small thing, and this is the instruction set and the machine access that went out in your name, none of it shown to you by the tool. Then the framing: honest software would show you this by default.

Rehearse it once so the panel is already populated and you are not debugging live against Codex. Aim for under two minutes so you are safe against the three-minute cutoff.

## Scope discipline

Core, must work: the /v1/responses passthrough proxy and a visible dump of the captured instructions and tools. Everything downstream of that is polish.

Nice to have: clean two-pane UI, live token counter from response.completed, dollar cost, streamed output rendering.

Cut without hesitation if time is short: cost meter first, then token count, then UI styling. Never cut the proxy or the capture. The reveal survives on those two alone.
