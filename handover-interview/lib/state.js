// Interview progress state. Pure functions so they can be tested without the API.

export const CATEGORIES = [
  { id: "overview", label: "업무개요" },
  { id: "routine", label: "정기업무" },
  { id: "projects", label: "진행프로젝트" },
  { id: "stakeholders", label: "이해관계자" },
  { id: "docs_systems", label: "문서·시스템" },
  { id: "risks", label: "리스크·이슈" },
  { id: "tacit", label: "암묵지" },
  { id: "wrapup", label: "마무리" },
];

export const CATEGORY_IDS = CATEGORIES.map((c) => c.id);
export const SLOT_IDS = ["who", "when", "where", "how", "exception"];
export const SLOT_LABELS = {
  who: "누가",
  when: "언제",
  where: "어디서",
  how: "어떻게",
  exception: "예외상황",
  general: "일반",
};
export const MAX_UPLOAD_REQUESTS_PER_CATEGORY = 2;

export function categoryLabel(id) {
  return CATEGORIES.find((c) => c.id === id)?.label ?? id;
}

export function createInitialState() {
  const categories = {};
  for (const id of CATEGORY_IDS) {
    categories[id] = { status: "not_started", uploadRequests: 0 };
  }
  return {
    phase: "interview",
    currentCategory: null,
    currentTopic: "",
    slots: Object.fromEntries(SLOT_IDS.map((s) => [s, "missing"])),
    categories,
    facts: [],
    turnCount: 0,
  };
}

function factKey(fact) {
  return `${fact.category}|${fact.topic.trim()}|${fact.slot}`;
}

// Merges one structured model turn into the state. Returns a new state object.
export function applyModelTurn(prev, turn) {
  const state = structuredClone(prev);
  state.turnCount += 1;

  const current = CATEGORY_IDS.includes(turn.current_category)
    ? turn.current_category
    : state.currentCategory;
  state.currentCategory = current;
  state.currentTopic = turn.current_topic ?? "";
  state.slots = { ...state.slots, ...turn.slots };

  if (current && state.categories[current].status === "not_started") {
    state.categories[current].status = "in_progress";
  }
  for (const id of turn.completed_categories ?? []) {
    if (state.categories[id]) state.categories[id].status = "done";
  }

  if (turn.upload_request?.requested && current) {
    state.categories[current].uploadRequests += 1;
  }

  // Later statements about the same category/topic/slot replace earlier ones (corrections).
  for (const fact of turn.facts ?? []) {
    if (!fact.content?.trim()) continue;
    const key = factKey(fact);
    const index = state.facts.findIndex((f) => factKey(f) === key);
    const entry = { ...fact, updatedAtTurn: state.turnCount };
    if (index >= 0) state.facts[index] = entry;
    else state.facts.push(entry);
  }

  if (["interview", "final_check", "ready_for_document"].includes(turn.phase)) {
    state.phase = turn.phase;
  }
  return state;
}

// Short progress note appended to every user turn so the model sees authoritative
// counters (e.g. upload-request limits) instead of recounting the transcript.
export function buildStateNote(state) {
  const lines = CATEGORIES.map(({ id, label }) => {
    const c = state.categories[id];
    const remaining = Math.max(0, MAX_UPLOAD_REQUESTS_PER_CATEGORY - c.uploadRequests);
    const status = { not_started: "미시작", in_progress: "진행중", done: "완료" }[c.status];
    return `- ${label}(${id}): ${status}, 자료 업로드 요청 남은 횟수 ${remaining}`;
  });
  const exhausted = CATEGORIES.filter(
    ({ id }) => state.categories[id].uploadRequests >= MAX_UPLOAD_REQUESTS_PER_CATEGORY,
  ).map((c) => c.label);

  return [
    "<interview_state>",
    `현재 대분류: ${state.currentCategory ? categoryLabel(state.currentCategory) : "(아직 없음)"}`,
    `현재 주제: ${state.currentTopic || "(없음)"}`,
    `진행 단계: ${state.phase}`,
    ...lines,
    exhausted.length
      ? `업로드 요청 한도 도달(이 대분류에서는 더 이상 자료 업로드를 요청하지 말 것): ${exhausted.join(", ")}`
      : "",
    "</interview_state>",
  ]
    .filter(Boolean)
    .join("\n");
}
