#!/usr/bin/env bash
# local-maintainer-watch.sh — trigger local board-maintainer review runs.
#
# `ak start` now includes the supported local maintainer scheduler. This script
# remains as an optional event-driven companion: when tasks land in `in_review`,
# it calls the same server-side deduped trigger used by the built-in scheduler,
# so running both cannot create parallel maintainer work.
#
# Modes:
#   watch (default): long-running. Tails the board SSE stream
#     (GET /api/boards/:id/stream) and triggers on `review_requested` actions.
#     The SSE window closes every ~25s (CF Workers limit); every reconnect runs
#     a full poll, which doubles as the ≤2-minute fallback for events missed
#     during disconnects.
#   --once: single poll and exit. For cron / systemd timers.
#
# Install examples:
#   cron (fallback poll every 2 minutes):
#     */2 * * * * /path/to/scripts/local-maintainer-watch.sh --board <board-id> --once >>/tmp/ak-maintainer-watch.log 2>&1
#
#   systemd user unit (~/.config/systemd/user/ak-maintainer-watch.service):
#     [Unit]
#     Description=AK local maintainer watcher
#     After=default.target
#     [Service]
#     ExecStart=/path/to/scripts/local-maintainer-watch.sh --board <board-id>
#     Restart=always
#     RestartSec=10
#     [Install]
#     WantedBy=default.target
#     # systemctl --user enable --now ak-maintainer-watch.service
#
# Requirements: ak (authenticated), jq, curl. Optional: gh (PR freshness check).
# Config is read from ~/.config/agent-kanban/config.json (current host);
# override with AK_API_URL / AK_API_KEY env vars.

set -euo pipefail

BOARD_ID=""
ONCE=0

usage() {
  sed -n '2,40p' "$0"
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --board) BOARD_ID="$2"; shift 2 ;;
    --once) ONCE=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "unknown argument: $1" >&2; usage 1 ;;
  esac
done

if [[ -z "$BOARD_ID" ]]; then
  echo "error: --board <board-id> is required" >&2
  usage 1
fi

for cmd in ak jq curl; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "error: required command not found: $cmd" >&2; exit 1; }
done

CONFIG_FILE="${AK_CONFIG_FILE:-$HOME/.config/agent-kanban/config.json}"
if [[ -z "${AK_API_URL:-}" || -z "${AK_API_KEY:-}" ]]; then
  [[ -f "$CONFIG_FILE" ]] || { echo "error: no AK config at $CONFIG_FILE (set AK_API_URL/AK_API_KEY)" >&2; exit 1; }
  CURRENT_HOST="$(jq -r '.current // empty' "$CONFIG_FILE")"
  [[ -n "$CURRENT_HOST" ]] || { echo "error: no current host in $CONFIG_FILE" >&2; exit 1; }
  AK_API_URL="${AK_API_URL:-$(jq -r --arg h "$CURRENT_HOST" '.credentials[$h]["api-url"] // empty' "$CONFIG_FILE")}"
  AK_API_KEY="${AK_API_KEY:-$(jq -r --arg h "$CURRENT_HOST" '.credentials[$h]["api-key"] // empty' "$CONFIG_FILE")}"
fi
[[ -n "$AK_API_URL" && -n "$AK_API_KEY" ]] || { echo "error: could not resolve AK API credentials" >&2; exit 1; }

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# True when the local daemon is up; without it a review task would sit in todo.
# Match the positive form exactly — the down state ("Machine runner is not
# running") also contains the word "running".
daemon_running() {
  ak status 2>/dev/null | grep -q "Machine runner running (PID"
}

# True when a PR looks freshly updated (within 2 minutes): the worker may still
# be pushing / posting the completion note, so skip this round and let the next
# poll pick it up. Falls back to the task's own updated_at when gh or the PR
# URL is unavailable.
pr_is_fresh() {
  local pr_url="$1" task_updated_at="$2"
  local now updated=""
  now="$(date +%s)"
  if [[ -n "$pr_url" && "$pr_url" == http* ]] && command -v gh >/dev/null 2>&1; then
    updated="$(gh pr view "$pr_url" --json updatedAt --jq '.updatedAt' 2>/dev/null || true)"
  fi
  if [[ -z "$updated" ]]; then
    updated="$task_updated_at"
  fi
  [[ -n "$updated" ]] || return 1
  local updated_ts
  updated_ts="$(date -d "$updated" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%SZ" "$updated" +%s 2>/dev/null || echo 0)"
  [[ "$updated_ts" =~ ^[0-9]+$ ]] || return 1
  (( now - updated_ts < 120 ))
}

# One trigger round. Shared by --once and the watch loop.
poll_once() {
  daemon_running || { log "daemon not running, skipping"; return 0; }

  local review_tasks
  review_tasks="$(ak get task --board "$BOARD_ID" --status in_review -o json 2>/dev/null || echo '[]')"
  [[ "$(jq 'length' <<<"$review_tasks")" -gt 0 ]] || return 0

  local maintainer_json maintainer_id maintainer_agent_id review_enabled
  maintainer_json="$(ak get maintainer --board "$BOARD_ID" -o json 2>/dev/null || echo '[]')"
  maintainer_id="$(jq -r '.[0].id // empty' <<<"$maintainer_json")"
  maintainer_agent_id="$(jq -r '.[0].agent_id // empty' <<<"$maintainer_json")"
  if [[ -z "$maintainer_agent_id" ]]; then
    log "no maintainer on board $BOARD_ID (create one with: ak create maintainer --board $BOARD_ID --agent <agent-id>), skipping"
    return 0
  fi
  review_enabled="$(jq -r '.[0].review_enabled // true' <<<"$maintainer_json")"
  if [[ "$review_enabled" != "true" ]]; then
    log "review-event trigger is disabled for board $BOARD_ID, skipping"
    return 0
  fi

  # Dedup: the maintainer already has an active review task for this board.
  local active_reviews
  active_reviews="$(ak get task --board "$BOARD_ID" --label maintainer-review -o json 2>/dev/null || echo '[]')"
  local existing
  existing="$(jq --arg a "$maintainer_agent_id" \
    '[.[] | select(.assigned_to == $a and (.status == "todo" or .status == "in_progress" or .status == "in_review" or .status == "error"))] | length' \
    <<<"$active_reviews")"
  if [[ "$existing" -gt 0 ]]; then
    log "maintainer review task already active, skipping"
    return 0
  fi

  # Skip freshly-updated PRs this round; they will be picked up next round.
  local pending
  pending="$(jq -c '[.[] | {id, title, pr_url: (.pr_url // ""), repository_id: (.repository_id // ""), updated_at: (.updated_at // "")}]' <<<"$review_tasks")"
  local selected="[]"
  while IFS= read -r task; do
    [[ -n "$task" ]] || continue
    if pr_is_fresh "$(jq -r '.pr_url' <<<"$task")" "$(jq -r '.updated_at' <<<"$task")"; then
      log "skipping $(jq -r '.id' <<<"$task"): PR/task updated within the last 2 minutes"
      continue
    fi
    selected="$(jq -c --argjson t "$task" '. + [$t]' <<<"$selected")"
  done < <(jq -c '.[]' <<<"$pending")
  [[ "$(jq 'length' <<<"$selected")" -gt 0 ]] || return 0

  log "requesting maintainer review run for $(jq 'length' <<<"$selected") task(s)"
  local payload
  payload="$(jq -cn --argjson ids "$(jq '[.[].id]' <<<"$selected")" '{trigger:"review", task_ids:$ids}')"
  curl -fsS -X POST \
    -H "Authorization: Bearer $AK_API_KEY" \
    -H "Content-Type: application/json" \
    --data "$payload" \
    "$AK_API_URL/api/boards/$BOARD_ID/maintainers/$maintainer_id/local-runs" >/dev/null
}

if [[ "$ONCE" -eq 1 ]]; then
  poll_once
  exit 0
fi

log "watching board $BOARD_ID (SSE + poll on every reconnect)"
while true; do
  poll_once
  # The stream closes itself after ~25s; reconnect (and re-poll) immediately.
  curl -sN -H "Authorization: Bearer $AK_API_KEY" "$AK_API_URL/api/boards/$BOARD_ID/stream" 2>/dev/null | \
    while IFS= read -r line; do
      case "$line" in
        data:*review_requested*) poll_once ;;
      esac
    done || true
  sleep 2
done
