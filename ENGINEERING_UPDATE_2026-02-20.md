# DayOne.ai Engineering Update (2026-02-20)

## Branding Updates
- Renamed package identifier to DayOne.ai branding: `package.json`.
- Updated contract title: `DEMO_CONTRACT.md`.
- Updated prompt/doc titles to DayOne.ai:
  - `scenario/persona_prompts.md`
  - `n8n_flow_spec.md`
  - `n8n/workflows/README.md`
  - `n8n/workflows/v2/README.md`
- Updated n8n workflow display name: `n8n/workflows/simulhire_mvp_orchestrator.json`.

## Codebase Review Findings (Ordered by Severity)

### 1) Resolved - n8n callback URL is now cloud-safe
- Added `PUBLIC_BASE_URL` env usage in `local_receiver.js` for `frontend_agent_webhook`.
- Callback now uses `${PUBLIC_BASE_URL}/sim/session/agent-message` instead of `host.docker.internal`.
- Impact: n8n callbacks can reach deployed backend domain on Railway/Render.

### 2) High - No auth on control/data endpoints
- Recording upload is public: `local_receiver.js:1650`.
- Event ingress is public: `local_receiver.js:1783`.
- Message wipe endpoint is public: `local_receiver.js:1996`.
- Impact: Any caller can inject events, upload files, or clear session history.
- Recommended fix: Add API key middleware (or signed token) for non-browser/internal endpoints.

### 3) Medium - Upstream parsing assumes JSON response shape
- Direct role call parse: `local_receiver.js:1543`.
- Orchestrator start parse: `local_receiver.js:1752`.
- Orchestrator event parse: `local_receiver.js:1869`.
- Impact: If upstream returns HTML/text (proxy error, timeout page), flow throws and session degrades.
- Recommended fix: Wrap `JSON.parse` with guarded parser + fallback payload.

### 4) Medium - Transcript retention is global and capped at 500 rows
- Cap: `local_receiver.js:36`.
- Global shift-on-overflow: `local_receiver.js:266`, `local_receiver.js:275`.
- Impact: Concurrent sessions can evict each other; long demos lose earlier transcript rows.
- Recommended fix: Keep per-session ring buffers or persist to Redis/DB.

### 5) Medium - Local `.env` is currently tracked in git status
- Observed in workspace status (`git status`), `.env` appears modified and tracked.
- Impact: Secret leakage risk if pushed to remote.
- Recommended fix: `git rm --cached .env` and keep secrets only in platform env vars.

## Suggested Next Sprint (MVP-hardening)
1. Add simple API auth for `/api/session/event`, `/api/session/recording`, `/sim/session/messages`.
2. Harden upstream parse/error handling for n8n/webhook responses.
3. Move session/transcript storage to durable store (or at least per-session capped cache).
4. Add a basic smoke test script for start -> event -> code submit -> stop.
