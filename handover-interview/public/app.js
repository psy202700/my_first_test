const SESSION_KEY = "handover-interview:session-id";
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const SLOT_LABELS = { who: "누가", when: "언제", where: "어디서", how: "어떻게", exception: "예외상황", general: "일반" };
const STATUS_LABELS = { not_started: "미시작", in_progress: "진행중", done: "완료" };

const $ = (id) => document.getElementById(id);
const views = { start: $("start-view"), interview: $("interview-view"), document: $("document-view") };

let session = null;
let pendingAttachments = [];
let busy = false;

// ---------- helpers ----------

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function showView(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
  $("new-session").hidden = name === "start";
  $("make-document").hidden = name !== "interview";
  $("view-document").hidden = name !== "interview" || !session?.document;
}

function storeSessionId(id) {
  try {
    if (id) localStorage.setItem(SESSION_KEY, id);
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    // Storage may be unavailable (private mode); the session simply won't resume on reload.
  }
}

function readSessionId() {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `요청 실패 (${response.status})`);
  return body;
}

function setBusy(value) {
  busy = value;
  $("send-button").disabled = value;
  $("make-document").disabled = value;
  $("typing")?.remove();
  if (value) {
    const typing = document.createElement("div");
    typing.id = "typing";
    typing.className = "message assistant typing";
    typing.textContent = "답변을 정리하고 있습니다…";
    $("messages").append(typing);
    typing.scrollIntoView({ block: "end" });
  }
}

function showError(message) {
  const banner = document.createElement("div");
  banner.className = "error-banner";
  banner.textContent = message;
  $("messages").append(banner);
  banner.scrollIntoView({ block: "end" });
}

// ---------- rendering ----------

function renderProgress() {
  const { state, categories } = session;
  $("category-list").innerHTML = categories
    .map(({ id, label }) => {
      const c = state.categories[id];
      const current = id === state.currentCategory ? "current" : "";
      return `<li class="${current}"><span>${escapeHtml(label)}</span><span class="badge ${c.status}">${STATUS_LABELS[c.status]}</span></li>`;
    })
    .join("");

  $("current-topic").textContent = state.currentTopic || "-";
  $("slot-list").innerHTML = state.currentTopic
    ? Object.entries(state.slots)
        .map(([slot, status]) => `<li class="${status}">${SLOT_LABELS[slot]}</li>`)
        .join("")
    : "";

  $("fact-count").textContent = state.facts.length;
  $("fact-list").innerHTML = categories
    .map(({ id, label }) => {
      const facts = state.facts.filter((f) => f.category === id);
      if (!facts.length) return "";
      const items = facts
        .map((f) => {
          const pending = f.status === "pending_confirmation" ? ' <span class="fact-pending">(확인 대기)</span>' : "";
          return `<li><b>${escapeHtml(f.topic)}</b> · ${SLOT_LABELS[f.slot]}: ${escapeHtml(f.content)}${pending}</li>`;
        })
        .join("");
      return `<div class="fact-group"><h4>${escapeHtml(label)}</h4><ul>${items}</ul></div>`;
    })
    .join("");
}

function renderMessage(entry) {
  const el = document.createElement("div");
  el.className = `message ${entry.role}`;

  if (entry.role === "user") {
    el.textContent = entry.text;
    if (entry.attachments?.length) {
      const chips = document.createElement("div");
      chips.className = "chips";
      chips.innerHTML = entry.attachments
        .map((a) => `<span class="chip">${escapeHtml(a.kind)} · ${escapeHtml(a.name)}</span>`)
        .join("");
      el.append(chips);
    }
    return el;
  }

  const category = session.categories.find((c) => c.id === entry.category);
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = category ? category.label : "";
  el.append(meta, document.createTextNode(entry.text));

  if (entry.uploadRequest) {
    el.classList.add("upload");
    const hint = document.createElement("div");
    hint.className = "upload-hint";
    hint.innerHTML = `
      ${entry.uploadRequest.search_suggestion ? `<div><b>찾아보실 자료</b>: ${escapeHtml(entry.uploadRequest.search_suggestion)}</div>` : ""}
      <div class="muted">.eml · .msg · .pdf · 캡처 이미지 · 복사한 텍스트 모두 가능합니다. 해당 업무 관련 자료만 올려 주세요.</div>
      <div class="hint-actions">
        <button type="button" data-action="file">파일 첨부</button>
        <button type="button" data-action="paste" class="ghost">텍스트 붙여넣기</button>
        <button type="button" data-action="none" class="ghost">관련 자료가 없어요</button>
      </div>`;
    hint.addEventListener("click", (event) => {
      const action = event.target.dataset?.action;
      if (action === "file") $("file-input").click();
      if (action === "paste") togglePasteBox(true);
      if (action === "none") {
        $("message-input").value = "관련 자료는 따로 찾기 어렵습니다. 대화로 설명드릴게요.";
        $("message-input").focus();
      }
    });
    el.append(hint);
  }
  return el;
}

function renderSession() {
  $("messages").replaceChildren(...session.transcript.map(renderMessage));
  renderProgress();
  $("make-document").textContent = session.document ? "인수인계서 다시 생성" : "인수인계서 생성";
  $("view-document").hidden = !session.document;
  $("messages").lastElementChild?.scrollIntoView({ block: "end" });
}

function renderPendingAttachments() {
  $("pending-attachments").innerHTML = pendingAttachments
    .map((a, i) => `<span class="chip">${escapeHtml(a.name)}<button type="button" data-index="${i}" aria-label="삭제">×</button></span>`)
    .join("");
}

// ---------- markdown (headings, lists, tables, bold) ----------

function inlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/확인 필요/g, "<mark>확인 필요</mark>");
}

function renderMarkdown(markdown) {
  const lines = markdown.split("\n");
  const html = [];
  let list = null;
  const closeList = () => {
    if (list) html.push(`</${list}>`);
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const tableRow = /^\s*\|.*\|\s*$/;
    if (tableRow.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      closeList();
      const cells = (row) => row.trim().slice(1, -1).split("|").map((c) => inlineMarkdown(c.trim()));
      html.push("<table><thead><tr>", ...cells(line).map((c) => `<th>${c}</th>`), "</tr></thead><tbody>");
      i += 2;
      while (i < lines.length && tableRow.test(lines[i])) {
        html.push("<tr>", ...cells(lines[i]).map((c) => `<td>${c}</td>`), "</tr>");
        i++;
      }
      i--;
      html.push("</tbody></table>");
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      html.push(`<h${heading[1].length}>${inlineMarkdown(heading[2])}</h${heading[1].length}>`);
    } else if (bullet || numbered) {
      const type = bullet ? "ul" : "ol";
      if (list !== type) {
        closeList();
        html.push(`<${type}>`);
        list = type;
      }
      html.push(`<li>${inlineMarkdown((bullet ?? numbered)[1])}</li>`);
    } else if (line.trim() === "") {
      closeList();
    } else {
      closeList();
      html.push(`<p>${inlineMarkdown(line)}</p>`);
    }
  }
  closeList();
  return html.join("");
}

// ---------- actions ----------

async function loadSession(id) {
  try {
    session = await api(`/api/sessions/${id}`);
    showView("interview");
    renderSession();
  } catch {
    storeSessionId(null);
    showView("start");
  }
}

$("start-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.target.querySelector("button");
  button.disabled = true;
  button.textContent = "준비 중…";
  try {
    const meta = Object.fromEntries(new FormData(event.target));
    session = await api("/api/sessions", { method: "POST", body: JSON.stringify({ meta }) });
    storeSessionId(session.id);
    showView("interview");
    renderSession();
    $("message-input").focus();
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "인터뷰 시작";
  }
});

$("composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  const text = $("message-input").value.trim();
  if (!text && pendingAttachments.length === 0) return;

  const attachments = pendingAttachments;
  const optimistic = { role: "user", text, attachments: attachments.map((a) => ({ name: a.name, kind: "자료" })) };
  $("messages").append(renderMessage(optimistic));
  $("message-input").value = "";
  pendingAttachments = [];
  renderPendingAttachments();
  setBusy(true);

  try {
    session = await api(`/api/sessions/${session.id}/turn`, {
      method: "POST",
      body: JSON.stringify({ text, attachments }),
    });
    setBusy(false);
    renderSession();
  } catch (error) {
    setBusy(false);
    // Put the unsent input back so nothing typed is lost.
    $("messages").lastElementChild?.remove();
    $("message-input").value = text;
    pendingAttachments = attachments;
    renderPendingAttachments();
    showError(error.message);
  }
});

$("message-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("composer").requestSubmit();
  }
});

$("file-input").addEventListener("change", async (event) => {
  for (const file of event.target.files) {
    if (file.size > MAX_FILE_BYTES) {
      showError(`${file.name}: 파일당 10MB까지 올릴 수 있습니다.`);
      continue;
    }
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    pendingAttachments.push({ name: file.name, type: file.type, data });
  }
  event.target.value = "";
  renderPendingAttachments();
});

$("pending-attachments").addEventListener("click", (event) => {
  const index = event.target.dataset?.index;
  if (index === undefined) return;
  pendingAttachments.splice(Number(index), 1);
  renderPendingAttachments();
});

function togglePasteBox(open) {
  $("paste-box").hidden = !open;
  if (open) $("paste-text").focus();
}

$("paste-toggle").addEventListener("click", () => togglePasteBox($("paste-box").hidden));
$("paste-cancel").addEventListener("click", () => togglePasteBox(false));
$("paste-add").addEventListener("click", () => {
  const text = $("paste-text").value.trim();
  if (!text) return;
  const name = $("paste-title").value.trim() || `붙여넣은 자료 ${pendingAttachments.length + 1}`;
  pendingAttachments.push({ name, text });
  $("paste-text").value = "";
  $("paste-title").value = "";
  togglePasteBox(false);
  renderPendingAttachments();
});

function showDocument(markdown, status) {
  const body = $("document-body");
  body.classList.remove("streaming");
  body.innerHTML = renderMarkdown(markdown);
  $("document-status").textContent = status;
  $("download-document").href = `/api/sessions/${session.id}/document.md`;
  $("download-document").hidden = false;
  $("copy-document").hidden = false;
}

$("make-document").addEventListener("click", async () => {
  if (busy) return;
  const unfinished = session.state.phase !== "ready_for_document";
  if (unfinished && !confirm("인터뷰가 아직 끝나지 않았습니다. 지금까지의 내용으로 인수인계서를 만들까요?\n(비어 있는 항목은 '확인 필요'로 표시됩니다)")) {
    return;
  }

  busy = true;
  showView("document");
  $("new-session").hidden = false;
  const body = $("document-body");
  body.classList.add("streaming");
  body.textContent = "";
  $("document-status").textContent = "인수인계서를 작성하고 있습니다…";
  $("download-document").hidden = true;
  $("copy-document").hidden = true;

  try {
    const response = await fetch(`/api/sessions/${session.id}/document`, { method: "POST" });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error ?? `요청 실패 (${response.status})`);
    }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let streamed = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      streamed += value;
      body.textContent = streamed;
    }
    if (streamed.includes("[[ERROR]]")) throw new Error("문서 생성 중 오류가 발생했습니다. 다시 시도해 주세요.");
    session = await api(`/api/sessions/${session.id}`);
    showDocument(session.document.markdown, "작성 완료 · 내용을 검토하고 '확인 필요' 항목을 채워 주세요.");
  } catch (error) {
    body.classList.remove("streaming");
    $("document-status").textContent = error.message;
  } finally {
    busy = false;
  }
});

$("view-document").addEventListener("click", () => {
  showView("document");
  $("new-session").hidden = false;
  showDocument(session.document.markdown, `작성일시 ${new Date(session.document.createdAt).toLocaleString("ko-KR")}`);
});

$("back-to-chat").addEventListener("click", () => {
  showView("interview");
  renderSession();
});

$("copy-document").addEventListener("click", async () => {
  await navigator.clipboard.writeText(session.document?.markdown ?? "");
  $("document-status").textContent = "마크다운을 복사했습니다.";
});

$("new-session").addEventListener("click", () => {
  if (!confirm("새 인터뷰를 시작할까요? 현재 인터뷰는 서버에 저장되어 있지만 이 화면에서는 닫힙니다.")) return;
  storeSessionId(null);
  session = null;
  pendingAttachments = [];
  renderPendingAttachments();
  showView("start");
});

const savedId = readSessionId();
if (savedId) loadSession(savedId);
else showView("start");
