# Feature: Safe Agent Deletion With Maintainer Cleanup

## Requirements

- While an authenticated owner or lead agent is deleting an owned, non-built-in latest Agent, when that Agent is registered as a board maintainer, the system shall remove the maintainer resources before deleting the Agent lineage.
- While an Agent owns local maintainer registrations, when deletion succeeds, the system shall remove the maintainer rows and creation claims atomically with the Agent lineage.
- While an Agent owns AMA maintainer registrations, when deletion is requested, the system shall remove the remote triggers and archive the remote memory store before committing the local deletion.
- While remote cleanup fails, when deletion is requested, the system shall keep the local Agent and maintainer rows so the operation can be retried.
- While deletion fails, when the API responds, the system shall return the centralized structured error envelope rather than exposing a raw SQLite constraint error as an expected business outcome.

## Architecture

### Frontend

- Keep the existing accessible confirmation dialog, pending state, and error rendering.
- Preserve the existing successful navigation/refetch behavior; no optimistic removal is introduced.

### Backend

- Reuse one maintainer-resource cleanup helper from both maintainer deletion and Agent deletion.
- Load maintainer registrations through the owner-scoped repository layer.
- After any required external cleanup, use one D1 batch to delete maintainer rows, their claims, and every snapshot in the Agent username lineage.
- Continue relying on foreign keys to preserve task history while clearing assignments.

### Security

- Keep the existing user/leader route rule and owner-scoped Agent lookup.
- Scope every maintainer lookup and mutation by the same `owner_id`.
- Use bound SQL parameters only.
- Do not return database internals, API keys, vault credentials, or Relay secrets.
- Treat external cleanup failure as a failed deletion rather than silently orphaning remote schedulers.

## Implementation Plan

- [x] Add owner-scoped repository lookup and atomic Agent/maintainer deletion.
- [x] Extract and reuse maintainer external-resource cleanup.
- [x] Add regression tests for local maintainer deletion, claims, history, ownership, and cleanup failure.
- [x] Run repository verification and independent review.
