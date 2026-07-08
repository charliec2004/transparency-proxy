// Transparency proxy for the OpenAI Responses API.
//
// Codex points its base_url at http://127.0.0.1:8080/v1 and cannot tell the
// difference: every request is forwarded byte-for-byte to the real endpoint
// and the response (including SSE) is streamed back untouched. On the side,
// each request is decomposed and exposed at GET /inspect for the inspector UI.

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8080);
// UPSTREAM_URL exists so the smoke test can target the local mock upstream.
const UPSTREAM_URL =
  process.env.UPSTREAM_URL || "https://api.openai.com/v1/responses";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

const MAX_CAPTURES = 20;
// The tee that parses the response stream stops accumulating past this size.
// Passthrough to the client is never affected; we just lose usage parsing.
const MAX_TEE_BYTES = 8 * 1024 * 1024;

// USD per 1M tokens. Verified against the live pricing page
// (https://developers.openai.com/api/docs/pricing) on 2026-07-07 —
// re-check before demo day, these change.
// `cachedInput` is the discounted rate for input_tokens_details.cached_tokens.
const PRICES = {
  "gpt-5.5": { input: 5.0, cachedInput: 0.5, output: 30.0 },
  "gpt-5.5-pro": { input: 30.0, cachedInput: 30.0, output: 180.0 },
  "gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 15.0 },
  "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, cachedInput: 0.02, output: 1.25 },
  "gpt-5.4-pro": { input: 30.0, cachedInput: 30.0, output: 180.0 },
  "gpt-5.3-codex": { input: 1.75, cachedInput: 0.175, output: 14.0 },
};

function priceFor(model) {
  if (!model) return null;
  if (PRICES[model]) return PRICES[model];
  // Dated snapshots like "gpt-5.4-2026-05-01" fall back to the base price.
  const base = Object.keys(PRICES)
    .sort((a, b) => b.length - a.length)
    .find((k) => model.startsWith(k));
  return base ? PRICES[base] : null;
}

function costFromUsage(model, usage) {
  const p = priceFor(model);
  if (!p || !usage) return null;
  const input = usage.input_tokens ?? 0;
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const fresh = Math.max(0, input - cached);
  return (
    (fresh * p.input + cached * p.cachedInput + output * p.output) / 1e6
  );
}

// ---------------------------------------------------------------------------
// Capture store: ring buffer of decomposed requests, newest first.
// ---------------------------------------------------------------------------

const captures = [];
let nextId = 1;

// Everything in a Responses request that is not one of the headline fields
// gets grouped under `params` for the UI.
const HEADLINE_FIELDS = new Set(["model", "instructions", "input", "tools"]);

function decomposeRequest(rawBuffer) {
  const entry = {
    id: nextId++,
    time: new Date().toISOString(),
    requestBytes: rawBuffer.length,
    parseError: null,
    model: null,
    instructions: null,
    input: null,
    tools: null,
    params: {},
    // Filled in as the response comes back:
    status: "pending", // pending | streaming | done | upstream_error | error
    httpStatus: null,
    usage: null,
    cost: null,
    outputText: "",
    durationMs: null,
  };
  try {
    const body = JSON.parse(rawBuffer.toString("utf8"));
    entry.model = body.model ?? null;
    entry.instructions = body.instructions ?? null;
    entry.input = body.input ?? null;
    entry.tools = body.tools ?? null;
    for (const [k, v] of Object.entries(body)) {
      if (!HEADLINE_FIELDS.has(k)) entry.params[k] = v;
    }
  } catch (err) {
    entry.parseError = "request body is not valid JSON";
  }
  captures.unshift(entry);
  if (captures.length > MAX_CAPTURES) captures.length = MAX_CAPTURES;
  return entry;
}

// ---------------------------------------------------------------------------
// Response tee: parse the SSE stream (or JSON body) on the side to pull out
// usage (for the cost meter) and output text (for the left pane). This runs
// on our own copy of the bytes and never delays writes to the client.
// ---------------------------------------------------------------------------

function makeTeeParser(entry) {
  let text = "";
  let bytes = 0;
  const decoder = new TextDecoder();
  return {
    push(chunk) {
      bytes += chunk.length;
      if (bytes <= MAX_TEE_BYTES) text += decoder.decode(chunk, { stream: true });
    },
    finish(contentType) {
      text += decoder.decode();
      if ((contentType || "").includes("text/event-stream")) {
        parseSse(text, entry);
      } else {
        parseJsonBody(text, entry);
      }
    },
  };
}

function parseSse(text, entry) {
  // SSE events are separated by blank lines; each has `data:` lines whose
  // concatenation is a JSON payload with a `type` field.
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      entry.outputText += event.delta;
    } else if (event.type === "response.completed" && event.response) {
      applyCompleted(entry, event.response);
    }
  }
}

function parseJsonBody(text, entry) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return;
  }
  entry.outputText =
    body.output_text ??
    (Array.isArray(body.output)
      ? body.output
          .filter((item) => item.type === "message")
          .flatMap((item) => item.content || [])
          .filter((c) => c.type === "output_text")
          .map((c) => c.text)
          .join("")
      : "");
  applyCompleted(entry, body);
}

function applyCompleted(entry, response) {
  if (response.usage) {
    entry.usage = response.usage;
    entry.cost = costFromUsage(entry.model, response.usage);
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const app = express();
app.disable("x-powered-by");

app.use(express.static(path.join(__dirname, "public")));

app.get("/inspect", (_req, res) => {
  res.json({ captures });
});

app.post(
  "/v1/responses",
  express.raw({ type: () => true, limit: "64mb" }),
  async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const entry = decomposeRequest(raw);
    const started = Date.now();

    // The real key lives only here. The Bearer token Codex sends is used as a
    // fallback when the proxy has no key of its own; it is never logged or
    // exposed via /inspect.
    const auth = OPENAI_API_KEY
      ? `Bearer ${OPENAI_API_KEY}`
      : req.headers["authorization"] || "";

    const headers = {
      "content-type": req.headers["content-type"] || "application/json",
      accept: req.headers["accept"] || "application/json",
    };
    if (auth) headers.authorization = auth;
    // Codex sends OpenAI-specific headers (beta flags, originator, session
    // ids). Pass through anything openai-* so upstream behavior is identical.
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.startsWith("openai-") && typeof v === "string") headers[k] = v;
    }

    let upstream;
    try {
      upstream = await fetch(UPSTREAM_URL, { method: "POST", headers, body: raw });
    } catch (err) {
      entry.status = "upstream_error";
      entry.durationMs = Date.now() - started;
      console.error(`[proxy] upstream connection failed: ${err.message}`);
      res
        .status(502)
        .json({ error: { message: "transparency proxy: upstream connection failed" } });
      return;
    }

    entry.httpStatus = upstream.status;
    entry.status = "streaming";

    res.status(upstream.status);
    const contentType = upstream.headers.get("content-type") || "";
    for (const h of ["content-type", "openai-request-id", "x-request-id", "openai-processing-ms"]) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.flushHeaders();

    const tee = makeTeeParser(entry);
    try {
      if (upstream.body) {
        // Relay chunks the moment they arrive — never buffer the stream.
        for await (const chunk of upstream.body) {
          res.write(chunk);
          tee.push(chunk);
        }
      }
      tee.finish(contentType);
      entry.status = upstream.ok ? "done" : "error";
    } catch (err) {
      entry.status = "error";
      console.error(`[proxy] stream relay interrupted: ${err.message}`);
    } finally {
      entry.durationMs = Date.now() - started;
      res.end();
    }
  }
);

// Codex probes nothing else, but a clear 404 on the Chat Completions path
// saves debugging time if a client is misconfigured.
app.post("/v1/chat/completions", (_req, res) => {
  res.status(404).json({
    error: {
      message:
        "This proxy speaks the Responses API only. Point your client at /v1/responses (Codex: wire_api = \"responses\").",
    },
  });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`[proxy] listening on http://127.0.0.1:${PORT}`);
  console.log(`[proxy] upstream: ${UPSTREAM_URL}`);
  console.log(
    `[proxy] server-side OPENAI_API_KEY: ${OPENAI_API_KEY ? "set" : "NOT set (will pass through client Authorization header)"}`
  );
  console.log(`[proxy] inspector: http://127.0.0.1:${PORT}/`);
});
