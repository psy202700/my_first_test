import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5";
// Interview turns are conversational, so a lower effort keeps replies quick;
// the final document is where deeper reasoning pays off.
const INTERVIEW_EFFORT = process.env.INTERVIEW_EFFORT || "medium";
const DOCUMENT_EFFORT = process.env.DOCUMENT_EFFORT || "high";
// Server-side refusal fallback. Set CLAUDE_FALLBACKS=off where it is unsupported (Bedrock/Vertex/Foundry).
const USE_FALLBACKS = process.env.CLAUDE_FALLBACKS !== "off";

export class ModelOutputError extends Error {
  name = "ModelOutputError";
}

function fallbackParams() {
  return USE_FALLBACKS ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {};
}

function checkStopReason(message) {
  if (message.stop_reason === "refusal") {
    throw new ModelOutputError(
      "모델이 이 요청에 대한 응답을 거절했습니다. 표현을 바꾸거나 민감한 내용을 제외하고 다시 시도해 주세요.",
    );
  }
  if (message.stop_reason === "max_tokens") {
    throw new ModelOutputError("응답이 길이 제한에 걸려 중간에 끊겼습니다. 다시 시도해 주세요.");
  }
}

// `options` is passed to the SDK constructor (tests inject a stub `fetch`).
export function createClaudeClient(options = {}) {
  const client = new Anthropic(options);

  return {
    // One structured interview turn. Returns the raw assistant content (to keep in
    // history unchanged, including thinking blocks) and the parsed JSON output.
    async interviewTurn({ system, messages, schema }) {
      const message = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        output_config: { effort: INTERVIEW_EFFORT, format: { type: "json_schema", schema } },
        cache_control: { type: "ephemeral" },
        system,
        messages,
        ...fallbackParams(),
      });
      checkStopReason(message);

      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      try {
        return { content: message.content, output: JSON.parse(text), usage: message.usage };
      } catch {
        throw new ModelOutputError("모델 응답을 해석하지 못했습니다. 다시 시도해 주세요.");
      }
    },

    // Streams the handover document as markdown. Calls onText for each text delta.
    async streamDocument({ system, messages, onText }) {
      const stream = client.beta.messages.stream({
        model: MODEL,
        max_tokens: 64000,
        thinking: { type: "adaptive" },
        output_config: { effort: DOCUMENT_EFFORT },
        cache_control: { type: "ephemeral" },
        system,
        messages,
        ...fallbackParams(),
      });
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          onText(event.delta.text);
        }
      }
      const message = await stream.finalMessage();
      checkStopReason(message);
      return message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
    },
  };
}
