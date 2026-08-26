# 앱을 꺼도 오는 알림(서버 푸시) 설정

기사분이 앱을 **완전히 종료한 상태에서도** 알림을 받으려면 이 설정이 필요합니다.
설정하지 않아도 앱은 정상 동작하며, **앱이 실행 중일 때는 알림이 그대로 옵니다.**

한 번만 하면 되고, 순서대로 따라 하면 15분 정도 걸립니다.

---

## 1단계 · 알림 키(VAPID) 만들기

키는 두 개가 한 쌍입니다. 공개키는 앱이 쓰고, **개인키는 서버에만** 둡니다.

브라우저에서 <https://vapidkeys.com> 에 접속하면 바로 한 쌍을 만들어 줍니다.
(또는 컴퓨터에 Node가 있으면 `npx web-push generate-vapid-keys`)

나온 값 두 개를 메모해 두세요.

```
Public Key : BEl62iUYgUiv...   (공개키)
Private Key: UUxI4O8-Fbr...    (개인키 — 절대 공유하지 마세요)
```

> ⚠️ 개인키는 GitHub 저장소나 카톡·메일에 올리지 마세요. 3단계에서 Supabase에만 넣습니다.

---

## 2단계 · 구독 저장 테이블 만들기

Supabase 대시보드 → 왼쪽 **SQL Editor** → **New query** 에
저장소의 `supabase/schema-push.sql` 내용을 붙여넣고 **Run**.

"Success" 가 나오면 됩니다.

---

## 3단계 · Edge Function 배포

Supabase 대시보드 → 왼쪽 **Edge Functions** → **Deploy a new function** →
**Via Editor** 선택 후,

1. 함수 이름을 반드시 **`notify-drivers`** 로 지정
2. 파일 두 개를 만들고 저장소 내용을 그대로 붙여넣기
   - `index.ts` ← `supabase/functions/notify-drivers/index.ts`
   - `webpush.ts` ← `supabase/functions/notify-drivers/webpush.ts`
3. **Deploy**

> 이름이 `notify-drivers`가 아니면 앱이 찾지 못합니다.

---

## 4단계 · 비밀값 4개 넣기

Edge Functions → `notify-drivers` → **Secrets** 탭에서 4개를 추가합니다.

| 이름 | 값 |
|---|---|
| `VAPID_PUBLIC` | 1단계의 **공개키** |
| `VAPID_PRIVATE` | 1단계의 **개인키** |
| `VAPID_SUBJECT` | `mailto:본인메일주소` (예: `mailto:charlie6623@gmail.com`) |
| `BOARD_PASSCODE` | 작업판에서 쓰는 **공유 비밀번호** (아무나 알림을 쏘지 못하게 막는 용도) |

`SUPABASE_URL` 과 `SUPABASE_SERVICE_ROLE_KEY` 는 Supabase가 자동으로 넣어 주므로
따로 추가하지 않아도 됩니다.

---

## 5단계 · 기사 폰에서 켜기

1. 홈 화면 바로가기를 **한 번 지우고 다시 추가** (아이폰은 필수 — 앱으로 등록되어야 알림이 동작)
   - 사파리로 작업판 열기 → 공유 버튼 → **홈 화면에 추가**
2. 홈 화면 아이콘으로 앱 실행 (사파리 탭이 아니라 **아이콘으로** 열어야 함)
3. 상단 **[🔔 알림 켜기]** 누르고 허용
4. **"알림 켜짐 — 앱을 꺼도 알림이 옵니다"** 라고 뜨면 성공

> "알림 켜짐 (앱이 실행 중일 때)" 라고만 뜨면 서버 설정이 아직 안 잡힌 것입니다.
> 3·4단계를 다시 확인해 주세요.

---

## 확인 방법

기사 폰에서 앱을 완전히 종료한 뒤, 자재과 화면에서 창고이동이나 전달사항을 하나 등록해 보세요.
몇 초 안에 기사 폰에 알림이 떠야 합니다.

## 잘 안 될 때

| 증상 | 확인할 것 |
|---|---|
| "알림 켜짐 (앱이 실행 중일 때)" 로만 뜸 | 함수 이름이 `notify-drivers` 인지, `VAPID_PUBLIC`/`VAPID_PRIVATE` 가 들어갔는지 |
| 알림이 아예 안 옴 | 폰 설정 → 작업판 앱 → 알림 허용 여부 |
| 아이폰에서 [알림 켜기] 버튼이 없음 | 사파리 탭이 아니라 **홈 화면 아이콘**으로 열었는지, iOS 16.4 이상인지 |
| 기사를 바꿨음 | 새 기사 폰에서 5단계를 다시 하면 됨. 옛 구독은 알림 실패 시 자동 정리됨 |

## 참고 — 요구 사항

- 아이폰: iOS 16.4 이상 + 홈 화면에 추가된 상태에서만 웹 알림이 동작합니다(애플 정책).
- 안드로이드: 크롬에서 홈 화면에 추가하면 동작합니다.
- 작업판이 **HTTPS** 로 열려야 합니다(GitHub Pages는 기본 HTTPS).
