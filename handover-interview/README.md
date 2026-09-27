# 인수인계 인터뷰 어시스턴트

퇴사자나 부서 이동자(전임자)를 인터뷰하고, 전임자가 올린 메일·메신저 자료를 함께 반영해서
다음 담당자가 업무 공백 없이 일을 넘겨받을 수 있는 **인수인계서**를 만드는 웹앱입니다.

## 실행

```bash
cd handover-interview
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # 또는 `ant auth login`으로 로그인한 프로필
npm start                             # http://127.0.0.1:8787
```

Node.js 20 이상이 필요합니다. 테스트는 `npm test`로 돌리며, 실제 API는 호출하지 않습니다.

| 환경변수 | 기본값 | 설명 |
|---|---|---|
| `CLAUDE_MODEL` | `claude-opus-5` | 사용할 모델 |
| `INTERVIEW_EFFORT` | `medium` | 인터뷰 턴의 effort. 대화 응답 속도를 우선합니다 |
| `DOCUMENT_EFFORT` | `high` | 인수인계서 생성 단계의 effort |
| `CLAUDE_FALLBACKS` | (켜짐) | 모델이 응답을 거절했을 때 서버 측 대체 모델로 다시 시도합니다. Bedrock·Vertex·Foundry에서는 `off`로 끕니다 |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | 서버 주소. 인터뷰 자료가 민감할 수 있어 기본값은 로컬 전용입니다 |
| `SESSION_DIR` | `data/sessions` | 인터뷰 세션(JSON) 저장 위치 |
| `TEMPLATE_PATH` | `templates/handover-template.md` | 인수인계서 템플릿 |

## 사용 흐름

1. 부서명, 전임자 이름, 인계할 업무, 후임자 이름을 입력하고 인터뷰를 시작합니다. 모두 비워 둬도 됩니다.
2. 어시스턴트가 한 번에 질문 하나씩 던집니다. 왼쪽 패널에서 8개 대분류 진행 상황, 지금 다루는 업무의
   5개 슬롯(누가/언제/어디서/어떻게/예외상황)이 채워졌는지, 지금까지 정리된 사실을 볼 수 있습니다.
3. 자료가 필요한 순간에는 노란 카드로 **왜 필요한지**와 **찾아볼 조건**을 안내합니다.
   `.eml`, `.msg`, `.pdf`, 캡처 이미지, 텍스트 파일을 올리거나 메일·메신저 내용을 복사해서 붙여넣을 수 있습니다.
4. 자료가 올라오면 어시스턴트는 거기서 뽑은 내용을 "~인 것 같은데 맞으실까요?"처럼 확인하는 형태로 되묻습니다.
5. 인터뷰가 끝나면 **인수인계서 생성**을 누릅니다. 문서가 실시간으로 작성되고, 다 되면 `.md`로 내려받을 수 있습니다.
   근거가 없는 칸은 `확인 필요`로 표시되고, 무엇을 누구에게 확인해야 하는지가 `[부록] AI 확인 필요 항목`에 모입니다.

## 진행 원칙이 구현된 위치

| 원칙 | 구현 |
|---|---|
| 1. 8개 대분류 순서, 사용자가 먼저 꺼낸 주제 우선 | `lib/prompts.js` 시스템 프롬프트, `lib/state.js`의 `CATEGORIES` |
| 2. 5개 슬롯 점검, 한 번에 질문 1개 | 프롬프트 + 응답 스키마의 `slots` 필드(왼쪽 패널에 표시) |
| 3. 자료 업로드 요청 조건 a~d, 대분류당 최대 2회 | 프롬프트가 요청 여부를 판단하고, 요청 횟수는 서버가 셉니다(`applyModelTurn`). 남은 횟수는 매 턴 `<interview_state>`로 모델에 전달됩니다 |
| 4. 자료에서 정보 추출 → 확인 루프, 민감정보 제외 | `lib/attachments.js`가 파일을 Claude 입력 형식으로 바꿉니다. 추출한 사실은 `pending_confirmation`으로 기록되고, 전임자가 확인하면 `confirmed`로 바뀝니다 |
| 5. 모호한 답변은 예시를 들어 다시 묻기 | 프롬프트 |
| 6. 대분류가 충분히 채워지면 다음으로 | 스키마의 `completed_categories` |
| 7. 마지막에 누락 점검 질문 1~2개 | `phase: final_check` |
| 8. 양식 기반 문서, 추측 금지, "확인 필요" 표시 | `buildDocumentRequest` + `templates/handover-template.md`. 인터뷰 단계부터 양식의 칸(KPI, 권한·계정, 이관 절차 등)을 채울 정보를 묻도록 프롬프트에 대분류별 확보 항목을 넣었습니다 |

## 구조

```
handover-interview/
├── server.js                  # HTTP 서버 (정적 파일 + JSON API)
├── lib/
│   ├── claude.js              # Claude API 호출 (구조화된 인터뷰 턴, 문서 스트리밍)
│   ├── interview.js           # 세션 저장, 턴 처리, 문서 생성
│   ├── prompts.js             # 시스템 프롬프트, 응답 JSON 스키마, 문서 작성 요청문
│   ├── state.js               # 대분류/슬롯/업로드 횟수 상태 (순수 함수)
│   └── attachments.js         # .eml/.msg/.pdf/이미지/텍스트 → Claude 입력 블록
├── public/                    # 화면 (바닐라 HTML/CSS/JS)
├── templates/handover-template.md
└── test/                      # node --test
```

### API

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/sessions` | `{meta: {predecessor, jobTitle, successor}}` → 세션을 만들고 첫 인사말까지 생성 |
| GET | `/api/sessions/:id` | 세션 조회 (대화 기록, 진행 상태, 생성된 문서) |
| POST | `/api/sessions/:id/turn` | `{text, attachments: [{name, data(base64)} \| {name, text}]}` → 다음 질문 |
| POST | `/api/sessions/:id/document` | 인수인계서 생성 (마크다운을 스트리밍으로 전송) |
| GET | `/api/sessions/:id/document.md` | 생성된 문서 다운로드 |

## 알아둘 점

- **데이터 처리**: 올린 자료와 대화 내용은 Claude API로 전송되고, 서버의 `data/sessions/`에 JSON으로 저장됩니다.
  첨부 원본도 함께 저장되므로 인터뷰가 끝나면 필요에 따라 삭제하세요. 로그인 기능이 없으니 여러 사람이 쓰는
  서버에 올릴 때는 앞단에 인증을 두어야 합니다.
- **.msg 파일**은 전용 파서 없이 본문 텍스트만 추려내므로 일부 글자가 깨질 수 있습니다. 결과가 이상하면
  PDF로 저장하거나 본문을 붙여넣어 주세요.
- 파일은 개당 10MB까지 올릴 수 있습니다.
- 인수인계서 양식은 `templates/handover-template.md`입니다. 파일을 고치면 다음 생성부터 바로 반영됩니다.
  양식의 칸을 바꿨다면 `lib/prompts.js`의 "대분류별로 확보해야 할 내용"도 함께 맞춰야 인터뷰에서 그 칸을 채울 정보를 묻습니다.
- 이해관계자 연락처는 업무용(회사 메일, 사무실·내선 번호, 업무 메신저)만 기록합니다. 개인 휴대전화 번호는 자료에 있어도 문서에 넣지 않습니다.
