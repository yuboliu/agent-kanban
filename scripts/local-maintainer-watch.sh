#!/usr/bin/env bash
# local-maintainer-watch.sh — drive a local (non-AMA) board maintainer.
#
# Self-hosted deployments have no server-side scheduler. This script watches a
# board for tasks entering in_review and creates a `maintainer-review` task
# assigned to the board's maintainer agent; the local daemon (ak start)
# dispatches it like any other task.
#
# Usage:
#   scripts/local-maintainer-watch.sh --board <board-id>            # watch mode (long-running)
#   scripts/local-maintainer-watch.sh --board <board-id> --once     # single poll (for cron)
#
# Modes:
#   watch (default): streams the board SSE feed (GET /api/boards/:id/stream)
#     and triggers on `review_requested` actions. The SSE window closes every
#     ~25s; every reconnect performs a full poll, which also covers any events
#     missed while disconnected.
#   --once: one poll, then exit. Cron example (every 2 minutes):
#       */2 * * * * /path/to/scripts/local-maintainer-watch.sh --board <board-id> --once >> ~/.local/state/agent-kanban/logs/maintainer-watch.log 2>&1
#   systemd user unit example (~/.config/systemd/user/ak-maintainer-watch.service):
#       [Unit]
#       Description=AK local maintainer watch
#       [Service]
#       ExecStart=/path/to/scripts/local-maintainer-watch.sh --board <board-id>
#       Restart=always
#       RestartSec=5
#       [Install]
#       WantedBy=default.target
#
# Requires: ak (configured with `ak config set`), curl, jq.
set -euo pipefail

BOARD_ID=""
ONCE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --board) BOARD_ID="$2"; shift 2 ;;
    --once) ONCE=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$BOARD_ID" ]] || { echo "--board <board-id> is required" >&2; exit 2; }

for dep in ak curl jq; do
  command -v "$dep" >/dev/null 2>&1 || { echo "missing dependency: $dep" >&2; exit 2; }
done

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# --- Credentials (reuse the ak CLI config) --------------------------------
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}/agent-kanban"
CONFIG_FILE="$CONFIG_HOME/config.json"
[[ -f "$CONFIG_FILE" ]] || { log "no ak config at $CONFIG_FILE — run: ak config set --api-url <url> --api-key <key>"; exit 1; }
CURRENT_HOST=$(jq -r '.current // empty' "$CONFIG_FILE")
API_URL=$(jq -r --arg h "$CURRENT_HOST" '.credentials[$h]["api-url"] // empty' "$CONFIG_FILE")
API_KEY=$(jq -r --arg h "$CURRENT_HOST" '.credentials[$h]["api-key"] // empty' "$CONFIG_FILE")
[[ -n "$API_URL" && -n "$API_KEY" ]] || { log "no credentials for host $CURRENT_HOST in $CONFIG_FILE"; exit 1; }
API_URL="${API_URL%/}"

# --- Daemon liveness -------------------------------------------------------
STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}/agent-kanban"
PID_FILE="$STATE_HOME/daemon.pid"
daemon_running() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid=$(tr -dc '0-9' < "$PID_FILE")
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

# --- Trigger logic ----------------------------------------------------------
# Creates at most one review task per round; safe to call on every reconnect.
poll_and_trigger() {
  if ! daemon_running; then
    log "daemon not running (no live $PID_FILE) — skipping"
    return 0
  fi

  local maintainers maintainer_agent
  maintainers=$(curl -sf -H "Authorization: Bearer $API_KEY" "$API_URL/api/boards/$BOARD_ID/maintainers") || {
    log "failed to fetch maintainers for board $BOARD_ID"
    return 0
  }
  maintainer_agent=$(jq -r '[.[] | select(.status == "active")][0].agent_id // empty' <<<"$maintainers")
  if [[ -z "$maintainer_agent" ]]; then
    log "no active maintainer on board $BOARD_ID — create one with: ak create maintainer --board $BOARD_ID --agent <agent-id>"
    return 0
  fi

  # Dedupe: an active review task already owned by this maintainer → wait.
  local active_reviews
  active_reviews=$(ak get task --board "$BOARD_ID" --label maintainer-review -o json 2>/dev/null \
    | jq '[.[] | select(.status == "todo" or .status == "in_progress" or .status == "in_review")] | length')
  if [[ "$active_reviews" -gt 0 ]]; then
    log "maintainer already has $active_reviews active review task(s) — skipping"
    return 0
  fi

  local in_review
  in_review=$(ak get task --board "$BOARD_ID" --status in_review -o json 2>/dev/null) || {
    log "failed to list in_review tasks"
    return 0
  }

  # Exclude the maintainer's own tasks and tasks whose PR changed in the last
  # 2 minutes (pushes may still be in flight; the next round picks them up).
  local cutoff pending
  cutoff=$(date -u -d '-2 minutes' '+%Y-%m-%dT%H:%M:%SZ')
  pending=$(jq --arg agent "$maintainer_agent" --arg cutoff "$cutoff" '
    [.[] | select(.assigned_to != $agent)
         | select((.labels // []) | index("maintainer-review") | not)
         | select((.updated_at // "") <= $cutoff)]
  ' <<<"$in_review")
  local count
  count=$(jq 'length' <<<"$pending")
  if [[ "$count" -eq 0 ]]; then
    log "no in_review tasks awaiting review"
    return 0
  fi

  local repository_id
  repository_id=$(jq -r '[.[] | .repository_id // empty][0] // empty' <<<"$pending")

  local task_list description
  task_list=$(jq -r '.[] | "- \(.id): \(.title) — PR: \(.pr_url // "none")"' <<<"$pending")
  description=$(cat <<EOF
You are the board maintainer. Review the following in-review tasks on board $BOARD_ID, then complete or reject each one:

$task_list

Workflow:
- Follow the installed ak-maintainer skill for review and acceptance standards.
- If the ak-verify skill is installed, it is the acceptance standard: verify the worker's test/regression evidence, re-run checks when risk justifies it, and reject with the specific failing step when evidence is missing or failing.
- Check out each PR (gh pr checkout) in this task's worktree and run the repository's verification commands before completing.
- Circuit breaker: if a task has already been rejected 2 or more times, do NOT reject it again — leave a note summarizing the situation and escalate to a human.
- Never complete or reject a task you implemented yourself.

Memory: keep durable maintainer context in $HOME/.local/share/agent-kanban/maintainer/$BOARD_ID/HEARTBEAT.md (create the directory if missing). Read it before deciding; update it before finishing.

When done, run \`ak task review\` and then \`ak task complete\` on this task to close it out.
EOF
)

  local args=(create task --board "$BOARD_ID" --title "Maintainer review: $count task(s) in review" \
    --description "$description" --labels "maintenance,maintainer-review" --assign-to "$maintainer_agent")
  [[ -n "$repository_id" ]] && args+=(--repo "$repository_id")

  if ak "${args[@]}" >/dev/null; then
    log "created maintainer-review task for $count in-review task(s), assigned to $maintainer_agent"
  else
    log "failed to create maintainer-review task"
  fi
}

# --- Modes ------------------------------------------------------------------
if [[ "$ONCE" -eq 1 ]]; then
  poll_and_trigger
  exit 0
fi

log "watching board $BOARD_ID (SSE + poll on every reconnect)"
while true; do
  triggered=0
  # One SSE window (~25s server-side). curl exits when the server closes the
  # stream; we then poll (covering anything missed) and reconnect.
  while IFS= read -r line; do
    case "$line" in
      *'"action":"review_requested"'*|*'"action": "review_requested"'*) triggered=1 ;;
    esac
  done < <(curl -sN --max-time 45 -H "Authorization: Bearer $API_KEY" "$API_URL/api/boards/$BOARD_ID/stream" || true)

  if [[ "$triggered" -eq 1 ]]; then
    log "review_requested event received"
  fi
  poll_and_trigger
  sleep 1
done
