import { test } from "node:test";
import assert from "node:assert/strict";

import { ModelOutputError, createClaudeClient } from "../lib/claude.js";
import { INTERVIEW_SYSTEM_PROMPT, INTERVIEW_TURN_SCHEMA } from "../lib/prompts.js";

function stubClient(responseBody, captured) {
  return createClaudeClient({
    apiKey: "test-key",
    maxRetries: 0,
    fetch: async (url, init) => {
      captured.url = String(url);
      captured.headers = new Headers(init.headers);
      captured.body = JSON.parse(init.body);
      return new Response(JSON.stringify(responseBody), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
}

const message = (content, stop_reason = "end_turn") => ({
  id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5",
  content, stop_reason, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
});

test("interview turn sends structured-output request with fallbacks and keeps raw content", async () => {
  const captured = {};
  const output = { reply: "질문입니다" };
  const llm = stubClient(
    message([{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: JSON.stringify(output) }]),
    captured,
  );
  const result = await llm.interviewTurn({
    system: INTERVIEW_SYSTEM_PROMPT,
    messages: [{ role: "user", content: "안녕하세요" }],
    schema: INTERVIEW_TURN_SCHEMA,
  });

  assert.match(captured.url, /\/v1\/messages/);
  assert.match(captured.headers.get("anthropic-beta"), /server-side-fallback-2026-07-01/);
  assert.equal(captured.body.model, "claude-opus-5");
  assert.equal(captured.body.fallbacks, "default");
  assert.deepEqual(captured.body.thinking, { type: "adaptive" });
  assert.equal(captured.body.output_config.format.type, "json_schema");
  assert.equal(captured.body.betas, undefined);
  assert.deepEqual(result.output, output);
  assert.equal(result.content.length, 2, "thinking block kept for history");
});

test("refusals surface as a readable error", async () => {
  const llm = stubClient(message([], "refusal"), {});
  await assert.rejects(
    llm.interviewTurn({ system: "s", messages: [{ role: "user", content: "x" }], schema: INTERVIEW_TURN_SCHEMA }),
    ModelOutputError,
  );
});
