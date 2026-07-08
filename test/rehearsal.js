// Sends a realistic Codex-shaped request through the proxy so the inspector
// has something vivid to show. Handy for rehearsing the demo against the mock
// upstream without burning API tokens. Usage: node test/rehearsal.js [ask]
const ask = process.argv[2] || "say hi";

const instructions =
  [
    "You are Codex, based on GPT-5. You are running as a coding agent in the Codex CLI on a user's computer.",
    "",
    "## General",
    '- The arguments to shell will be passed to execvp(). Most terminal commands should be prefixed with ["bash","-lc"].',
    "- Always set the workdir param when using the shell function.",
    "- When searching for text or files, prefer using rg or rg --files because rg is much faster than alternatives.",
    "",
    "## Editing constraints",
    "- Default to ASCII when editing or creating files.",
    "- Add succinct code comments that explain what is going on.",
    "- You may be in a dirty git worktree. NEVER revert existing changes you did not make.",
    "",
    "## Sandbox and approvals",
    "The Codex CLI harness supports several different sandboxing and escalation approval configurations...",
    "",
  ]
    .join("\n")
    .repeat(20) +
  "\n(Rehearsal payload: stand-in for the real ~20k-char Codex instruction block.)";

const body = {
  model: "gpt-5.3-codex",
  instructions,
  input: [{ role: "user", content: [{ type: "input_text", text: ask }] }],
  tools: [
    {
      type: "function",
      name: "shell",
      description: "Runs a shell command and returns its output",
      parameters: {
        type: "object",
        properties: {
          command: { type: "array", items: { type: "string" } },
          workdir: { type: "string" },
          timeout_ms: { type: "number" },
        },
        required: ["command"],
      },
    },
    {
      type: "function",
      name: "apply_patch",
      description: "Use the apply_patch tool to edit files",
      parameters: {
        type: "object",
        properties: { input: { type: "string" } },
        required: ["input"],
      },
    },
    {
      type: "function",
      name: "update_plan",
      description: "Updates the task plan",
      parameters: { type: "object", properties: { plan: { type: "array" } } },
    },
    { type: "web_search" },
  ],
  tool_choice: "auto",
  parallel_tool_calls: false,
  reasoning: { effort: "medium", summary: "auto" },
  store: false,
  stream: true,
  include: ["reasoning.encrypted_content"],
  // No prompt_cache_key on purpose: the inspector uses it to distinguish real
  // Codex traffic, so rehearsal requests get the "not from your Codex
  // session" tag like any other outside caller.
};

const res = await fetch("http://127.0.0.1:8080/v1/responses", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer fake-rehearsal-token" },
  body: JSON.stringify(body),
});
const text = await res.text();
console.log(`round trip: HTTP ${res.status}, ${text.length} bytes streamed back`);
