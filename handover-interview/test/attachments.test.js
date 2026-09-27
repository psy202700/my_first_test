import { test } from "node:test";
import assert from "node:assert/strict";

import { AttachmentError, decodeEncodedWords, extractMsgText, parseEml, toContentBlocks } from "../lib/attachments.js";

const b64 = (text, encoding = "utf8") => Buffer.from(text, encoding).toString("base64");

test("decodes RFC 2047 encoded headers", () => {
  const encoded = `=?UTF-8?B?${b64("월간 정산보고")}?=`;
  assert.equal(decodeEncodedWords(encoded), "월간 정산보고");
});

test("parses a multipart .eml with base64 body and attachment name", () => {
  const eml = [
    `Subject: =?UTF-8?B?${b64("[정산] 3월 정산보고")}?=`,
    "From: kim@example.com",
    "To: finance@example.com",
    "Date: Tue, 25 Mar 2026 10:00:00 +0900",
    'Content-Type: multipart/mixed; boundary="XYZ"',
    "",
    "--XYZ",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64("재무팀 담당자님, 3월 정산보고 드립니다."),
    "--XYZ",
    'Content-Type: application/vnd.ms-excel; name="report.xlsx"',
    'Content-Disposition: attachment; filename="report.xlsx"',
    "Content-Transfer-Encoding: base64",
    "",
    "AAAA",
    "--XYZ--",
  ].join("\r\n");

  const text = parseEml(Buffer.from(eml));
  assert.match(text, /제목: \[정산\] 3월 정산보고/);
  assert.match(text, /보낸사람: kim@example.com/);
  assert.match(text, /첨부파일: report.xlsx/);
  assert.match(text, /3월 정산보고 드립니다/);
});

test("decodes quoted-printable html-only mail", () => {
  const html = Buffer.from("<p>매주 월요일 회의</p>", "utf8");
  const qp = [...html].map((b) => "=" + b.toString(16).toUpperCase().padStart(2, "0")).join("");
  const eml = ["Subject: test", "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: quoted-printable", "", qp].join("\n");
  assert.match(parseEml(Buffer.from(eml)), /매주 월요일 회의/);
});

test("extracts readable UTF-16 text from .msg binaries", () => {
  const body = Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0x00, 0x01]),
    Buffer.from("주간 보고 일정 안내 메일", "utf16le"),
    Buffer.from([0x00, 0x00, 0xff, 0xfe]),
  ]);
  assert.match(extractMsgText(body), /주간 보고 일정 안내 메일/);
});

test("converts files into the matching content blocks", () => {
  const pdf = toContentBlocks({ name: "계약서.pdf", data: b64("%PDF-1.4") });
  assert.equal(pdf.blocks[1].type, "document");
  const image = toContentBlocks({ name: "capture.PNG", data: b64("png") });
  assert.equal(image.blocks[1].source.media_type, "image/png");
  const pasted = toContentBlocks({ name: "#영업지원", text: "내일 보고 부탁해요" });
  assert.equal(pasted.blocks[0].text, "[첨부자료: #영업지원] (붙여넣은 텍스트)");
  const eucKr = toContentBlocks({ name: "memo.txt", data: Buffer.from([0xc1, 0xa4, 0xbb, 0xea]).toString("base64") });
  assert.equal(eucKr.blocks[1].text, "정산", "EUC-KR text files fall back from UTF-8");
});

test("rejects unsupported or empty files", () => {
  assert.throws(() => toContentBlocks({ name: "a.exe", data: b64("x") }), AttachmentError);
  assert.throws(() => toContentBlocks({ name: "a.txt", data: "" }), AttachmentError);
  assert.throws(() => toContentBlocks({ name: "p", text: "  " }), AttachmentError);
});
