import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createApp } from "../server.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const calls = [];

// Scripted stand-in for the Claude client.
const fakeLlm = {
  async interviewTurn({ messages }) {
    calls.push(messages);
    const n = calls.length;
    const output = {
      reply: n === 1 ? "안녕하세요. 먼저 이야기하고 싶은 업무가 있으신가요?" : "정확한 주기를 다시 여쭤보지 않도록 관련 메일을 주시면 도움이 됩니다.",
      turn_type: n === 1 ? "question" : "upload_request",
      current_category: n === 1 ? "overview" : "routine",
      current_topic: n === 1 ? "" : "월간 정산보고",
      slots: { who: "filled", when: "missing", where: "missing", how: "missing", exception: "missing" },
      upload_request: n === 1
        ? { requested: false, trigger: "none", search_suggestion: "" }
        : { requested: true, trigger: "a_repetition_unclear", search_suggestion: "최근 3개월, 제목 '정산'" },
      facts: n === 1 ? [] : [{ category: "routine", topic: "월간 정산보고", slot: "who", content: "재무팀에 보고", source: "interview", status: "confirmed" }],
      completed_categories: [],
      phase: "interview",
    };
    return { content: [{ type: "text", text: JSON.stringify(output) }], output };
  },
  async streamDocument({ messages, onText }) {
    assert.match(messages.at(-1).content, /인수인계서 작성 요청/);
    onText("# 업무 인수인계서\n");
    onText("- 정산보고: 확인 필요\n");
    return "# 업무 인수인계서\n- 정산보고: 확인 필요\n";
  },
};

let server;
let base;
let sessionDir;

before(async () => {
  sessionDir = await mkdtemp(path.join(tmpdir(), "handover-"));
  server = createApp({
    llm: fakeLlm,
    sessionDir,
    templatePath: path.join(here, "..", "templates", "handover-template.md"),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await rm(sessionDir, { recursive: true, force: true });
});

const post = (url, body) =>
  fetch(base + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("full interview flow: open, answer with attachment, generate document", async () => {
  const created = await (await post("/api/sessions", { meta: { predecessor: "김전임", jobTitle: "정산" } })).json();
  assert.equal(created.transcript.length, 1, "opening prompt is hidden, only the greeting shows");
  assert.equal(created.transcript[0].role, "assistant");
  assert.match(calls[0].at(-1).content[0].text, /전임자: 김전임/);

  const res = await post(`/api/sessions/${created.id}/turn`, {
    text: "보통 매달 정산보고를 재무팀에 보내요",
    attachments: [{ name: "정산.txt", data: Buffer.from("3월 정산").toString("base64") }],
  });
  const updated = await res.json();
  assert.equal(res.status, 200);
  const sent = calls[1].at(-1).content;
  assert.equal(sent[0].text, "[첨부자료: 정산.txt] (txt 파일)");
  assert.match(sent.at(-1).text, /<interview_state>/);
  assert.equal(calls[1].length, 3, "history + new user turn");
  assert.equal(updated.state.categories.routine.uploadRequests, 1);
  assert.equal(updated.transcript.at(-1).uploadRequest.trigger, "a_repetition_unclear");
  assert.deepEqual(updated.transcript.at(-2).attachments, [{ name: "정산.txt", kind: "텍스트" }]);

  const doc = await post(`/api/sessions/${created.id}/document`);
  assert.equal(await doc.text(), "# 업무 인수인계서\n- 정산보고: 확인 필요\n");
  const md = await fetch(`${base}/api/sessions/${created.id}/document.md`);
  assert.match(md.headers.get("content-disposition"), /attachment/);
});

test("rejects bad input with a readable error", async () => {
  const created = await (await post("/api/sessions", {})).json();
  const empty = await post(`/api/sessions/${created.id}/turn`, { text: "  " });
  assert.equal(empty.status, 400);
  const badFile = await post(`/api/sessions/${created.id}/turn`, { attachments: [{ name: "x.exe", data: "eA==" }] });
  assert.equal(badFile.status, 400);
  assert.match((await badFile.json()).error, /지원하지 않는 형식/);
  const traversal = await fetch(`${base}/api/sessions/..%2F..%2Fetc`);
  assert.equal(traversal.status, 400);
});

test("serves the UI and blocks path traversal on static files", async () => {
  const page = await fetch(base + "/");
  assert.match(await page.text(), /인수인계 인터뷰/);
  const escape = await fetch(base + "/../server.js");
  assert.notEqual(escape.status, 200);
});
