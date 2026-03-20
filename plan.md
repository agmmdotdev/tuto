# Browser IDE MVP Plan

## Goal

Build a controlled tutorial workspace where a learner can:

1. open a lesson session
2. edit files in the browser
3. see logs and session status
4. view a live preview
5. later run the same flow on top of Secure Exec

The key constraint is still the same: Secure Exec can be the isolated runtime, but it is not the IDE control plane. We still need session orchestration, file sync, preview proxying, and lifecycle management.

## Product Boundary

This is an MVP for a tutorial platform, not a general-purpose cloud IDE.

In scope:

- one template per session
- one learner workspace per session
- browser editor
- preview pane
- session status and logs
- explicit API contracts between frontend and backend
- an implementation path that can later swap the mock runtime for Secure Exec

Out of scope for the MVP:

- arbitrary npm installs
- persistent multi-day workspaces
- shell access to the whole machine
- collaborative editing
- multi-tenant scheduling
- production-grade auth and billing

## Architecture Decision

We should build this in phases.

Phase 1 is a local in-memory vertical slice inside this Next app. Its job is to prove:

- the UI shape
- the session data model
- the file editing flow
- the preview contract
- the backend route structure

Phase 2 swaps the mock runtime for a real Secure Exec-backed session manager.
Phase 2.5 adds a host-backed Vite + React runtime so we can prove a real framework dev server before tackling `next dev`.

## Phase Plan

### Phase 1: Mocked Vertical Slice

Deliverables:

- in-memory template catalog
- in-memory session store
- create-session API
- get-session API
- update-file API with path validation
- browser IDE shell
- iframe preview backed by session state
- terminal/log panel fed by backend events

Success criteria:

- a new session can be created from a template
- editing a file updates backend state
- the preview reloads from session data
- the UI reflects save state and session status

### Phase 2: Real Runtime Integration

Replace the in-memory runtime with Secure Exec.

Deliverables:

- Secure Exec runtime adapter
- workspace boot from template files
- preview server boot lifecycle
- readiness probe before marking a session ready
- preview proxy to the isolated server
- stdout and stderr streaming from the runtime

Critical rule:

Do not mark a session as `ready` until a real health check passes.

### Phase 2.5: Host-Backed Framework Runtime

Use a real session directory on the host and boot Vite from that workspace.

Deliverables:

- host-backed workspace creation
- Vite + React template
- proxied Vite HTTP preview
- file sync to disk
- runtime selection in the UI
- process log streaming into the session terminal

Why this phase exists:

- it proves a real framework toolchain
- it avoids Secure Exec module-resolution constraints for Vite
- it keeps the preview contract HTTP-only while WebSocket proxying is still deferred

### Phase 3: Operational Hardening

Deliverables:

- idle timeout and session cleanup
- template caching
- failure states and restart flow
- auth hooks
- quotas and resource limits
- audit logging

## Backend Contracts

### Session Model

Each session should expose:

- `id`
- `templateId`
- `status`
- `createdAt`
- `updatedAt`
- `previewPath`
- `files`
- `terminal`

### API Surface

`POST /api/sessions`

- create a new session from a template

`GET /api/sessions/:sessionId`

- fetch the current session snapshot

`PUT /api/sessions/:sessionId/files`

- update a single file
- validate and normalize the requested path
- reject writes outside the workspace

`GET /preview/:sessionId`

- return the current preview document for the iframe

## Secure Exec Integration Notes

When we reach Phase 2, these are the non-negotiable concerns:

- session readiness must be based on an actual probe, not process spawn alone
- preview proxying must handle both HTTP and WebSocket traffic
- file sync must preserve a coherent workspace tree
- path handling must be defensive
- session teardown must always clean up the runtime

This means the naive model of "send changed code and let the dev server figure it out" is incomplete. The hard part is workspace coherence plus runtime lifecycle.

## Implementation Order In This Repo

The first implementation slice in this repository should be:

1. rewrite the landing page into an IDE workbench shell
2. add a mock template and in-memory session store
3. add session routes
4. wire the editor to the routes
5. render a safe iframe preview from session state
6. leave a clean boundary where Secure Exec can replace the mock runtime later

## Risks

- in-memory storage resets on server restart
- the preview in Phase 1 is only a contract demo, not a real Next dev server
- serverless deployment may not preserve process-local session state
- once Secure Exec is added, resource ceilings will become the main scaling constraint

## Current Status

Implemented in this repo now:

- Phase 1 implementation
- runtime adapter boundary in place
- mock mode is the default
- runtime mode can now be selected in the UI
- Secure Exec mode boots `server.js` from the workspace and proxies host requests into it
- host-backed Vite mode boots a real Vite + React dev server from a session directory on disk
- terminal output now includes runtime process logs for Secure Exec and host-backed Vite
- no shell/PTY support yet

That is the right scope for the first pass.
