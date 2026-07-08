// Fake OpenAI Responses endpoint for testing the proxy without an API key.
// Emits the same typed SSE events the real API sends (response.created,
// response.output_text.delta, response.completed with usage), or a plain JSON
// body when the request has stream:false.
//
// Usage:  node test/mock-upstream.js          (listens on :9090)
//         UPSTREAM_URL=http://127.0.0.1:9090/v1/responses node server.js

import http from "node:http";

const PORT = Number(process.env.MOCK_PORT || 9090);

const REPLY = "Hello from the mock upstream. The proxy round trip works.";

function responseObject(body, { completed }) {
  return {
    id: "resp_mock_001",
    object: "response",
    model: body.model || "gpt-mock",
    status: completed ? "completed" : "in_progress",
    output: completed
      ? [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: REPLY }],
          },
        ]
      : [],
    usage: completed
      ? {
          input_tokens: 4321,
          input_tokens_details: { cached_tokens: 1024 },
          output_tokens: 42,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 4363,
        }
      : undefined,
  };
}

http
  .createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/responses") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "invalid JSON" } }));
        return;
      }

      if (body.stream === false) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(responseObject(body, { completed: true })));
        return;
      }

      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
      });
      const send = (type, extra) => {
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`);
      };
      send("response.created", { response: responseObject(body, { completed: false }) });
      const words = REPLY.split(" ");
      let i = 0;
      const timer = setInterval(() => {
        if (i < words.length) {
          send("response.output_text.delta", {
            delta: (i ? " " : "") + words[i],
            output_index: 0,
            content_index: 0,
          });
          i++;
        } else {
          clearInterval(timer);
          send("response.completed", { response: responseObject(body, { completed: true }) });
          res.end();
        }
      }, 40);
    });
  })
  .listen(PORT, "127.0.0.1", () => {
    console.log(`[mock] fake Responses API on http://127.0.0.1:${PORT}/v1/responses`);
  });
