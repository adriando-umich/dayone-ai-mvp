# DayOne.ai n8n v2 (Architecture B)

## Why 4 JSON files?
- In n8n, each JSON file usually represents **one workflow**.
- This architecture has 4 workflows by design:
  - `WF_Main_Orchestrator` (routing + guardrail + dispatch)
  - `WF_Agent_QA`
  - `WF_Agent_BA`
  - `WF_Agent_TechLead`

They are still one connected system:
- All candidate events go to `WF_Main_Orchestrator`.
- Orchestrator calls the right role workflow.
- Role workflow returns text.
- Orchestrator applies guardrail and sends final message to frontend.

## Import order
1. `WF_Agent_QA.json`
2. `WF_Agent_BA.json`
3. `WF_Agent_TechLead.json`
4. `WF_Main_Orchestrator.json`

## Endpoints
- Start: `POST /webhook/sim/v2/session/start`
- Event: `POST /webhook/sim/v2/session/event`
- QA role: `POST /webhook/sim/v2/agent/qa`
- BA role: `POST /webhook/sim/v2/agent/ba`
- TechLead role: `POST /webhook/sim/v2/agent/techlead`

## Event payload (example)
```json
{
  "session_id": "sess_001",
  "event_type": "candidate_message",
  "frontend_agent_webhook": "http://localhost:3000/sim/session/agent-message",
  "data": {
    "text": "Can QA give repro steps?",
    "addressed_to": "qa"
  }
}
```

## Notes
- Current v2 files are workflow skeletons (role logic in `Code` nodes).
- To use real LLM responses, replace each `Generate ... Reply` code node with your LLM node and keep the same output schema.
