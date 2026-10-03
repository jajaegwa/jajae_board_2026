# AGENTS.md — 자재과 작업판 작업 지침 (GPT·Codex·Claude 공용)

이 파일은 Claude와 작업하며 쌓인 프로젝트 지식을 다른 AI(ChatGPT·Codex 등)도 같이 쓰도록 정리한 것입니다.
Codex는 이 파일을 자동으로 읽습니다. ChatGPT에서는 프로젝트 "지침"에 이 내용을 붙여넣으면 됩니다.
**이 저장소는 GitHub Pages로 공개되므로 비밀번호·PIN·API 키·개인 이름은 여기에 쓰지 마세요.**

## 프로젝트 개요

- 현대L&C 세종공장 자재과의 통합 작업판. 입고·창고→라인 이동·발주·사급을 한 화면에서 관리하고,
  지게차 기사는 `#driver` 화면으로 봄.
- 운영 소스는 이 저장소(GitHub Pages + Supabase 실시간 공유)가 기준. Downloads 폴더의
  `자재과_작업판.html`·claude.ai 아티팩트 판은 2026-08 구버전이므로 수정 기준으로 쓰지 말 것.
- 파일: `index.html`(작업판 전체, 1.5MB 단일 파일) · `magam.html`(월마감) · `sales-match-engine.js`(매각 대조) ·
  `ui-helpers.js` · `sw.js`(서비스워커·푸시) · `supabase/functions/`(Edge Function: `notify-drivers` 푸시, `ai-chat` AI 질문).
- 탭: 현황 · 캘린더 · 배합실 요청 · 발주·입고 · 사급발주 · 기준정보 · 통계 · 원료 예측 · 삭제기록.
- 데이터: 전역 `S={moves,orders,cons,specials,notes,trash,log,seq,invHist,fcPlan,inv}`, 기준정보 `M`(`M.rop` 발주점 표 등).
  공유 비밀번호는 localStorage `jjPass`, 기기별 사용자 이름은 `jjUser`.

## 작업 규칙

- **PR 전 코드리뷰 필수**: 변경 diff를 정확성 버그 + 재사용/단순화/효율 관점으로 자체 검토하고 고친 뒤 PR.
- 디자인은 `DESIGN.md`를 따름: 평평한 ERP 스타일, 2px 모서리, 그림자·그라데이션·웹폰트 금지,
  상태 칩은 외곽선만, CSS 변수 이름 변경 금지, 표는 모든 칸 테두리.
- 화면을 바꾸면 헤더의 `buildStamp`(화면 버전 vYYYY-MM-DDx)를 올릴 것.
- 이 PC에는 Node·Python이 없음 → `*.test.cjs`는 브라우저에서 node:test 흉내 shim으로 실행,
  정적 서버는 PowerShell `HttpListener`. 새 브라우저 프로필(jjPass 없음)은 샘플 데이터·로컬 모드라 서버 데이터가 안 바뀜.

## 코드에서 반드시 지킬 것 (과거 버그에서 나온 교훈)

- **날짜는 `localISO()` 사용.** `toISOString().slice(0,10)`은 UTC라 한국 시간에서 하루 밀림.
- **`confirm()`/`prompt()`/`alert()` 금지.** 임베드 환경에서 조용히 무시돼 삭제가 안 되던 사고가 있었음.
  상태 변경은 `showUndo()`(결과+되돌리기), 되돌릴 수 없는 삭제만 두 번 탭(`armDel`), 입력은 `openDlg()` 다이얼로그.
- 지게차 화면(`body.driver`)에서는 header의 button이 CSS로 숨겨짐 — 관리 기능 진입은 `<a>`가 아니라 button으로 만들 것.
- 비밀값(VAPID 개인키, 구독핀 API 키 등)은 Supabase Edge Function Secrets에만. `index.html`에 넣으면 공개됨.
- 미등록 품목은 파레트↔kg 자동 환산 금지.

## 자재과 운영 규칙 (사용자 확정, 2026-08 기준 — 코드와 다르면 코드·사용자 확인 우선)

- 부서별 품목은 섞이면 안 됨(M창고→P창고 부서별 이동). 부서 순서: 경질 → 창호 → 타일 → DBP.
  - 특이사항 발주: 경질[P-1000·P-800·DOTP(드럼)·TIONA-696(백/지대)·K-2450(백/지대)] /
    창호[P-1000F·NR-950·CPE·DWC4Z·DWC6Z·SJ-01] / 타일[P-1000·GPPS(재생)·GPPS(유니드)·DHA-100·ROSIN C-9, 뒤 3종 지대] /
    DBP[P-700·SP-390].
  - K-2450은 경질·DBP 품목(타일 아님). TIONA-696·K-2450은 백(F/B)·지대(P/B) 구분.
- **발주 대응 품목(ORDER_RESP 목록)**은 우리 창고에서 출고하지 않음 → 요청이 오면 공급사에 발주, 사급처로 직납.
  자동 판정은 항상 '발주'(직접출고 금지).
- 파레트 기준: 드럼 1PLT=800kg, 플레콘백(F/B)·지대(P/B) 1PLT=1,000kg.
  예외: DS-356/T 1,005 · ROSIN C-9 700 · SONGNOX 500 · SL-64는 465/540 두 규격(재확인 필요).
- GPPS: 신재(125EB)는 2,000kg 상시 유지 기준. 재생(PSGNT1TPZ)과 합산·대체 금지.
- M-210: 판정은 항상 '확인', 출고·완료 시 행선지 확인 근거 필요.
- TIONA-696(R696) 창고이동 완료 시: 당월 추가사용량·확인자 필수, 추가사용 > 0이면 발주 판정 필수(미발주는 사유 필수).
- 포장 메모: PMS 1,600kg 드럼 8 · SONGNOX 500/PLT · BP-276S 까대기 · NPET LOT·사진 · SL-64 파레트 혼재 ·
  오미아 벌크 18t 창호/12t 경질 · P-700 타일/DBP 구분. 찢어진 지대는 사급 금지.

## AI 연동 (구독핀)

- 작업판 "AI 질문"은 `supabase/functions/ai-chat`이 구독핀 `POST /v1/messages`로 중계. 설정은 `AI-SETUP.md`.
- 구독핀 규칙: Anthropic 방식(Claude Code·Anthropic SDK·n8n) Base URL은 `https://api.gudokpin.com`(/v1 없음),
  OpenAI 방식(OpenAI SDK·Codex·Cursor)은 `https://api.gudokpin.com/v1`. 키는 `csk_`로 시작.
  모델 ID는 `GET /v1/models`에 있는 것만(예: `claude-sonnet-5`, `gpt-5.6-luna`). 공식 OpenAI/Anthropic URL 하드코딩 금지.
