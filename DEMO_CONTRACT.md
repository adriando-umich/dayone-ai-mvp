# DayOne.ai MVP Demo Contract (Hackathon)

## 1) Goal
Deliver a live, reliable simulation where a candidate handles technical pressure, business interruption, and communication under time constraints.

Primary proof points:
- Multi-agent timed orchestration works automatically.
- Candidate can communicate by voice and submit code-level fixes.
- Session ends with structured evaluation output.

## 2) Session Length
- Standard demo length: **10 minutes**
- Fallback demo length: **8 minutes** (same flow, compressed timing)

## 3) Interaction Model
- Candidate input modes:
  - `Voice` (push-to-talk mic, auto-transcribed to chat)
  - `Text chat` (optional typing)
  - `Proposed Fix` code box (snippet/pseudocode)
- Agent output mode:
  - `Text chat` only (for MVP reliability)

Note:
- Voice-in + text-out is the MVP default to reduce latency and demo risk.

## 4) Core UI Layout
- `Chat Panel` (multi-agent thread)
- `Code Context Panel` (read-only):
  - Buggy source file
  - Recent logs
  - Business ticket
- `Proposed Fix` box (candidate code response)
- `Timer` + `Start/Stop Simulation`
- `Recording controls` (screen + webcam)

## 5) Scenario (Single Core Path + Adaptive Dialogue)
Scenario name:
- **Payment Double-Charge Hotfix vs. VIP Discount Feature**

Static context shown at start:
- One buggy payment file
- One short production log excerpt
- One BA ticket requesting urgent VIP discount rollout

## 6) Agent Roles
- `AI QA Engineer`:
  - Opens with urgent P0 bug report.
  - Panicked tone, concrete symptoms.
- `AI Business Analyst (BA)`:
  - Interrupts with urgent feature pressure.
  - Stubborn, deadline-driven, business-first.
- `AI Tech Lead`:
  - Challenges solution quality and trade-offs.
  - Pedantic, risk-aware, forces explicit decisions.
- `AI Orchestrator` (background, n8n):
  - Schedules who speaks and when.
  - Prevents collision and preserves readable sequence.

## 7) Timeline Model (Anchor + Adaptive Windows)
Hard anchors (fixed):
- `T+03:00` BA interrupt: urgent VIP discount pressure must appear.
- `T+10:00` Session end: auto-stop, lock input, move to evaluation.

Adaptive windows (orchestrator can shift within the window):
- `T+00:00 - T+00:30` QA opener: report double-charge P0.
- `T+01:00 - T+01:45` Tech Lead opener: initial remediation approach.
- `T+03:30 - T+04:30` Tech Lead challenge: force explicit prioritization (hotfix vs feature).
- `T+06:00 - T+06:45` QA follow-up: add evidence/log impact to increase pressure.
- `T+07:00 - T+07:45` Tech Lead risk probe: rollback, monitoring, data correction.
- `T+09:00 - T+09:30` Tech Lead final challenge before close.

Scheduling rules:
- Orchestrator may defer non-anchor turns while candidate is actively speaking/typing.
- Max drift from planned turn start is bounded by each window end.
- If a window is about to close, orchestrator sends a concise prompt and advances.

## 8) Conversation Rules
- Candidate may ask clarification questions by voice/chat.
- No hard cap on clarification questions during the session.
- If clarification loops too long, Tech Lead may force a decision checkpoint.
- If candidate is silent for 10-12s during a prompt:
  - Orchestrator sends short follow-up nudge.
- If candidate is typing, orchestrator may pause the next agent turn:
  - Debounce rule: candidate is considered typing only if keystrokes occurred within the last **3 seconds**.
  - Max hold per turn: **15 seconds**.
  - After max hold, send one nudge then auto-advance if no response.
- Voice turn-taking rules:
  - If `mic_active=true`, pause non-anchor agent messages.
  - Resume after `speech_end` plus a short buffer (about 800ms).
  - `max_defer` per pending turn: **15 seconds**.
  - After `max_defer`, send one concise assumption-based follow-up and continue.
- STT handling (MVP):
  - Voice transcript is auto-sent to chat (no manual confirm click).
  - If STT confidence is low, agent asks naturally for a brief repeat.
  - If low-confidence repeats twice, suggest a short typed response.
- Question routing:
  - If candidate addresses `QA`, `BA`, or `Tech Lead`, route next reply to that agent.
  - If unaddressed, route by intent:
    - Bug reproduction/testing details -> `QA`
    - Scope/deadline/business impact -> `BA`
    - Trade-off/risk/implementation -> `Tech Lead`
  - Routed replies take priority over non-anchor scheduled turns.
- Agent turns are sequential:
  - No overlapping messages.
  - One sharp question per agent turn.

## 9) Candidate Response Format (Required)
Candidate final structured response must include:
- `Priority:` what is done first and why
- `Plan:` 3-step execution plan
- `Code:` snippet/pseudocode
- `Risk/Rollback:` one concrete fallback path

## 10) Evaluation Rubric (Post-Session)
Score dimensions:
- `Prioritization under pressure`
- `Technical correctness of fix direction`
- `Production risk awareness (rollback/monitoring/data impact)`
- `Communication clarity (questions + decision articulation)`

Outputs generated at end:
- Full transcript
- Recording file/link (screen + webcam)
- AI evaluation summary + score breakdown

## 11) In-Scope / Out-of-Scope
In-scope:
- Web chat simulation UI
- Voice transcription input
- Timed multi-agent orchestration via n8n
- Recording + post-session evaluation

Out-of-scope:
- Real-time human interviewer dashboard (HITL live control)
- Embedded full IDE / CI-CD integration
- Multi-scenario branching engine

## 12) Reliability Commitments
- All timing controlled by one central orchestration flow.
- Persona prompts are strict and role-locked.
- Backup asset required: one pre-recorded flawless run.

## 13) Acceptance Criteria (Demo Ready)
- Agents speak automatically at defined times without candidate initiation.
- No message collisions; conversation remains readable.
- Candidate is not interrupted while `mic_active=true` (except hard-anchor safeguards).
- Candidate can ask questions via voice and receive role-consistent replies.
- Candidate questions are routed to the correct role (QA/BA/Tech Lead).
- Candidate can submit code snippet in-session.
- Session auto-completes at 10:00 and produces transcript + evaluation.
