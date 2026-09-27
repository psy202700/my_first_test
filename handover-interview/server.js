import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AttachmentError } from "./lib/attachments.js";
import { InputError, SessionStore, createInterviewService } from "./lib/interview.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, "public");
const MAX_BODY_BYTES = 40 * 1024 * 1024;
const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new InputError("요청이 너무 큽니다. 자료를 나눠서 올려 주세요.");
    chunks.push(chunk);
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  } catch {
    throw new InputError("요청 형식이 올바르지 않습니다.");
  }
}

async function serveStatic(res, urlPath) {
  const relative = urlPath === "/" ? "index.html" : urlPath.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, relative));
  const type = STATIC_TYPES[path.extname(file)];
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !type) return false;
  try {
    const content = await readFile(file);
    res.writeHead(200, { "content-type": type });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

function isClientError(error) {
  return error instanceof InputError || error instanceof AttachmentError;
}

export function createApp({ llm, sessionDir, templatePath }) {
  const service = createInterviewService({
    llm,
    store: new SessionStore(sessionDir),
    readTemplate: () => readFile(templatePath, "utf8"),
  });

  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const sessionMatch = /^\/api\/sessions\/([^/]+)(\/turn|\/document|\/document\.md)?$/.exec(
      url.pathname,
    );

    try {
      if (req.method === "POST" && url.pathname === "/api/sessions") {
        const body = await readJsonBody(req);
        return sendJson(res, 201, await service.createSession(body.meta));
      }

      if (sessionMatch) {
        const [, id, action] = sessionMatch;

        if (req.method === "GET" && !action) {
          const session = await service.getSession(id);
          return session
            ? sendJson(res, 200, session)
            : sendJson(res, 404, { error: "세션을 찾을 수 없습니다." });
        }

        if (req.method === "POST" && action === "/turn") {
          const body = await readJsonBody(req);
          return sendJson(res, 200, await service.sendMessage(id, body));
        }

        if (req.method === "GET" && action === "/document.md") {
          const session = await service.getSession(id);
          if (!session?.document) return sendJson(res, 404, { error: "생성된 인수인계서가 없습니다." });
          res.writeHead(200, {
            "content-type": "text/markdown; charset=utf-8",
            "content-disposition": `attachment; filename="handover-${id.slice(0, 8)}.md"`,
          });
          return res.end(session.document.markdown);
        }

        if (req.method === "POST" && action === "/document") {
          // Streams markdown as plain text; errors after streaming starts are appended as a marker line.
          let started = false;
          try {
            await service.generateDocument(id, (text) => {
              if (!started) {
                res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
                started = true;
              }
              res.write(text);
            });
            if (!started) res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
            return res.end();
          } catch (error) {
            if (!started) throw error;
            console.error(error);
            return res.end("\n\n[[ERROR]] 문서 생성 중 오류가 발생했습니다. 다시 시도해 주세요.");
          }
        }
      }

      if (req.method === "GET" && (await serveStatic(res, url.pathname))) return;
      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      if (isClientError(error) || error.name === "ModelOutputError") {
        return sendJson(res, 400, { error: error.message });
      }
      console.error(error);
      if (error.status === 401) {
        return sendJson(res, 500, { error: "Claude API 인증에 실패했습니다. 서버의 ANTHROPIC_API_KEY를 확인해 주세요." });
      }
      sendJson(res, 500, { error: "서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요." });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { createClaudeClient } = await import("./lib/claude.js");
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || "127.0.0.1";
  createApp({
    llm: createClaudeClient(),
    sessionDir: process.env.SESSION_DIR || path.join(here, "data", "sessions"),
    templatePath: process.env.TEMPLATE_PATH || path.join(here, "templates", "handover-template.md"),
  }).listen(port, host, () => {
    console.log(`인수인계 인터뷰 서버: http://${host}:${port}`);
  });
}
