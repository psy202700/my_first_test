import { test } from "node:test";
import assert from "node:assert/strict";

import { applyModelTurn, buildStateNote, createInitialState } from "../lib/state.js";

function turn(overrides = {}) {
  return {
    reply: "질문",
    turn_type: "question",
    current_category: "routine",
    current_topic: "월간 정산보고",
    slots: { who: "filled", when: "missing", where: "missing", how: "missing", exception: "missing" },
    upload_request: { requested: false, trigger: "none", search_suggestion: "" },
    facts: [],
    completed_categories: [],
    phase: "interview",
    ...overrides,
  };
}

test("marks the current category in progress and completed ones done", () => {
  let state = applyModelTurn(createInitialState(), turn());
  assert.equal(state.categories.routine.status, "in_progress");
  state = applyModelTurn(state, turn({ current_category: "projects", completed_categories: ["routine"] }));
  assert.equal(state.categories.routine.status, "done");
  assert.equal(state.categories.projects.status, "in_progress");
  assert.equal(state.currentCategory, "projects");
});

test("later facts for the same topic and slot replace earlier ones", () => {
  const fact = { category: "routine", topic: "월간 정산보고", slot: "when", source: "material" };
  let state = applyModelTurn(
    createInitialState(),
    turn({ facts: [{ ...fact, content: "매월 25일경", status: "pending_confirmation" }] }),
  );
  state = applyModelTurn(
    state,
    turn({ facts: [{ ...fact, content: "매월 마지막 영업일", status: "confirmed", source: "interview" }] }),
  );
  assert.equal(state.facts.length, 1);
  assert.equal(state.facts[0].content, "매월 마지막 영업일");
  assert.equal(state.facts[0].status, "confirmed");
});

test("counts upload requests per category and reports the limit", () => {
  const request = { requested: true, trigger: "a_repetition_unclear", search_suggestion: "최근 3개월 '정산' 메일" };
  let state = applyModelTurn(createInitialState(), turn({ upload_request: request }));
  assert.match(buildStateNote(state), /정기업무\(routine\): 진행중, 자료 업로드 요청 남은 횟수 1/);
  assert.doesNotMatch(buildStateNote(state), /한도 도달/);

  state = applyModelTurn(state, turn({ upload_request: request }));
  assert.equal(state.categories.routine.uploadRequests, 2);
  assert.match(buildStateNote(state), /한도 도달.*정기업무/);
});

test("does not mutate the previous state", () => {
  const initial = createInitialState();
  applyModelTurn(initial, turn());
  assert.equal(initial.turnCount, 0);
  assert.equal(initial.categories.routine.status, "not_started");
});
