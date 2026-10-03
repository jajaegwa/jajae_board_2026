# 작업판 "AI 질문" 채팅 설정 (구독핀 API)

헤더의 **AI 질문** 버튼으로 작업판 데이터(창고이동·발주입고·사급·전달사항·발주점 이하 품목)에 대해
물어볼 수 있습니다. 답변만 하고 데이터는 바꾸지 않습니다. 지게차 화면에는 버튼이 보이지 않습니다.

구조: 작업판 → Supabase Edge Function `ai-chat` → 구독핀 `POST /v1/messages`

> ⚠️ 구독핀 키(`csk_...`)를 `index.html`에 넣지 마세요. GitHub Pages는 누구나 소스를 볼 수 있어
> 키를 가져가 크레딧을 쓸 수 있습니다. 키는 아래 4단계의 Secrets에만 넣습니다.

---

## 1단계 · Edge Function 배포

Supabase 대시보드 → **Edge Functions** → **Deploy a new function** → **Via Editor**

1. 함수 이름은 반드시 **`ai-chat`**
2. `index.ts`에 저장소의 `supabase/functions/ai-chat/index.ts` 내용을 그대로 붙여넣기
3. **Deploy**

## 2단계 · 비밀값 넣기

Edge Functions → `ai-chat` → **Secrets**

| 이름 | 값 |
|---|---|
| `GUDOKPIN_KEY` | 구독핀 API 키 (`csk_`로 시작) |
| `BOARD_PASSCODE` | 작업판 공유 비밀번호 (`notify-drivers`에 넣은 것과 같은 값) |
| `AI_MODEL` | (선택) 기본 `claude-opus-5-5` — `GET https://api.gudokpin.com/v1/models` 목록에 있는 것만 |
| `GUDOKPIN_BASE` | (선택) 기본 `https://api.gudokpin.com` — Anthropic 방식이라 **`/v1` 붙이지 말 것** |

## 3단계 · 확인

작업판(실시간 공유 연결 상태)에서 **AI 질문** → "오늘 남은 창고이동" 버튼.

| 화면 메시지 | 원인 |
|---|---|
| AI 채팅 서버(ai-chat 함수)가 아직 배포되지 않았습니다 | 1단계 함수 이름 확인 |
| 구독핀 API 키가 아직 설정되지 않았습니다 | `GUDOKPIN_KEY` 없음 |
| 작업판 비밀번호가 서버 설정과 다릅니다 | `BOARD_PASSCODE` 값 확인 |
| 구독핀 API 키가 올바르지 않습니다 | 키 오타 / `sk-` 키를 넣음 (구독핀 401·403) |
| 구독핀 크레딧 잔액이 부족합니다 | 구독핀 충전 (402) |
| 모델 ID가 구독핀에 등록돼 있지 않습니다 | `AI_MODEL` 값 확인 (404) |

## 보내는 데이터와 비용

- 질문할 때마다 기준일 ±14일 데이터(미완료 건은 최근 60일까지)와 발주점 이하 목록을 함께 보냅니다.
  이 데이터는 구독핀 서버를 거쳐 처리됩니다.
- 구독핀은 토큰 종량제(1크레딧=1원)이며 성공 응답만 과금됩니다. 함수에서 답변 길이(1,500토큰)·
  대화 기록(최근 20개)·데이터 크기(15만 자)를 제한합니다.
