# DayOne.ai n8n Workflow

## File
- `n8n/workflows/simulhire_mvp_orchestrator.json`

## Import
1. Open n8n.
2. `Workflows` -> `Import from File`.
3. Select `simulhire_mvp_orchestrator.json`.
4. Activate workflow after setting your frontend callback URLs in start payload.

## Webhook Endpoints
- `POST /webhook/sim/session/start`
- `POST /webhook/sim/session/event`

Note:
- If using test URLs in n8n editor, endpoint will include `/webhook-test/...`.

## Start Payload Example
```json
{
  "session_id": "sess_001",
  "candidate_id": "cand_demo",
  "scenario_id": "payment_double_charge_vip_discount_v1",
  "started_at": "2026-02-20T23:00:00Z",
  "frontend_agent_webhook": "http://localhost:3000/sim/session/agent-message",
  "end_callback_webhook": "http://localhost:3000/sim/session/end"
}
```

## Event Payload Example
```json
{
  "session_id": "sess_001",
  "event_type": "candidate_message",
  "data": {
    "source": "voice",
    "text": "I prioritize hotfix first and delay VIP feature",
    "stt_confidence": 0.93,
    "addressed_to": "tech_lead"
  }
}
```

## Supported event_type
- `candidate_message`
- `mic_state_changed` with `data.mic_active`
- `speech_end`
- `typing_state_changed` with `data.typing`

## What this workflow covers
- 10-minute orchestration timeline with anchors.
- BA hard anchor at `T+03:00`.
- End callback at `T+10:00`.
- Event-based state update + basic role routing + STT low-confidence retry prompt.

## Current MVP limitation
- Adaptive window deferral is implemented as event-aware routing + fixed scheduled sends.
- If you want strict `mic_active` hard deferral for every scheduled turn, add guard nodes before each send.
