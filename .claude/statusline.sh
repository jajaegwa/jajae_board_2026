#!/usr/bin/env bash
# Claude Code Status Line
#
# Line 1 (항상): 🤖 Model | ⚡ effort | 📂 wt/Dir | 🔀 Branch | 🧠 Context% | 🎫 Tokens
#   - 모든 항목이 아이콘 앵커를 갖고 | 로 균일하게 구분된다
#   - effort / wt / branch / tokens 는 해당 값이 있을 때만 칸이 생긴다
# Line 2 (5h 또는 7d 중 하나라도 50% 이상일 때만): ⏱ 5h XX%  ·  📅 7d XX%
#
# stdin으로 세션 상태 JSON을 받는다 (settings.json 의 statusLine.command).

input=$(cat)

# ── 필드 추출 ────────────────────────────────────────────
model=$(echo "$input" | jq -r '.model.display_name // "Unknown"')

# Effort (reasoning effort 지원 모델에서만 존재)
effort=$(echo "$input" | jq -r '.effort.level // empty')

workspace_dir=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // empty')
workspace_name=$(basename "${workspace_dir:-~}")

# 브랜치 + worktree 이름 (JSON 우선, 브랜치가 없으면 git 직접 호출)
git_worktree=$(echo "$input" | jq -r '.workspace.git_worktree // empty')
git_branch=$(echo "$input" | jq -r '.worktree.branch // empty')
if [ -z "$git_branch" ] && [ -n "$workspace_dir" ] && [ -d "$workspace_dir" ]; then
  git_branch=$(git -C "$workspace_dir" rev-parse --abbrev-ref HEAD 2>/dev/null)
fi

# 컨텍스트 사용률 (소수점 버리고 정수로, 첫 API 응답 전에는 null)
context_pct=$(echo "$input" | jq -r '.context_window.used_percentage // empty' | cut -d. -f1)
if [ -n "$context_pct" ]; then
  context_display="${context_pct}%"
else
  context_display="--"
fi

# 토큰 (컨텍스트에 올라간 입력 토큰 = 캐시 read/write 포함, / 모델 컨텍스트 크기)
# 세션 누적치가 아니라 "지금 컨텍스트에 들어있는 양"이다.
tok_in=$(echo "$input" | jq -r '.context_window.total_input_tokens // empty')
tok_max=$(echo "$input" | jq -r '.context_window.context_window_size // empty')

# 8200 -> 8k, 1234567 -> 1.2M
humanize() {
  awk -v n="$1" 'BEGIN{
    if (n >= 999500) printf "%.1fM", n/1000000;
    else if (n >= 1000) printf "%.0fk", n/1000;
    else printf "%d", n;
  }'
}

token_display=""
if [ -n "$tok_in" ]; then
  token_display="$(humanize "$tok_in")"
  [ -n "$tok_max" ] && token_display="${token_display}/$(humanize "$tok_max")"
fi

# Rate limits (구독 사용량. 구독자 + 첫 API 응답 이후에만 존재)
rl_5h=$(echo "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty' | cut -d. -f1)
rl_7d=$(echo "$input" | jq -r '.rate_limits.seven_day.used_percentage // empty' | cut -d. -f1)

# ── 색상 (1번째 줄에만 사용) ──────────────────────────────
RESET=$'\033[0m'; BOLD=$'\033[1m'; DIM=$'\033[2m'
BLUE=$'\033[34m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'
MAGENTA=$'\033[35m'; CYAN=$'\033[36m'; RED=$'\033[31m'

# 컨텍스트 색상: ~69% 초록 / 70~89% 노랑 / 90%+ 빨강, 값 없으면 흐리게
CTX_COLOR=$DIM
if [ -n "$context_pct" ]; then
  if   [ "$context_pct" -ge 90 ]; then CTX_COLOR=$RED
  elif [ "$context_pct" -ge 70 ]; then CTX_COLOR=$YELLOW
  else                                  CTX_COLOR=$GREEN
  fi
fi

SEP=" ${DIM}${CYAN}|${RESET} "

# ── Line 1 ───────────────────────────────────────────────
# 색 문법: 그룹마다 한 색 — 모델군 파랑 / 위치군 마젠타 / 컨텍스트군 상태색.
#          그룹 안에서 주 값은 볼드, 부 값은 볼드 없음.
#          시안은 구분자 전용, 노랑/빨강은 컨텍스트 경고 전용.
line1="${BLUE}${BOLD}🤖 ${model}${RESET}"
[ -n "$effort" ] && line1+="${SEP}${BLUE}⚡ ${effort}${RESET}"

# 워크트리 하위 디렉토리에 있을 때만 "워크트리/" 를 앞에 붙인다 (부 값이라 볼드 없음).
# 워크트리 루트에 있으면 두 이름이 같으므로 생략.
line1+="${SEP}${MAGENTA}📂 "
[ -n "$git_worktree" ] && [ "$git_worktree" != "$workspace_name" ] && line1+="${git_worktree}/"
line1+="${BOLD}${workspace_name}${RESET}"

[ -n "$git_branch" ] && line1+="${SEP}${MAGENTA}🔀 ${git_branch}${RESET}"

line1+="${SEP}${CTX_COLOR}${BOLD}🧠 ${context_display}${RESET}"
[ -n "$token_display" ] && line1+="${SEP}${CTX_COLOR}🎫 ${token_display}${RESET}"

echo -e "$line1"

# ── Line 2 (임계값 넘을 때만, 색상 없음) ──────────────────
RL_THRESHOLD=50
show_line2=0
[ -n "$rl_5h" ] && [ "$rl_5h" -ge "$RL_THRESHOLD" ] && show_line2=1
[ -n "$rl_7d" ] && [ "$rl_7d" -ge "$RL_THRESHOLD" ] && show_line2=1

if [ "$show_line2" -eq 1 ]; then
  line2=""
  [ -n "$rl_5h" ] && line2="⏱ 5h ${rl_5h}%"
  if [ -n "$rl_7d" ]; then
    [ -n "$line2" ] && line2="${line2}  ·  "
    line2="${line2}📅 7d ${rl_7d}%"
  fi
  echo "$line2"
fi
