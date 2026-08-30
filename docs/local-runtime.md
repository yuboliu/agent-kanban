# Fully Local Runtime

Agent Kanban runs its web/API service and task execution plane on one local
machine with Node.js + SQLite. No Cloudflare, hosted D1, Durable Objects, or
AMA deployment is involved.

## Components

- `./service_runner.sh` runs the React UI, Hono API, local SQLite, and local
  WebSocket relay from a single pure-local Node process on the machine.
- `scripts/local_runtime_runner.sh` builds the CLI, registers the machine with
  the local API, sends heartbeats, polls assigned tasks, and starts installed
  agent CLIs such as Codex or Claude Code.
- Better Auth user sessions and machine API keys are stored in the local
  SQLite database. Worker sessions use local Ed25519 identities.
- GitHub access is independent. Authenticate `gh` locally when repository,
  issue, or pull-request operations are needed.

## Repeatable Setup

Start the local web/API service in terminal one:

```bash
./service_runner.sh
```

Open `http://127.0.0.1:6265`. On the very first run the auth page shows the
owner-account registration form: pick a username, display name and password.
That first account is the admin and registration is then locked forever —
afterwards only username/password sign-in is available. Create a machine API
key in account settings for the local runtime.

Authenticate the local GitHub CLI if repository work is required:

```bash
gh auth login
gh auth status
```

Start the machine runtime in terminal two. Supplying the key through the
environment keeps it out of shell argument history:

```bash
AK_API_KEY='ak_xxx' ./scripts/local_runtime_runner.sh
```

The key is saved in the local `ak` configuration. Later starts can reuse it:

```bash
./scripts/local_runtime_runner.sh --skip-install
./scripts/local_runtime_runner.sh --restart --skip-install
```

Useful checks:

```bash
ak status
ak logs -f
```

Create or assign a task to a worker whose runtime is reported as ready by the
machine. The local daemon prepares agent metadata, subagent definitions, and
skill snapshots first; only then does it create an Ed25519-authenticated worker
session and worktree and start the matching local agent CLI.

## Skill Cache and Branch Safety

Configured skills are persisted below the machine's Agent Kanban data directory
in a content-addressed cache. A task receives copies of a fixed snapshot, so a
background update cannot change a running agent and the agent cannot modify the
shared cache. The first cache miss can access GitHub through `npx skills`, but
it happens before `git worktree add`. If the network is unavailable and no
snapshot exists, dispatch is deferred without creating an `ak/*` branch.

Open **Settings → Runtime** to control automatic upstream updates and the
refresh interval (1–168 hours, 24 by default). Disabling automatic updates does
not disable persistence or first-use cache fills. On update failure, the daemon
continues using the last-known-good snapshot.

Subagent definitions are small owner-scoped API records rather than downloaded
packages. The daemon fetches the catalog once during task preflight and renders
the selected definitions locally for the runtime, so edits take effect on the
next dispatch.

On startup the daemon removes an untracked worktree only when it is clean, its
branch is exactly the matching `ak/<directory>` name, and its HEAD is unchanged
from the repository checkout. Any dirty or committed worktree is preserved and
reported in the daemon log for manual recovery.

## Claude Code Authentication Modes

The `claude` runtime accepts either of Claude Code's authentication modes:

- **OAuth login** (`claude` signed in interactively; token in the system
  keychain or `~/.claude/.credentials.json`). AK additionally probes the OAuth
  usage API and pauses dispatch while a usage window (for example the 5-hour
  window) is exhausted, resuming automatically after `resets_at`.
- **Custom endpoint** (`ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`, usually
  with `ANTHROPIC_BASE_URL`, for relays/gateways/proxies). Variables can be set
  in the daemon's environment or in the `env` block of `~/.claude/settings.json`
  (which the spawned CLI applies itself). In this mode the runtime is reported
  ready based on credential presence; usage windows do not apply, and mid-run
  rate limits are still handled through `turn.rate_limit` events.

Custom-endpoint credentials take precedence over the OAuth login, matching
Claude Code's own behavior.

## GitHub Integration (Optional)

GitHub OAuth binding and GitHub App webhooks are optional. They activate only
when the corresponding `GITHUB_*` configuration is present; otherwise the
relevant endpoints return stable disabled responses and no network calls are
made. Task-completion polling always uses the local `gh` CLI as a fallback.
