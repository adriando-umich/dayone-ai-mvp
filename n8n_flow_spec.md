# n8n Flow Spec - DayOne.ai MVP (Architecture B)

## 1) Purpose
Implement multi-agent orchestration with **4 workflows**:
- `WF_Main_Orchestrator`
- `WF_Agent_QA`
- `WF_Agent_BA`
- `WF_Agent_TechLead`

Main workflow controls timing/routing/state. Agent workflows only generate in-role replies.

## 2) Session Constants
- `SESSION_DURATION_SEC`: `600`
- `ANCHOR_BA_INTERRUPT_SEC`: `180` (`T+03:00`)
- `ANCHOR_END_SEC`: `600` (`T+10:00`)
- `SILENCE_TIMEOUT_SEC`: `12`
- `FOLLOWUP_WAIT_SEC`: `8`
- `TYPING_DEBOUNCE_SEC`: `3`
- `MAX_DEFER_SEC`: `15`
- `SPEECH_RESUME_BUFFER_MS`: `800`
- `LOW_STT_CONFIDENCE`: `0.75`
- `LOW_STT_MAX_REPEATS`: `2`

## 3) Timeline Model
Hard anchors:
- `T+03:00`: BA interrupt must fire.
- `T+10:00`: session ends.

Adaptive windows:
- `W1_QA_OPENER`: `0-30`
- `W2_TL_OPENER`: `60-105`
- `W3_TL_PRIORITY_CHALLENGE`: `210-270`
- `W4_QA_FOLLOWUP`: `360-405`
- `W5_TL_RISK_PROBE`: `420-465`
- `W6_TL_FINAL_CHALLENGE`: `540-570`

## 4) Workflow Topology
## 4.1 WF_Main_Orchestrator
Responsibilities:
- Receive start/event webhooks
- Keep session state
- Enforce anchors/windows
- Choose next role
- Call agent sub-workflow via `Execute Workflow`
- Apply post-guardrails
- Send message to frontend

Key nodes:
1. `Webhook Start Session`
2. `Init Session State (Code)`
3. `Scheduler Tick / Wait`
4. `Webhook Candidate Event`
5. `Update Runtime State (Code)`
6. `Decide Next Turn (Code)`
7. `Switch Role (QA/BA/TechLead)`
8. `Execute Workflow: WF_Agent_QA | WF_Agent_BA | WF_Agent_TechLead`
9. `Guardrail Postprocess (Code)`
10. `HTTP Request -> frontend /agent-message`
11. `Silence Timeout Logic (Code + Wait)`
12. `HTTP Request -> frontend /session/end`

## 4.2 WF_Agent_QA
Responsibilities:
- Produce QA-style response from context
- Return text only (never push directly)

Key nodes:
1. `Execute Workflow Trigger`
2. `Set Prompt Inputs`
3. `LLM Node`
4. `Normalize Output (Code)`
5. `Return Output`

## 4.3 WF_Agent_BA
Same structure as QA, with BA prompt/persona.

## 4.4 WF_Agent_TechLead
Same structure as QA, with Tech Lead prompt/persona.

## 5) Data Contracts
## 5.1 Start Session (frontend -> orchestrator)
`POST /sim/session/start`
```json
{
  "session_id": "sess_001",
  "candidate_id": "cand_demo",
  "started_at": "2026-02-20T23:00:00Z",
  "scenario_id": "payment_double_charge_vip_discount_v1",
  "frontend_agent_webhook": "http://localhost:3000/sim/session/agent-message",
  "end_callback_webhook": "http://localhost:3000/sim/session/end"
}
```

## 5.2 Candidate Event (frontend -> orchestrator)
`POST /sim/session/event`
```json
{
  "session_id": "sess_001",
  "event_type": "candidate_message",
  "ts_sec": 88,
  "data": {
    "source": "voice",
    "text": "I prioritize hotfix first",
    "stt_confidence": 0.92,
    "addressed_to": "tech_lead"
  }
}
```

Supported `event_type`:
- `candidate_message`
- `mic_state_changed` (`data.mic_active`)
- `speech_end`
- `typing_state_changed` (`data.typing`)
- `code_submitted`

## 5.3 Agent Workflow Input (orchestrator -> sub-workflow)
```json
{
  "session_id": "sess_001",
  "role": "qa",
  "turn_goal": "ask_for_repro_or_validation",
  "candidate_last_message": "I can fix now",
  "transcript_tail": [
    {"speaker": "candidate", "text": "..."},
    {"speaker": "tech_lead", "text": "..."}
  ],
  "scenario_context": {
    "bug_summary": "double charge in retry path",
    "business_pressure": "VIP discount launch today"
  },
  "constraints": {
    "max_sentences": 2,
    "max_question_count": 1
  }
}
```

## 5.4 Agent Workflow Output (sub-workflow -> orchestrator)
```json
{
  "agent": "qa",
  "text": "Share your first containment step. I will validate with replay tests.",
  "intent_tag": "qa_repro_validation",
  "needs_followup": true
}
```

## 6) Runtime State (orchestrator)
Stored per session:
- `session_id`
- `started_at_ms`
- `mic_active`
- `typing_last_keystroke_ms`
- `last_speech_end_ms`
- `low_stt_count`
- `pending_turn`
- `last_role`
- `transcript_ref`
- `frontend_agent_webhook`
- `end_callback_webhook`

Derived flags:
- `is_typing = now - typing_last_keystroke_ms <= 3000`
- `is_speaking = mic_active == true`

## 7) Role Decision and Routing
Priority order:
1. Hard anchor due -> force anchor role/action
2. Candidate explicitly addressed role -> route to addressed role
3. Intent route:
- repro/log/testing -> QA
- scope/deadline/impact -> BA
- tradeoff/risk/rollback/implementation -> Tech Lead
4. Default -> Tech Lead

Routed replies preempt non-anchor scheduled turns. Hard anchors are never skipped.

## 8) Turn-Taking and Defer Rules
1. If `mic_active=true`, defer non-anchor message.
2. If typing is active (debounce 3s), defer non-anchor message.
3. Max defer per pending turn: 15s.
4. Resume at `speech_end + 800ms` or when typing stops.
5. If defer limit hit, send concise assumption-based follow-up and continue.

## 9) Silence and STT Rules
Silence:
1. After agent question, wait 12s for candidate response.
2. If none, send one nudge.
3. Wait 8s more.
4. If still none, auto-advance.

STT low confidence:
1. Auto-ingest transcript (no click confirm).
2. If confidence < 0.75, ask brief repeat.
3. If repeated low confidence twice, suggest short typed answer.
4. Do not infer technical intent from low-confidence text.

## 10) Guardrail Postprocess (Mandatory)
Before sending any agent output:
1. Enforce **max 1 question per turn**.
2. Keep 1-3 short sentences.
3. Ensure role fidelity:
- QA: evidence/testing-focused
- BA: scope/deadline/impact-focused
- Tech Lead: prioritization/risk-focused
4. If output violates rules, rewrite in guardrail code node.

## 11) Example Guardrail Transform
Input (invalid):
- "What is priority? What is rollback? What monitoring do you add?"

Output (valid):
- "Pick one now: hotfix first or VIP feature first, and why?"

## 12) Failure Handling
- If sub-workflow/LLM fails:
  - fallback deterministic line by role
  - continue timeline
- If frontend callback fails:
  - retry 2 times (1s, 2s)
- If state update fails:
  - emit warning and keep in-memory fallback for demo run

## 13) Build Order
1. Create `WF_Agent_QA`, `WF_Agent_BA`, `WF_Agent_TechLead`.
2. Build `WF_Main_Orchestrator` with `Execute Workflow` calls.
3. Add guardrail postprocess.
4. Add silence/nudge/auto-advance.
5. Add anchor checks and end callback.
6. Run test matrix:
- speaking continuously
- silent candidate
- explicit `@qa/@ba/@techlead`
- low STT confidence repeated
- BA hard anchor at `T+03:00`
- session end at `T+10:00`
