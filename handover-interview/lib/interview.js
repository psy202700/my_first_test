import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";

import { toContentBlocks } from "./attachments.js";
import {
  INTERVIEW_SYSTEM_PROMPT,
  INTERVIEW_TURN_SCHEMA,
  buildDocumentRequest,
  buildOpeningMessage,
} from "./prompts.js";
import { CATEGORIES, applyModelTurn, buildStateNote, createInitialState } from "./state.js";

const SESSION_ID_PATTERN = /^[0-9a-f-]{36}$/;

export class InputError extends Error {}

export class SessionStore {
  constructor(directory) {
    this.directory = directory;
  }

  #file(id) {
    if (!SESSION_ID_PATTERN.test(id)) throw new InputError("잘못된 세션 ID입니다.");
    return path.join(this.directory, `${id}.json`);
  }

  async get(id) {
    try {
      return JSON.parse(await readFile(this.#file(id), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async save(session) {
    await mkdir(this.directory, { recursive: true });
    const file = this.#file(session.id);
    const temp = `${file}.tmp`;
    await writeFile(temp, JSON.stringify(session));
    await rename(temp, file);
  }
}

export function publicView(session) {
  return {
    id: session.id,
    meta: session.meta,
    transcript: session.transcript,
    state: session.state,
    document: session.document,
    categories: CATEGORIES,
  };
}

function cleanMeta(meta = {}) {
  const field = (value) => String(value ?? "").trim().slice(0, 200);
  return {
    department: field(meta.department),
    predecessor: field(meta.predecessor),
    jobTitle: field(meta.jobTitle),
    successor: field(meta.successor),
  };
}

async function runTurn(session, llm, { text, attachments, hidden = false }) {
  attachments = Array.isArray(attachments) ? attachments : [];
  const userText = String(text ?? "").trim();
  if (!userText && attachments.length === 0) {
    throw new InputError("메시지를 입력하거나 자료를 첨부해 주세요.");
  }

  const converted = attachments.map(toContentBlocks);
  const content = [
    ...converted.flatMap((c) => c.blocks),
    { type: "text", text: userText || "(자료를 첨부했습니다.)" },
    { type: "text", text: buildStateNote(session.state) },
  ];
  const messages = [...session.apiMessages, { role: "user", content }];

  const { content: assistantContent, output } = await llm.interviewTurn({
    system: INTERVIEW_SYSTEM_PROMPT,
    messages,
    schema: INTERVIEW_TURN_SCHEMA,
  });

  const now = new Date().toISOString();
  session.apiMessages = [...messages, { role: "assistant", content: assistantContent }];
  session.state = applyModelTurn(session.state, output);
  if (!hidden) {
    session.transcript.push({
      role: "user",
      text: userText,
      attachments: converted.map((c) => c.summary),
      at: now,
    });
  }
  session.transcript.push({
    role: "assistant",
    text: output.reply,
    turnType: output.turn_type,
    category: output.current_category,
    uploadRequest: output.upload_request.requested ? output.upload_request : null,
    at: now,
  });
  session.updatedAt = now;
}

export function createInterviewService({ llm, store, readTemplate }) {
  const busy = new Set();

  async function withSession(id, work) {
    if (busy.has(id)) throw new InputError("이전 요청을 처리하는 중입니다. 잠시 후 다시 시도해 주세요.");
    busy.add(id);
    try {
      const session = await store.get(id);
      if (!session) throw new InputError("세션을 찾을 수 없습니다.");
      return await work(session);
    } finally {
      busy.delete(id);
    }
  }

  return {
    async createSession(rawMeta) {
      const meta = cleanMeta(rawMeta);
      const now = new Date().toISOString();
      const session = {
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
        meta,
        apiMessages: [],
        transcript: [],
        state: createInitialState(),
        document: null,
      };
      await runTurn(session, llm, { text: buildOpeningMessage(meta), hidden: true });
      await store.save(session);
      return publicView(session);
    },

    async getSession(id) {
      const session = await store.get(id);
      return session ? publicView(session) : null;
    },

    async sendMessage(id, { text, attachments }) {
      return withSession(id, async (session) => {
        await runTurn(session, llm, { text, attachments });
        await store.save(session);
        return publicView(session);
      });
    },

    async generateDocument(id, onText) {
      return withSession(id, async (session) => {
        if (session.transcript.filter((t) => t.role === "user").length === 0) {
          throw new InputError("아직 인터뷰 답변이 없어 인수인계서를 만들 수 없습니다.");
        }
        const request = buildDocumentRequest({
          template: await readTemplate(),
          facts: session.state.facts,
          meta: session.meta,
          today: new Date().toISOString().slice(0, 10),
        });
        // Not saved into apiMessages: the interview can continue and the document be regenerated.
        const markdown = await llm.streamDocument({
          system: INTERVIEW_SYSTEM_PROMPT,
          messages: [...session.apiMessages, { role: "user", content: request }],
          onText,
        });
        session.document = { markdown, createdAt: new Date().toISOString() };
        await store.save(session);
        return session.document;
      });
    },
  };
}
