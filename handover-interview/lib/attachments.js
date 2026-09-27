// Converts uploaded materials (.eml, .msg, .pdf, images, text) into Claude content blocks.

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

const IMAGE_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
const TEXT_EXTENSIONS = new Set(["txt", "md", "csv", "tsv", "json", "log", "html", "htm", "xml"]);

export class AttachmentError extends Error {}

function extensionOf(name) {
  const match = /\.([a-z0-9]+)$/i.exec(name ?? "");
  return match ? match[1].toLowerCase() : "";
}

function decodeBytes(bytes, charset = "utf-8") {
  try {
    return new TextDecoder(charset.toLowerCase()).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

// Korean text files are sometimes saved as EUC-KR/CP949.
function decodeTextFile(bytes) {
  const utf8 = new TextDecoder("utf-8").decode(bytes);
  if (!utf8.includes("�")) return utf8;
  const euckr = decodeBytes(bytes, "euc-kr");
  return euckr.includes("�") ? utf8 : euckr;
}

function stripHtml(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------- .eml (MIME) ----------

function decodeQuotedPrintable(text) {
  const bytes = [];
  const source = text.replace(/=\r?\n/g, "");
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(source.slice(i + 1, i + 3))) {
      bytes.push(parseInt(source.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(source.charCodeAt(i) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

export function decodeEncodedWords(value) {
  return value
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, encoding, data) => {
      const bytes =
        encoding.toUpperCase() === "B"
          ? Buffer.from(data, "base64")
          : decodeQuotedPrintable(data.replace(/_/g, " "));
      return decodeBytes(bytes, charset);
    });
}

function parseHeaders(block) {
  const headers = {};
  const unfolded = block.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return headers;
}

function headerParam(value, param) {
  const match = new RegExp(`${param}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i").exec(value ?? "");
  return match ? (match[1] ?? match[2]) : undefined;
}

// `raw` is a binary ("latin1") string so byte values survive until charset decoding.
function parseMimePart(raw, result) {
  const split = /\r?\n\r?\n/.exec(raw);
  const headerBlock = split ? raw.slice(0, split.index) : raw;
  const body = split ? raw.slice(split.index + split[0].length) : "";
  const headers = parseHeaders(headerBlock);
  const contentType = (headers["content-type"] ?? "text/plain").toLowerCase();
  const disposition = headers["content-disposition"] ?? "";
  const filename =
    headerParam(disposition, "filename") ?? headerParam(headers["content-type"], "name");

  if (contentType.startsWith("multipart/")) {
    const boundary = headerParam(headers["content-type"], "boundary");
    if (!boundary) return headers;
    const parts = body.split(`--${boundary}`);
    for (const part of parts.slice(1)) {
      if (part.startsWith("--")) break;
      parseMimePart(part.replace(/^\r?\n/, ""), result);
    }
    return headers;
  }

  if (filename && /attachment/i.test(disposition)) {
    result.attachmentNames.push(decodeEncodedWords(filename));
    return headers;
  }

  const encoding = (headers["content-transfer-encoding"] ?? "").toLowerCase();
  const bytes =
    encoding === "base64"
      ? Buffer.from(body.replace(/\s+/g, ""), "base64")
      : encoding === "quoted-printable"
        ? decodeQuotedPrintable(body)
        : Buffer.from(body, "latin1");
  const text = decodeBytes(bytes, headerParam(headers["content-type"], "charset") ?? "utf-8");

  if (contentType.startsWith("text/plain")) result.plain.push(text);
  else if (contentType.startsWith("text/html")) result.html.push(text);
  else if (filename) result.attachmentNames.push(decodeEncodedWords(filename));
  return headers;
}

export function parseEml(buffer) {
  const result = { plain: [], html: [], attachmentNames: [] };
  const headers = parseMimePart(buffer.toString("latin1"), result);
  const header = (name) => (headers[name] ? decodeEncodedWords(headers[name]) : "");
  const body = result.plain.length
    ? result.plain.join("\n\n")
    : result.html.map(stripHtml).join("\n\n");

  return [
    `제목: ${header("subject")}`,
    `보낸사람: ${header("from")}`,
    `받는사람: ${header("to")}`,
    header("cc") ? `참조: ${header("cc")}` : null,
    `날짜: ${header("date")}`,
    result.attachmentNames.length ? `첨부파일: ${result.attachmentNames.join(", ")}` : null,
    "",
    body.trim(),
  ]
    .filter((line) => line !== null)
    .join("\n");
}

// ---------- .msg (Outlook, best effort) ----------

// .msg is an OLE compound file; without a parser we pull readable UTF-16LE runs,
// which covers subject/body/recipients in most messages.
export function extractMsgText(buffer) {
  const evenLength = buffer.length - (buffer.length % 2);
  const text = buffer.subarray(0, evenLength).toString("utf16le");
  const runs = text.match(/[\p{L}\p{N}\p{P}\p{Zs}\r\n\t<>=+~$^|`]{6,}/gu) ?? [];
  const seen = new Set();
  const unique = [];
  for (const run of runs) {
    const trimmed = run.trim();
    if (trimmed.length < 6 || seen.has(trimmed)) continue;
    // Skip runs that are mostly unrelated CJK noise from binary data.
    const hangulOrAscii = trimmed.match(/[가-힣 -~\s]/g)?.length ?? 0;
    if (hangulOrAscii / trimmed.length < 0.8) continue;
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique.join("\n");
}

// ---------- entry point ----------

/**
 * @param {{name: string, type?: string, data?: string, text?: string}} item
 *   `data` is base64 file content; `text` is pasted text (from mail/messenger).
 * @returns {{blocks: object[], summary: {name: string, kind: string}}}
 */
export function toContentBlocks(item) {
  const name = (item.name || "붙여넣은 자료").slice(0, 200);
  const label = (kind) => ({ type: "text", text: `[첨부자료: ${name}] (${kind})` });

  if (typeof item.text === "string") {
    if (!item.text.trim()) throw new AttachmentError("붙여넣은 내용이 비어 있습니다.");
    return {
      blocks: [label("붙여넣은 텍스트"), { type: "text", text: item.text }],
      summary: { name, kind: "텍스트" },
    };
  }

  const buffer = Buffer.from(item.data ?? "", "base64");
  if (!buffer.length) throw new AttachmentError(`${name}: 파일 내용이 비어 있습니다.`);
  if (buffer.length > MAX_FILE_BYTES) {
    throw new AttachmentError(`${name}: 파일당 10MB까지 올릴 수 있습니다. 관련 부분만 발췌해 주세요.`);
  }

  const ext = extensionOf(name);
  if (IMAGE_TYPES[ext]) {
    return {
      blocks: [
        label("캡처 이미지"),
        {
          type: "image",
          source: { type: "base64", media_type: IMAGE_TYPES[ext], data: buffer.toString("base64") },
        },
      ],
      summary: { name, kind: "이미지" },
    };
  }
  if (ext === "pdf") {
    return {
      blocks: [
        label("PDF"),
        {
          type: "document",
          title: name,
          source: { type: "base64", media_type: "application/pdf", data: buffer.toString("base64") },
        },
      ],
      summary: { name, kind: "PDF" },
    };
  }
  if (ext === "eml") {
    return {
      blocks: [label("메일 .eml"), { type: "text", text: parseEml(buffer) }],
      summary: { name, kind: "메일" },
    };
  }
  if (ext === "msg") {
    const text = extractMsgText(buffer);
    if (!text) {
      throw new AttachmentError(`${name}: .msg 파일에서 내용을 읽지 못했습니다. PDF로 저장하거나 본문을 붙여넣어 주세요.`);
    }
    return {
      blocks: [
        label("메일 .msg, 텍스트 자동 추출본이라 일부 깨진 문자가 있을 수 있음"),
        { type: "text", text },
      ],
      summary: { name, kind: "메일" },
    };
  }
  if (TEXT_EXTENSIONS.has(ext)) {
    const raw = decodeTextFile(buffer);
    const text = ext === "html" || ext === "htm" ? stripHtml(raw) : raw;
    return {
      blocks: [label(`${ext} 파일`), { type: "text", text }],
      summary: { name, kind: "텍스트" },
    };
  }
  throw new AttachmentError(
    `${name}: 지원하지 않는 형식입니다. .eml, .msg, .pdf, 이미지(png/jpg), 텍스트 파일 또는 붙여넣기를 이용해 주세요.`,
  );
}
