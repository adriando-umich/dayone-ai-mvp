const fs = require("fs");
const path = require("path");
const http = require("http");
const { URL } = require("url");
const {
  COMPANY_CONTEXT,
  AGENT_PERSONAS,
  AUDIENCE_PERSONA
} = require("./agent_personas");

function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnv();

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
const MAX_MESSAGES = 500;
const N8N_START_URL =
  process.env.N8N_START_URL || "http://localhost:5678/webhook/sim/v2a/session/start";
const N8N_EVENT_URL =
  process.env.N8N_EVENT_URL || "http://localhost:5678/webhook/sim/v2a/session/event";
const N8N_AGENT_QA_URL =
  process.env.N8N_AGENT_QA_URL || "http://localhost:5678/webhook/sim/v2a/agent/qa";
const N8N_AGENT_BA_URL =
  process.env.N8N_AGENT_BA_URL || "http://localhost:5678/webhook/sim/v2a/agent/ba";
const N8N_AGENT_TECHLEAD_URL =
  process.env.N8N_AGENT_TECHLEAD_URL || "http://localhost:5678/webhook/sim/v2a/agent/techlead";
const USE_N8N_DIRECT_AGENTS = process.env.USE_N8N_DIRECT_AGENTS === "1";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_ROUTER_MODEL = process.env.OPENAI_ROUTER_MODEL || OPENAI_MODEL;
const OPENAI_HUMANIZER_MODEL = process.env.OPENAI_HUMANIZER_MODEL || OPENAI_MODEL;
const ENABLE_AI_TURN_ROUTER = process.env.ENABLE_AI_TURN_ROUTER !== "0";
const ENABLE_AI_HUMANIZER = process.env.ENABLE_AI_HUMANIZER !== "0";
const STRICT_AI_DECISIONS = process.env.STRICT_AI_DECISIONS === "1";
const PUBLIC_DIR = path.join(__dirname, "web");
const SCENARIO_DIR = path.join(__dirname, "scenario");
const RECORDINGS_DIR = path.join(__dirname, "recordings");
const MAX_RECORDING_BYTES = Number(process.env.MAX_RECORDING_BYTES || 300 * 1024 * 1024);
const messages = [];
const sessions = {};
const evaluations = {};
const sessionRecordings = {};
const AGENT_PLAYBOOK = {
  qa_open_p0: "Open with urgent production impact and ask for first containment action.",
  tech_initial_remediation: "Probe initial remediation direction and expected tradeoff.",
  ba_vip_interrupt: "Inject business deadline pressure and ask for sequencing/ETA.",
  tech_prioritization_challenge: "Force explicit prioritization between hotfix and VIP feature.",
  qa_evidence_pressure: "Request concrete validation evidence and replay-test confidence.",
  tech_risk_probe: "Demand rollback trigger, monitoring signals, and data correction plan.",
  tech_final_challenge: "Close with final decision checkpoint before session end."
};
const ORCH_RETRY_MS = 800;
const ORCH_MAX_DEFER_MS = 15000;
const ORCH_TYPING_GRACE_MS = 3000;
const ORCH_RECENT_CANDIDATE_GRACE_MS = 4500;
const AGENT_DUPLICATE_LOOKBACK = 40;
const AGENT_DUPLICATE_WINDOW_MS = 12000;

if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

function loadPersonaPromptSections() {
  const promptPath = path.join(SCENARIO_DIR, "persona_prompts.md");
  if (!fs.existsSync(promptPath)) {
    return { qa: "", ba: "", tech_lead: "", global: "" };
  }
  const md = fs.readFileSync(promptPath, "utf8");
  const section = (start, endMarkers = []) => {
    const startIdx = md.indexOf(start);
    if (startIdx < 0) return "";
    let endIdx = md.length;
    for (const marker of endMarkers) {
      const idx = md.indexOf(marker, startIdx + start.length);
      if (idx >= 0 && idx < endIdx) endIdx = idx;
    }
    return md.slice(startIdx, endIdx).trim();
  };
  return {
    qa: section("## AI QA Engineer", ["## AI Business Analyst (BA)"]),
    ba: section("## AI Business Analyst (BA)", ["## AI Tech Lead"]),
    tech_lead: section("## AI Tech Lead", ["## Global Orchestrator Guardrails"]),
    global: section("## Global Orchestrator Guardrails")
  };
}

const PERSONA_PROMPTS = loadPersonaPromptSections();

function loadIncidentBrief() {
  const defaultBrief = {
    incident_id: "INC-PAY-2201",
    title: "Duplicate charge during gateway retry path",
    severity: "P0",
    summary:
      "A subset of checkout orders are charged twice when timeout + retry happens without idempotency enforcement.",
    signals: {
      duplicate_orders: 17,
      estimated_loss_usd: 1840
    },
    known_root_cause_hypothesis:
      "Idempotency key exists but is not enforced before chargeGateway call.",
    unknowns: [
      "Exact affected rate is not fully confirmed yet."
    ],
    role_notes: {
      qa: [],
      ba: [],
      tech_lead: []
    }
  };
  const briefPath = path.join(SCENARIO_DIR, "incident_brief.json");
  if (!fs.existsSync(briefPath)) return defaultBrief;
  try {
    const raw = fs.readFileSync(briefPath, "utf8");
    const parsed = JSON.parse(raw);
    return { ...defaultBrief, ...parsed };
  } catch {
    return defaultBrief;
  }
}

const INCIDENT_BRIEF = loadIncidentBrief();

function buildIncidentFactPackForPrompt(role) {
  const normalizedRole = normalizeRole(role);
  const b = INCIDENT_BRIEF || {};
  const timeline = b.timeline || {};
  const signals = b.signals || {};
  const impact = b.impact_scope || {};
  const controls = b.available_controls || {};
  const roleNotes = (b.role_notes && b.role_notes[normalizedRole]) || [];
  const unknowns = Array.isArray(b.unknowns) ? b.unknowns : [];
  const containment = Array.isArray(controls.containment_options) ? controls.containment_options : [];
  const rollback = Array.isArray(controls.rollback_options) ? controls.rollback_options : [];
  const validation = Array.isArray(controls.validation_signals) ? controls.validation_signals : [];

  return [
    `Incident ID: ${b.incident_id || "INC-PAY-2201"}`,
    `Title: ${b.title || ""}`,
    `Severity: ${b.severity || "P0"}`,
    `Summary: ${b.summary || ""}`,
    `Detected: ${timeline.detected_at_utc || "unknown"}`,
    `Signals: duplicate_orders=${signals.duplicate_orders ?? "unknown"}, estimated_loss_usd=${signals.estimated_loss_usd ?? "unknown"}, example_order=${signals.latest_example_order_id || "unknown"}`,
    `Impact scope: channel=${impact.channel || "unknown"}; affected_users=${impact.affected_users || "unknown"}; customer_risk=${impact.customer_risk || "unknown"}`,
    `Root cause hypothesis: ${b.known_root_cause_hypothesis || "unknown"}`,
    `Containment options: ${containment.slice(0, 3).join(" | ") || "unknown"}`,
    `Rollback options: ${rollback.slice(0, 3).join(" | ") || "unknown"}`,
    `Validation signals: ${validation.slice(0, 3).join(" | ") || "unknown"}`,
    `Unknowns: ${unknowns.slice(0, 3).join(" | ") || "none"}`,
    `Role notes: ${roleNotes.join(" | ") || "none"}`
  ].join("\n");
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function notFound(res) {
  sendJson(res, 404, { ok: false, error: "not_found" });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString("utf8");
      if (raw.length > 1024 * 1024) {
        reject(new Error("payload_too_large"));
      }
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function readBinaryBody(req, maxBytes = MAX_RECORDING_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        reject(new Error("payload_too_large"));
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

function sanitizeToken(value, fallback = "item") {
  const safe = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return safe || fallback;
}

function extensionFromMimeType(mimeType) {
  const m = String(mimeType || "").toLowerCase();
  if (m.includes("video/webm")) return "webm";
  if (m.includes("video/mp4")) return "mp4";
  if (m.includes("video/quicktime")) return "mov";
  return "webm";
}

function contentTypeFromExtension(ext) {
  const e = String(ext || "").toLowerCase();
  if (e === "mp4") return "video/mp4";
  if (e === "mov") return "video/quicktime";
  return "video/webm";
}

function getLatestRecording(sessionId) {
  const list = sessionRecordings[sessionId] || [];
  if (!list.length) return null;
  return list[list.length - 1];
}

function pushMessage(payload) {
  if (shouldSkipDuplicateAgentMessage(payload)) {
    return false;
  }
  const item = {
    received_at: new Date().toISOString(),
    payload
  };
  messages.push(item);
  if (messages.length > MAX_MESSAGES) {
    messages.shift();
  }
  return true;
}

function shouldSkipDuplicateAgentMessage(payload) {
  const sessionId = String(payload?.session_id || "").trim();
  const role = normalizeRole(payload?.agent || "");
  if (!sessionId) return false;
  if (!role || !["qa", "ba", "tech_lead"].includes(role)) return false;

  const nextText = normalizeTextForCompare(payload?.text || "");
  if (!nextText) return false;

  const now = Date.now();
  let scanned = 0;
  for (let i = messages.length - 1; i >= 0 && scanned < AGENT_DUPLICATE_LOOKBACK; i -= 1, scanned += 1) {
    const row = messages[i] || {};
    const prevPayload = row.payload || {};
    if (String(prevPayload.session_id || "") !== sessionId) continue;
    if (normalizeRole(prevPayload.agent || "") !== role) continue;
    const prevText = normalizeTextForCompare(prevPayload.text || "");
    if (!prevText || prevText !== nextText) continue;
    const prevAt = Date.parse(row.received_at || "");
    if (Number.isFinite(prevAt) && now - prevAt > AGENT_DUPLICATE_WINDOW_MS) continue;
    console.log(`[message-dedupe] skip role=${role} session=${sessionId} text="${String(payload.text || "").slice(0, 120)}"`);
    return true;
  }
  return false;
}

function getSession(sessionId) {
  return sessions[sessionId] || null;
}

function ensureSession(sessionId) {
  if (!sessions[sessionId]) {
    sessions[sessionId] = {
      session_id: sessionId,
      started_at_ms: Date.now(),
      end_at_ms: Date.now() + 10 * 60 * 1000,
      ended: false,
      runtime: null
    };
  }
  return sessions[sessionId];
}

function buildTurnPlan(durationSec = 600) {
  const isFastMode = durationSec <= 90;
  if (isFastMode) {
    return [
      { role: "qa", intent: "qa_open_p0", window_start_sec: 0, window_end_sec: 2, anchor: false },
      { role: "tech_lead", intent: "tech_initial_remediation", window_start_sec: 6, window_end_sec: 10, anchor: false },
      { role: "ba", intent: "ba_vip_interrupt", window_start_sec: 18, window_end_sec: 18, anchor: true },
      { role: "tech_lead", intent: "tech_prioritization_challenge", window_start_sec: 22, window_end_sec: 28, anchor: false },
      { role: "qa", intent: "qa_evidence_pressure", window_start_sec: 34, window_end_sec: 40, anchor: false },
      { role: "tech_lead", intent: "tech_risk_probe", window_start_sec: 42, window_end_sec: 47, anchor: false },
      { role: "tech_lead", intent: "tech_final_challenge", window_start_sec: 52, window_end_sec: 56, anchor: false }
    ];
  }
  return [
    { role: "qa", intent: "qa_open_p0", window_start_sec: 0, window_end_sec: 30, anchor: false },
    { role: "tech_lead", intent: "tech_initial_remediation", window_start_sec: 60, window_end_sec: 105, anchor: false },
    { role: "ba", intent: "ba_vip_interrupt", window_start_sec: 180, window_end_sec: 180, anchor: true },
    { role: "tech_lead", intent: "tech_prioritization_challenge", window_start_sec: 210, window_end_sec: 270, anchor: false },
    { role: "qa", intent: "qa_evidence_pressure", window_start_sec: 360, window_end_sec: 405, anchor: false },
    { role: "tech_lead", intent: "tech_risk_probe", window_start_sec: 420, window_end_sec: 465, anchor: false },
    { role: "tech_lead", intent: "tech_final_challenge", window_start_sec: 540, window_end_sec: 570, anchor: false }
  ];
}

function materializeTurnPlan(durationSec = 600) {
  return buildTurnPlan(durationSec).map((turn) => {
    if (turn.anchor) {
      return { ...turn, scheduled_start_sec: turn.window_start_sec };
    }
    const min = Math.floor(turn.window_start_sec);
    const max = Math.floor(turn.window_end_sec);
    const scheduled = Math.floor(Math.random() * (max - min + 1)) + min;
    return { ...turn, scheduled_start_sec: scheduled };
  });
}

function clearSessionOrchestrator(sessionId) {
  const s = getSession(sessionId);
  if (!s || !s.runtime || !s.runtime.orchestrator) return;
  if (s.runtime.orchestrator.timer) {
    clearTimeout(s.runtime.orchestrator.timer);
    s.runtime.orchestrator.timer = null;
  }
}

function ensureSessionRuntime(sessionId, durationSec = 600) {
  const s = ensureSession(sessionId);
  if (!s.runtime) {
    s.runtime = {
      mic_active: false,
      typing_active: false,
      last_typing_at_ms: 0,
      last_candidate_event_ms: 0,
      orchestrator: {
        plan: materializeTurnPlan(durationSec),
        current_index: 0,
        timer: null,
        duration_sec: durationSec
      }
    };
    return s.runtime;
  }
  s.runtime.mic_active = false;
  s.runtime.typing_active = false;
  s.runtime.last_typing_at_ms = 0;
  s.runtime.last_candidate_event_ms = 0;
  s.runtime.orchestrator = {
    plan: materializeTurnPlan(durationSec),
    current_index: 0,
    timer: null,
    duration_sec: durationSec
  };
  return s.runtime;
}

function isTypingActive(session) {
  if (!session?.runtime?.typing_active) return false;
  return Date.now() - Number(session.runtime.last_typing_at_ms || 0) <= ORCH_TYPING_GRACE_MS;
}

function scheduleOrchestratorTick(sessionId, delayMs) {
  const s = getSession(sessionId);
  if (!s || !s.runtime?.orchestrator) return;
  clearSessionOrchestrator(sessionId);
  s.runtime.orchestrator.timer = setTimeout(() => {
    runOrchestratorTick(sessionId).catch((err) => {
      console.error(`[orchestrator] session=${sessionId} error=${String(err && err.message ? err.message : err)}`);
    });
  }, Math.max(0, delayMs));
}

async function runOrchestratorTick(sessionId) {
  const s = getSession(sessionId);
  if (!s || isSessionEnded(sessionId)) {
    clearSessionOrchestrator(sessionId);
    return;
  }
  const orch = s.runtime?.orchestrator;
  if (!orch) return;
  if (orch.current_index >= orch.plan.length) {
    clearSessionOrchestrator(sessionId);
    return;
  }

  const turn = orch.plan[orch.current_index];
  const now = Date.now();
  const plannedStartSec = Number(turn.scheduled_start_sec ?? turn.window_start_sec);
  const windowStartMs = s.started_at_ms + plannedStartSec * 1000;
  const windowEndMs = s.started_at_ms + turn.window_end_sec * 1000;
  if (now < windowStartMs) {
    scheduleOrchestratorTick(sessionId, windowStartMs - now);
    return;
  }

  const blockedByMic = !turn.anchor && !!s.runtime?.mic_active;
  const blockedByTyping = !turn.anchor && isTypingActive(s);
  const blockedByRecentCandidate =
    !turn.anchor &&
    now - Number(s.runtime?.last_candidate_event_ms || 0) <= ORCH_RECENT_CANDIDATE_GRACE_MS;
  const blocked = blockedByMic || blockedByTyping || blockedByRecentCandidate;
  const deferDeadlineMs = Math.min(windowEndMs, windowStartMs + ORCH_MAX_DEFER_MS);

  if (blocked && now < deferDeadlineMs) {
    scheduleOrchestratorTick(sessionId, ORCH_RETRY_MS);
    return;
  }

  const transition = blocked || now > windowStartMs + 1000;
  const reason = blocked
    ? "defer_limit_reached"
    : (now > windowEndMs ? "window_closed" : (now > windowStartMs ? "deferred" : "on_time"));
  const seed = [
    `intent:${turn.intent}`,
    `role:${turn.role}`,
    `anchor:${turn.anchor ? 1 : 0}`,
    `transition:${transition ? 1 : 0}`,
    `reason:${reason}`,
    `window:${turn.window_start_sec}-${turn.window_end_sec}`,
    `planned:${plannedStartSec}`
  ].join(" ");

  console.log(
    `[orchestrator] session=${sessionId} role=${turn.role} intent=${turn.intent} reason=${reason} transition=${transition ? 1 : 0}`
  );
  await callAgentDirect(turn.role, sessionId, seed);
  orch.current_index += 1;
  scheduleOrchestratorTick(sessionId, 50);
}

function startSessionOrchestrator(sessionId, durationSec) {
  ensureSessionRuntime(sessionId, durationSec);
  scheduleOrchestratorTick(sessionId, 100);
}

function isSessionEnded(sessionId) {
  const s = getSession(sessionId);
  return !!(s && (s.ended || Date.now() >= s.end_at_ms));
}

function getSessionMessages(sessionId) {
  return messages.filter((m) => String(m.payload?.session_id || "") === sessionId);
}

function latestCandidateCode(sessionId) {
  const sessionMessages = getSessionMessages(sessionId);
  for (let i = sessionMessages.length - 1; i >= 0; i--) {
    const p = sessionMessages[i].payload || {};
    if (p.agent === "candidate" && p.kind === "candidate_code") {
      return String(p.text || "");
    }
  }
  return "";
}

function countWords(text) {
  const parts = String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return parts.length;
}

function buildPlaceholderVoiceVideoAnalysis(candidateDialogueTexts, recordingSummary, rubric = {}) {
  const turns = Array.isArray(candidateDialogueTexts)
    ? candidateDialogueTexts.filter((t) => String(t || "").trim().length > 0)
    : [];
  const observedTurns = turns.length;
  const observedWords = turns.reduce((sum, t) => sum + countWords(t), 0);
  const avgWordsPerTurn = observedTurns > 0 ? observedWords / observedTurns : 0;

  const communicationScore = Number(rubric.communication_clarity || 0);
  const technicalScore = Number(rubric.technical_correctness || 0);
  const clamp100 = (value) => Math.max(0, Math.min(100, Math.round(value)));

  const simulatedVoiceClarity = clamp100(40 + communicationScore * 8 + Math.min(avgWordsPerTurn, 22));
  const simulatedVoiceConfidence = clamp100(38 + communicationScore * 9 + Math.min(avgWordsPerTurn * 0.9, 20));
  const simulatedVoiceComposure = clamp100(34 + communicationScore * 10 + (observedTurns >= 4 ? 9 : 2));
  const simulatedVoiceTone = clamp100(32 + communicationScore * 8 + technicalScore * 4);
  const simulatedVoiceRhythm = clamp100(
    30 + communicationScore * 7 + (observedTurns >= 5 ? 11 : observedTurns >= 2 ? 5 : 0)
  );

  const simulatedPacing =
    observedTurns >= 5 ? "steady" : observedTurns >= 2 ? "slightly_short" : "insufficient_data";
  const recordingPresence = recordingSummary ? "webcam_overlay_detected" : "not_detected";
  const simulatedVideoEngagement = clamp100((recordingSummary ? 56 : 26) + communicationScore * 6 + technicalScore * 2);
  const simulatedVideoComposure = clamp100((recordingSummary ? 52 : 24) + communicationScore * 6);
  const simulatedVideoTone = clamp100((recordingSummary ? 48 : 20) + communicationScore * 5 + technicalScore * 3);
  const simulatedVideoRhythm = clamp100((recordingSummary ? 50 : 22) + communicationScore * 6 + (observedTurns >= 4 ? 6 : 0));

  const voiceSummary =
    observedTurns === 0
      ? "No candidate speech text detected in this session window."
      : `Speech trace suggests ${simulatedPacing.replaceAll("_", " ")} delivery with simulated clarity ${simulatedVoiceClarity}/100.`;
  const videoSummary = recordingSummary
    ? `Interview capture file exists; simulated visual engagement is ${simulatedVideoEngagement}/100.`
    : "No interview recording file found; simulated visual metrics are low-confidence.";

  return {
    mode: "placeholder_not_real",
    mvp_placeholder: true,
    voice: {
      simulated_clarity_score: simulatedVoiceClarity,
      simulated_pacing: simulatedPacing,
      criteria: {
        confidence: simulatedVoiceConfidence,
        composure: simulatedVoiceComposure,
        tone: simulatedVoiceTone,
        rhythm: simulatedVoiceRhythm
      },
      observed_turns: observedTurns,
      observed_words: observedWords,
      average_words_per_turn: Number(avgWordsPerTurn.toFixed(1)),
      summary: voiceSummary
    },
    video: {
      simulated_engagement_score: simulatedVideoEngagement,
      recording_presence: recordingPresence,
      criteria: {
        confidence: simulatedVideoEngagement,
        composure: simulatedVideoComposure,
        tone: simulatedVideoTone,
        rhythm: simulatedVideoRhythm
      },
      recording_size_bytes: Number(recordingSummary?.size_bytes || 0),
      summary: videoSummary
    },
    disclaimer:
      "DayOne.ai MVP note: this is not real analysis data; it is a placeholder in the MVP, and automated voice/video analysis is still under development."
  };
}

function evaluateSession(sessionId) {
  const sessionMessages = getSessionMessages(sessionId);
  const candidatePayloads = sessionMessages
    .map((m) => m.payload || {})
    .filter((p) => p.agent === "candidate");
  const candidateTexts = candidatePayloads.map((p) => String(p.text || "").toLowerCase());
  const candidateDialogueTexts = candidatePayloads
    .filter((p) => String(p.kind || "") !== "candidate_code")
    .map((p) => String(p.text || ""));
  const merged = candidateTexts.join("\n");
  const code = latestCandidateCode(sessionId).toLowerCase();

  const prioritization =
    /(hotfix|p0|priority|prioritize|first|defer|vip later|feature later)/.test(merged) ? 4 : 2;
  const technical =
    /(idempot|retry|dedup|duplicate|guard|key|rollback|monitor)/.test(merged + "\n" + code) ? 4 : 2;
  const risk =
    /(rollback|monitor|alert|mitigat|customer|refund|reconcile|impact)/.test(merged) ? 4 : 2;
  const communication =
    candidateTexts.length >= 3 ? 4 : candidateTexts.length >= 1 ? 3 : 1;

  const scoreTotal = prioritization + technical + risk + communication;
  const maxTotal = 20;
  const recommendation = scoreTotal >= 16 ? "Yes" : scoreTotal >= 12 ? "Maybe" : "No";
  const latestRecording = getLatestRecording(sessionId);
  const recordingSummary = latestRecording
    ? {
      file_name: latestRecording.file_name,
      url: latestRecording.url,
      mime_type: latestRecording.mime_type,
      size_bytes: latestRecording.size_bytes,
      created_at: latestRecording.created_at
    }
    : null;
  const voiceVideoAnalysis = buildPlaceholderVoiceVideoAnalysis(candidateDialogueTexts, recordingSummary, {
    communication_clarity: communication,
    technical_correctness: technical
  });

  return {
    session_id: sessionId,
    generated_at: new Date().toISOString(),
    recommendation,
    total_score: scoreTotal,
    max_score: maxTotal,
    rubric: {
      prioritization_under_pressure: prioritization,
      technical_correctness: technical,
      production_risk_awareness: risk,
      communication_clarity: communication
    },
    summary:
      recommendation === "Yes"
        ? "Candidate demonstrated strong prioritization, technical direction, and risk awareness under pressure."
        : recommendation === "Maybe"
          ? "Candidate showed partial incident handling skills but needs clearer prioritization or risk framing."
          : "Candidate responses lacked sufficient prioritization and production-safe execution detail.",
    recording: recordingSummary,
    voice_video_analysis: voiceVideoAnalysis
  };
}

function normalizeRole(role) {
  const raw = String(role || "").toLowerCase();
  if (raw === "techlead") return "tech_lead";
  return raw;
}

function normalizeTextForCompare(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isStallOrLowValueQuestion(text) {
  const n = normalizeTextForCompare(text);
  if (!n) return true;
  const bannedPatterns = [
    /quick second to process/,
    /restate your last point/,
    /can you restate/,
    /can you clarify your decision/,
    /i need a second/
  ];
  return bannedPatterns.some((re) => re.test(n));
}

function isRecentDuplicateRoleQuestion(sessionId, role, text, lookback = 5) {
  const normalizedRole = normalizeRole(role);
  const n = normalizeTextForCompare(text);
  if (!n) return false;
  const rows = getSessionMessages(sessionId).slice(-lookback).reverse();
  for (const row of rows) {
    const p = row.payload || {};
    if (normalizeRole(p.agent) !== normalizedRole) continue;
    const prev = normalizeTextForCompare(p.text || "");
    if (prev && prev === n) return true;
  }
  return false;
}

function isImmediateSameRoleTurn(sessionId, role) {
  const rows = getSessionMessages(sessionId);
  if (!rows.length) return false;
  const lastPayload = rows[rows.length - 1].payload || {};
  const lastAgent = normalizeRole(String(lastPayload.agent || ""));
  return !!lastAgent && lastAgent !== "candidate" && lastAgent === normalizeRole(role);
}

function parseJsonObject(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const candidates = [text];
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function extractResponseOutputText(data) {
  if (!data || typeof data !== "object") return "";
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }
  const outputs = Array.isArray(data.output) ? data.output : [];
  for (const item of outputs) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (part && part.type === "output_text" && typeof part.text === "string" && part.text.trim()) {
        return part.text.trim();
      }
    }
  }
  return "";
}

function getRoleScopedMissingItems(role, missingItems = []) {
  const normalizedRole = normalizeRole(role);
  const base = Array.isArray(missingItems) ? missingItems : [];
  if (normalizedRole === "qa") {
    return base.filter((item) => item === "containment" || item === "validation");
  }
  if (normalizedRole === "ba") {
    return base.filter((item) => item === "prioritization");
  }
  return base;
}

async function llmHumanizeAgentMessage(
  role,
  sessionId,
  draftText,
  workstream = null,
  focusDecision = null,
  candidateMessage = ""
) {
  const normalizedRole = normalizeRole(role);
  const original = String(draftText || "").replace(/\s+/g, " ").trim();
  const fallback = { text: original, changed: false, violation: "" };
  if (!original) return fallback;
  if (!OPENAI_API_KEY || !ENABLE_AI_HUMANIZER) return fallback;

  const focus = String(focusDecision?.focus || "unknown").trim();
  const aiNudge = String(focusDecision?.nudge || "").trim();
  const roleScope =
    normalizedRole === "qa"
      ? "QA scope: evidence-first containment and validation. Urgent but collaborative."
      : normalizedRole === "ba"
        ? "BA scope: business urgency, sequencing, ETA, stakeholder communication. Do not ask implementation detail."
        : "Tech Lead scope: risk trade-offs, rollback/monitoring gates, and explicit execution decisions.";

  const systemPrompt = [
    "You rewrite one teammate chat bubble in a live production-incident simulation.",
    "Goal: keep the original intent and pressure, but sound natural and human, not robotic.",
    "Keep candidate focused on incident execution; no casual chat.",
    roleScope,
    "Return ONLY JSON with exact shape:",
    "{\"message\":\"...\",\"role_violation\":\"none|qa_scope_drift|ba_scope_drift|tech_lead_scope_drift\"}",
    "message rules: single short chat bubble, 1-2 sentences, max 45 words, one focused question at most.",
    "Never use label-list style like 'Urgent:', 'Root cause:', 'Containment:', 'Action now:', 'Main follow-up:'.",
    "No markdown. No bullet points. No prose outside JSON."
  ].join(" ");

  const inputText = [
    `Role: ${normalizedRole}`,
    `Draft message: ${original}`,
    `Candidate latest message: ${String(candidateMessage || "").trim() || "(none)"}`,
    `Focus classification: ${focus}`,
    aiNudge ? `Focus nudge hint: ${aiNudge}` : "",
    workstream ? `Workstream summary: ${String(workstream.summary || "").trim()}` : "",
    "Recent transcript:",
    getRecentTranscript(sessionId, 16) || "(none)"
  ].filter(Boolean).join("\n");

  try {
    const modelName = String(OPENAI_HUMANIZER_MODEL || "").toLowerCase();
    const isGpt5Model = modelName.startsWith("gpt-5");
    const reqBody = {
      model: OPENAI_HUMANIZER_MODEL,
      max_output_tokens: isGpt5Model ? 240 : 140,
      input: [
        { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
        { role: "user", content: [{ type: "input_text", text: inputText }] }
      ]
    };
    if (isGpt5Model) {
      reqBody.reasoning = { effort: "minimal" };
      reqBody.text = { verbosity: "low" };
    } else {
      reqBody.temperature = 0.2;
    }

    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify(reqBody)
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`humanizer_http_${res.status}:${errText.slice(0, 200)}`);
    }

    const data = await res.json();
    const raw = extractResponseOutputText(data);
    const parsed = parseJsonObject(raw);
    let rewritten = "";
    let violation = "";
    if (parsed) {
      rewritten = String(parsed.message || "").replace(/\s+/g, " ").trim();
      violation = String(parsed.role_violation || "").trim().toLowerCase();
    }
    if (!rewritten) {
      const parsedMessages = parseAgentMessages(raw);
      rewritten = String(parsedMessages[0] || "").replace(/\s+/g, " ").trim();
    }
    if (!rewritten) return fallback;
    return {
      text: rewritten,
      changed: normalizeTextForCompare(rewritten) !== normalizeTextForCompare(original),
      violation: violation && violation !== "none" ? violation : ""
    };
  } catch (err) {
    console.error(
      `[agent-humanizer] role=${normalizedRole} err=${String(err && err.message ? err.message : err)}`
    );
    return fallback;
  }
}

function parseAgentMessages(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(text.slice(start, end + 1));
      } catch {
        parsed = null;
      }
    }
  }

  if (parsed && Array.isArray(parsed.messages)) {
    return parsed.messages
      .map((m) => String(m || "").replace(/\r/g, "").trim())
      .filter(Boolean)
      .slice(0, 3);
  }
  return [text.replace(/\r/g, "").trim()];
}

function duplicateBreaker(role, candidateMessage) {
  const normalizedRole = normalizeRole(role);
  const q = String(candidateMessage || "").replace(/\s+/g, " ").trim();
  const shortQ = q.length > 80 ? `${q.slice(0, 80)}...` : q;
  if (normalizedRole === "qa") {
    return `On your question "${shortQ}", quick context: duplicate charges come from idempotency not being enforced before gateway charge.`;
  }
  if (normalizedRole === "ba") {
    return `On "${shortQ}", business context is VIP urgency versus incident risk; we need sequencing and ETA that stakeholders can trust.`;
  }
  if (normalizedRole === "tech_lead") {
    return `On "${shortQ}", we are balancing safe containment, rollback readiness, and release sequencing under production risk.`;
  }
  return `On "${shortQ}", here is the key context we should align on before the next step.`;
}

function getRecentTranscript(sessionId, limit = 10) {
  return getSessionMessages(sessionId)
    .slice(-limit)
    .map((m) => {
      const p = m.payload || {};
      return `${p.agent || "system"}: ${String(p.text || "").trim()}`;
    })
    .join("\n");
}

function getFullTranscript(sessionId) {
  return getSessionMessages(sessionId)
    .map((m) => {
      const p = m.payload || {};
      return `${p.agent || "system"}: ${String(p.text || "").trim()}`;
    })
    .join("\n");
}

function getRoleFocusedHistory(sessionId, role, limit = 80) {
  const rows = getSessionMessages(sessionId);
  const normalizedRole = normalizeRole(role);
  const relevant = rows.filter((m) => {
    const p = m.payload || {};
    const agent = String(p.agent || "");
    const addressedTo = normalizeRole(String(p.meta?.addressed_to || p.addressed_to || ""));
    if (agent === normalizedRole) return true;
    if (agent === "candidate" && addressedTo === normalizedRole) return true;
    return false;
  });
  return relevant
    .slice(-limit)
    .map((m) => {
      const p = m.payload || {};
      return `${p.agent || "system"}: ${String(p.text || "").trim()}`;
    })
    .join("\n");
}

function getCrossRoleContextForTechLead(sessionId, limit = 120) {
  const rows = getSessionMessages(sessionId);
  const relevant = rows.filter((m) => {
    const p = m.payload || {};
    const agent = String(p.agent || "");
    const addressedTo = normalizeRole(String(p.meta?.addressed_to || p.addressed_to || ""));
    const isQAThread = agent === "qa" || addressedTo === "qa";
    const isBAThread = agent === "ba" || addressedTo === "ba";
    const isCandidate = agent === "candidate";
    return isQAThread || isBAThread || isCandidate;
  });
  return relevant
    .slice(-limit)
    .map((m) => {
      const p = m.payload || {};
      return `${p.agent || "system"}: ${String(p.text || "").trim()}`;
    })
    .join("\n");
}

function getSessionWorkstreamState(sessionId) {
  const sessionRows = getSessionMessages(sessionId);
  const sessionMessages = sessionRows.map((m) => m.payload || {});
  const candidateMessages = sessionMessages.filter((p) => p.agent === "candidate");
  const agentMessages = sessionMessages.filter((p) => p.agent && p.agent !== "candidate");
  const merged = candidateMessages.map((p) => String(p.text || "")).join("\n").toLowerCase();
  const latestCandidate = candidateMessages.length
    ? String(candidateMessages[candidateMessages.length - 1].text || "")
    : "";
  const lastCandidateRow = [...sessionRows].reverse().find((m) => (m.payload || {}).agent === "candidate");
  const lastAgentRow = [...sessionRows].reverse().find((m) => {
    const a = (m.payload || {}).agent;
    return a && a !== "candidate";
  });
  const latestCandidateAt = lastCandidateRow ? Date.parse(lastCandidateRow.received_at || "") : 0;
  const latestAgentAt = lastAgentRow ? Date.parse(lastAgentRow.received_at || "") : 0;
  const now = Date.now();

  const state = {
    incident: "payment_double_charge_vs_vip_discount",
    qaOpened: sessionMessages.some((p) => p.agent === "qa"),
    baInterrupted: sessionMessages.some((p) => p.agent === "ba"),
    techLeadSpoke: sessionMessages.some((p) => p.agent === "tech_lead"),
    candidateResponded: candidateMessages.length > 0,
    candidateSilenceSec: latestCandidateAt ? Math.max(0, Math.floor((now - latestCandidateAt) / 1000)) : 9999,
    recentAgentPromptSec: latestAgentAt ? Math.max(0, Math.floor((now - latestAgentAt) / 1000)) : 9999,
    latestCandidate,
    checklist: {
      containment: /(contain|block|disable|mitigat|stop charge|kill switch|guard)/.test(merged),
      validation: /(test|repro|replay|log|metric|evidence|verify|validation)/.test(merged),
      prioritization: /(hotfix first|vip first|priority|prioritiz|defer|sequence)/.test(merged),
      rollback: /(rollback|roll back|revert|feature flag|fallback)/.test(merged),
      monitoring: /(monitor|alert|dashboard|observe|signal|slo|metric)/.test(merged),
      dataCorrection: /(refund|reconcile|reconciliation|data correction|compensat)/.test(merged)
    }
  };

  const missing = Object.entries(state.checklist)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  state.missingItems = missing;
  state.summary = [
    `qa_opened=${state.qaOpened}`,
    `ba_interrupted=${state.baInterrupted}`,
    `candidate_responded=${state.candidateResponded}`,
    `missing=${missing.join(",") || "none"}`
  ].join(" | ");
  return state;
}

function heuristicAgentReply(role, candidateMessage) {
  const normalizedRole = normalizeRole(role);
  const msg = String(candidateMessage || "").toLowerCase();
  const intentMatch = msg.match(/intent:([a-z0-9_]+)/);
  const intent = intentMatch ? intentMatch[1] : "";
  const brief = INCIDENT_BRIEF || {};
  const signals = brief.signals || {};
  const impactScope = brief.impact_scope || {};
  const duplicateOrders = signals.duplicate_orders ?? "some";
  const lossUsd = signals.estimated_loss_usd ?? "unknown";
  const sampleOrder = signals.latest_example_order_id || "a recent order";
  const sampleTxIds = Array.isArray(signals.latest_example_tx_ids)
    ? signals.latest_example_tx_ids.filter(Boolean)
    : [];
  const cause = brief.known_root_cause_hypothesis || "idempotency not enforced before charging";
  const validationSignals =
    (brief.available_controls && Array.isArray(brief.available_controls.validation_signals))
      ? brief.available_controls.validation_signals
      : [];
  const rollbackOptions =
    (brief.available_controls && Array.isArray(brief.available_controls.rollback_options))
      ? brief.available_controls.rollback_options
      : [];
  const endpointHint = impactScope.channel
    ? `${impactScope.channel} checkout payment flow`
    : "checkout payment flow";
  const isSmallTalk =
    /^(hi|hello|hey|yo|sup)\b/.test(msg) ||
    /\b(how are you|how're you|how r you|what's up|whats up|you good|u good)\b/.test(msg);

  if (isSmallTalk) {
    if (normalizedRole === "qa") {
      return `Doing okay, thanks. We still have an active duplicate-charge incident in ${endpointHint}; can we lock your next containment step now?`;
    }
    if (normalizedRole === "ba") {
      return `All good, thanks. We are still balancing incident risk and VIP timeline pressure; what sequencing/ETA should I communicate?`;
    }
    if (normalizedRole === "tech_lead") {
      return `I am good. Let us stay focused on the incident: confirm your next technical action plus rollback/monitoring guardrails.`;
    }
  }

  if (
    normalizedRole === "qa" &&
    /(please send|send me|share|provide|give me|need)/.test(msg) &&
    /(endpoint|duplicate|count|sample|order|tx|id|log)/.test(msg)
  ) {
    const txText = sampleTxIds.length ? `; txIds: ${sampleTxIds.join(", ")}` : "";
    return `Sure. Current known facts: affected flow is ${endpointHint}; duplicate count estimate is ${duplicateOrders} in the recent window; confirmed sample order is ${sampleOrder}${txText}. I do not have a second confirmed order ID yet, I am pulling the next one from reconciliation logs now.`;
  }

  if (/(clarify|what do you mean|can you explain|not clear|elaborate)/.test(msg)) {
    if (normalizedRole === "qa") {
      return `Sure. We already saw duplicates on ${sampleOrder}, and current estimate is ${duplicateOrders} affected orders. I need your first containment action plus one validation signal.`;
    }
    if (normalizedRole === "ba") {
      return `Sure. We have a live P0 with about ${duplicateOrders} impacted orders and ~$${lossUsd} estimated exposure. I need sequencing and ETA for stakeholder update.`;
    }
    if (normalizedRole === "tech_lead") {
      return `Sure. Current hypothesis is ${cause}. I need your concrete decision path with rollback and monitoring so we can move safely.`;
    }
  }
  if (/(describe the problem|what is the problem|what problem|what happened|what issue)/.test(msg)) {
    if (normalizedRole === "qa") {
      return `We have duplicate payment charges in production. Logs show two successful tx for ${sampleOrder}, and likely cause is ${cause}.`;
    }
    if (normalizedRole === "ba") {
      return `We have a production double-charge incident (${duplicateOrders} orders affected so far) while business is pushing VIP discount launch today.`;
    }
    if (normalizedRole === "tech_lead") {
      return `Current case: duplicate charges in production due to idempotency gap, with concurrent pressure to ship VIP discount. I want containment first, then controlled release sequencing.`;
    }
  }
  if (!intent && msg.includes("?")) {
    if (normalizedRole === "qa") {
      return `Known now: about ${duplicateOrders} impacted orders, confirmed example ${sampleOrder}, and likely cause is ${cause}. I can share repro/log detail next if helpful.`;
    }
    if (normalizedRole === "ba") {
      return `Business context: VIP launch pressure is active while P0 risk is live (~$${lossUsd} estimated exposure). I need sequencing and ETA we can communicate confidently.`;
    }
    if (normalizedRole === "tech_lead") {
      return `Technical context: likely idempotency gap before charge call. I need a concrete path with containment first, then rollback and monitoring safeguards.`;
    }
  }

  if (intent === "qa_open_p0") {
    return "We need immediate containment for duplicate charges. What first action should we align on?";
  }
  if (intent === "qa_evidence_pressure") {
    return `Before we call this stable, what concrete validation signal should we use? One option is: ${validationSignals[0] || "no new duplicate-charge log in rolling window"}.`;
  }
  if (intent === "ba_vip_interrupt") {
    return "Leadership needs sequencing and ETA. How should we frame hotfix vs VIP rollout?";
  }
  if (intent === "tech_initial_remediation") {
    return "Given current incident context, what remediation path should we take first and why?";
  }
  if (intent === "tech_prioritization_challenge") {
    return "We need a priority call now. Should we execute hotfix first or VIP first?";
  }
  if (intent === "tech_risk_probe") {
    return "Let us lock operational safety. What rollback trigger, monitoring signal, and correction path do we use?";
  }
  if (intent === "tech_final_challenge") {
    return "Before close, what is our final release decision and risk tradeoff?";
  }

  if (normalizedRole === "qa") {
    if (/(idempot|guard|chargegateway|existing result|blocked duplicate|duplicate_blocked|verification)/.test(msg)) {
      const primaryValidation = validationSignals[0] || "no new duplicate-charge log in rolling window";
      const secondaryValidation = validationSignals[1] || "no order with txCount > 1 in rolling window";
      const txText = sampleTxIds.length ? ` (latest duplicate txIds: ${sampleTxIds.join(", ")})` : "";
      return `That remediation direction is solid. Fastest validation is ${primaryValidation}; then confirm ${secondaryValidation} and spot-check ${sampleOrder}${txText}.`;
    }
    if (/(repro|steps|log|trace|test)/.test(msg)) {
      const primaryValidation = validationSignals[0] || "no new duplicate-charge log in rolling window";
      return `For fastest confidence, start with ${primaryValidation}. I can also share exact replay-test steps for ${sampleOrder} if you want.`;
    }
    return `Current state: duplicate charging is active in ${endpointHint}, with about ${duplicateOrders} affected orders. Let us align on one containment move and one validation signal.`;
  }
  if (normalizedRole === "ba") {
    if (/(defer|later|after hotfix)/.test(msg)) {
      return "If VIP is deferred, what ETA and stakeholder message should we commit right now?";
    }
    if (/(vip first|ship vip)/.test(msg)) {
      return "If VIP is prioritized, what guardrail keeps customer risk controlled?";
    }
    return "How should we sequence hotfix and VIP so business communication stays credible?";
  }
  if (normalizedRole === "tech_lead") {
    if (/(initial remediation|idempot|guard|chargegateway|existing result|blocked duplicate|duplicate_blocked|retry path|verification)/.test(msg)) {
      const primaryValidation = validationSignals[0] || "no new duplicate-charge log in rolling window";
      const primaryRollback = rollbackOptions[0] || "revert payment flow patch";
      return `Good direction. Keep idempotency guard as first containment. Next lock one rollback trigger and one monitoring signal before deploy; rollback option: ${primaryRollback}, monitoring signal: ${primaryValidation}.`;
    }
    if (/(hotfix first)/.test(msg)) {
      return "Okay, with hotfix-first, what rollback and monitoring plan should we lock now?";
    }
    if (/(vip first)/.test(msg)) {
      return "If VIP-first, what immediate technical control prevents duplicate-charge recurrence?";
    }
    return `Current technical priority is containment-first for ${sampleOrder}. Please state the deploy guardrail (rollback trigger + monitoring signal) to make this safe.`;
  }
  return "Can we align on the next safest step and the risk we are accepting?";
}

async function llmClassifyCandidateFocus(role, sessionId, candidateMessage) {
  const fallback = { focus: "unknown", nudge: "" };
  if (!OPENAI_API_KEY || !ENABLE_AI_TURN_ROUTER) return fallback;

  const normalizedRole = normalizeRole(role);
  const rawInput = String(candidateMessage || "").trim();
  const workstream = getSessionWorkstreamState(sessionId);
  const recentTranscript = getRecentTranscript(sessionId, 12);

  const systemPrompt = [
    "You classify the candidate's latest message in a live technical incident simulation.",
    "Classify focus as exactly one of: on_task, off_topic, mixed.",
    "off_topic means social/small-talk or unrelated content.",
    "mixed means partly social and partly incident-related.",
    "Return ONLY JSON with this exact shape:",
    "{\"focus\":\"on_task|off_topic|mixed\",\"nudge\":\"...\"}",
    "nudge must be a single short sentence (max 22 words).",
    "If focus is off_topic or mixed, nudge must redirect to incident execution and ask one concrete next action.",
    "If focus is on_task, nudge can be empty string.",
    "No markdown. No explanation outside JSON."
  ].join(" ");

  const inputText = [
    `Role: ${normalizedRole}`,
    `Candidate message: ${rawInput || "(empty)"}`,
    `Workstream summary: ${workstream.summary}`,
    "Recent transcript:",
    recentTranscript || "(none)"
  ].join("\n");

  const routerModelName = String(OPENAI_ROUTER_MODEL || "").toLowerCase();
  const isGpt5Router = routerModelName.startsWith("gpt-5");
  const reqBody = {
    model: OPENAI_ROUTER_MODEL,
    max_output_tokens: isGpt5Router ? 260 : 120,
    input: [
      { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
      { role: "user", content: [{ type: "input_text", text: inputText }] }
    ]
  };
  if (isGpt5Router) {
    reqBody.reasoning = { effort: "minimal" };
    reqBody.text = { verbosity: "low" };
  } else {
    reqBody.temperature = 0.1;
  }

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify(reqBody)
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`focus_router_http_${res.status}:${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const raw = extractResponseOutputText(data);
  const parsed = parseJsonObject(raw);
  if (!parsed) return fallback;

  const allowed = new Set(["on_task", "off_topic", "mixed"]);
  const focus = allowed.has(String(parsed.focus || "").trim()) ? String(parsed.focus).trim() : "unknown";
  const nudge = String(parsed.nudge || "").trim();
  return { focus, nudge };
}

async function llmAgentReply(role, sessionId, candidateMessage, focusDecision = null) {
  if (!OPENAI_API_KEY) return "";
  const normalizedRole = normalizeRole(role);
  const persona = AGENT_PERSONAS[normalizedRole];
  if (!persona) return "";
  const rawInput = String(candidateMessage || "").trim();
  const focus = String(focusDecision?.focus || "unknown").trim();
  const aiNudge = String(focusDecision?.nudge || "").trim();
  const offTopic = focus === "off_topic" || focus === "mixed";
  const intentMatch = rawInput.match(/intent:([a-z0-9_]+)/i);
  const orchestratorIntent = intentMatch ? intentMatch[1].toLowerCase() : "";
  const orchestratorCue = orchestratorIntent ? (AGENT_PLAYBOOK[orchestratorIntent] || "") : "";
  const isOrchestratorCue = !!orchestratorIntent;
  const workstream = getSessionWorkstreamState(sessionId);
  const roleMissingItems = getRoleScopedMissingItems(normalizedRole, workstream.missingItems);
  const needsTransition =
    isOrchestratorCue &&
    (workstream.candidateSilenceSec >= 10 || !workstream.candidateResponded);
  const missingText = roleMissingItems.length
    ? roleMissingItems.join(", ")
    : "none";
  const roleFocusedHistory = getRoleFocusedHistory(sessionId, normalizedRole, 60);
  const techLeadCrossRoleContext =
    normalizedRole === "tech_lead" ? getCrossRoleContextForTechLead(sessionId, 120) : "";
  const runtimeRolePrompt = PERSONA_PROMPTS[normalizedRole] || "";
  const runtimeGlobalPrompt = PERSONA_PROMPTS.global || "";
  const incidentFactPack = buildIncidentFactPackForPrompt(normalizedRole);

  const systemPrompt = [
    `You are ${persona.role} at ${COMPANY_CONTEXT.company}.`,
    `Company business: ${COMPANY_CONTEXT.business}. Product: ${COMPANY_CONTEXT.product}.`,
    `Incident context: ${COMPANY_CONTEXT.incident}.`,
    `Business pressure: ${COMPANY_CONTEXT.featurePressure}.`,
    `Audience: ${AUDIENCE_PERSONA.audience}.`,
    `Voice and style: ${persona.voice}. ${persona.style}.`,
    `Communication constraints: ${persona.format}; ${persona.length}.`,
    "Reply like a real teammate under pressure, not a robotic assistant.",
    "Write like a natural Slack teammate message, not a status report.",
    "Avoid label format such as 'Urgent:', 'Root cause:', 'Containment:', 'Action now:'.",
    "Avoid semicolon-chained checklist style.",
    "Use collaborative language (we/us) and sound like active incident collaboration.",
    "Avoid interview/test phrasing such as: 'what do you do first', 'state', 'choose now', 'give me'.",
    "You are not allowed to use fixed scripts or repeat canned lines.",
    "Use role intent + recent transcript to adapt naturally.",
    offTopic
      ? "Candidate latest message is off-topic or mixed. Give a brief acknowledgement, then immediately nudge back to incident execution."
      : "Candidate is on-task or unknown-focus. Continue incident collaboration.",
    offTopic ? "Do not continue casual chat." : "",
    offTopic ? "When off-topic/mixed, return exactly one short message." : "",
    aiNudge ? `Preferred nudge direction: ${aiNudge}` : "",
    "If an orchestrator cue is provided, treat it as guidance, not a strict script.",
    "When candidate asks for clarification, answer with 1-2 concrete facts from the Incident Fact Pack first.",
    "If a requested detail is not in Incident Fact Pack, say it is not confirmed yet and propose the next validation step.",
    "If candidate did not request details, do not dump multiple metrics or IDs in one turn.",
    normalizedRole === "tech_lead"
      ? "As Tech Lead, always anchor your question to current incident context and one concrete workstream item."
      : "Keep your question tied to the active incident and current thread context.",
    normalizedRole === "qa"
      ? "QA should sound evidence-driven, urgent, and collaborative."
      : "",
    normalizedRole === "ba"
      ? "BA should sound business-pressure aware, practical, and stakeholder-focused."
      : "",
    normalizedRole === "ba"
      ? "BA must stay at business level: ask only sequencing, ETA, stakeholder impact, and communication commitments."
      : "",
    normalizedRole === "ba"
      ? "BA must not ask for feature-flag names, rollback threshold numbers, txCount spikes, duplicate_count metrics, or implementation details."
      : "",
    normalizedRole === "qa"
      ? "QA must focus on incident evidence, reproduction, and validation signals; do not ask rollout governance or stakeholder communication questions."
      : "",
    normalizedRole === "qa" || normalizedRole === "ba"
      ? "Do not make final technical decisions for the candidate; force explicit candidate decision instead."
      : "",
    normalizedRole === "tech_lead"
      ? "Tech Lead should sound calm but demanding, and always build on QA/BA context."
      : "",
    normalizedRole === "tech_lead"
      ? "When possible, target one unresolved item from: containment, validation, prioritization, rollback, monitoring, dataCorrection."
      : "",
    needsTransition
      ? "Candidate appears stuck or silent. First acknowledge briefly, then transition into the next question naturally."
      : "Keep the flow natural and forward-moving.",
    "Avoid abrupt jumps between topics.",
    "Return ONLY valid JSON with this exact shape: {\"messages\":[\"...\",\"...\"]}.",
    "messages must contain exactly 1 short chat bubble.",
    "When candidate asks a direct question, answer it first in plain terms before any follow-up.",
    "Do not force a question in every response.",
    "Never repeat your own previous message verbatim. If overlap happens, rephrase and advance the thread.",
    "Ask at most one focused question when needed.",
    "No markdown, no code fences, no prose outside JSON.",
    "Do not use bullet points.",
    "Keep it short and natural (target 18-35 words, hard max 55 words).",
    runtimeRolePrompt ? `Runtime role prompt from scenario/persona_prompts.md:\n${runtimeRolePrompt}` : "",
    runtimeGlobalPrompt ? `Runtime global guardrails from scenario/persona_prompts.md:\n${runtimeGlobalPrompt}` : ""
  ].join(" ");

  const inputText = [
    isOrchestratorCue
      ? `Orchestrator cue intent: ${orchestratorIntent}`
      : `Candidate message: ${rawInput}`,
    orchestratorCue ? `Playbook guidance: ${orchestratorCue}` : "",
    `Candidate focus classification: ${focus}.`,
    `Focus nudge hint: ${aiNudge || "(none)"}`,
    `Session workstream summary: ${workstream.summary}`,
    `Role-scoped unresolved items: ${missingText}`,
    `Candidate silence seconds: ${workstream.candidateSilenceSec}`,
    `Seconds since last agent prompt: ${workstream.recentAgentPromptSec}`,
    `Latest candidate note: ${workstream.latestCandidate || "(none yet)"}`,
    "Incident Fact Pack (ground truth for clarifications):",
    incidentFactPack,
    "Role-focused thread history:",
    roleFocusedHistory || "(none)",
    normalizedRole === "tech_lead" ? "Candidate history with QA + BA:" : "",
    normalizedRole === "tech_lead" ? (techLeadCrossRoleContext || "(none)") : "",
    "Recent session transcript:",
    getRecentTranscript(sessionId, 30),
    "Respond to the latest candidate message naturally. If needed, end with one focused follow-up."
  ].filter(Boolean).join("\n");

  const modelName = String(OPENAI_MODEL || "").toLowerCase();
  const isGpt5Model = modelName.startsWith("gpt-5");
  const reqBody = {
    model: OPENAI_MODEL,
    max_output_tokens: isGpt5Model ? 300 : 180,
    input: [
      { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
      { role: "user", content: [{ type: "input_text", text: inputText }] }
    ]
  };
  if (isGpt5Model) {
    reqBody.reasoning = { effort: "minimal" };
    reqBody.text = { verbosity: "low" };
  } else {
    reqBody.temperature = 0.3;
  }

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify(reqBody)
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`llm_http_${res.status}:${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = extractResponseOutputText(data);
  return parseAgentMessages(text);
}

function readContextFiles() {
  const read = (file) => fs.readFileSync(path.join(SCENARIO_DIR, file), "utf8");
  const incidentPath = path.join(SCENARIO_DIR, "incident_brief.json");
  const incidentBriefRaw = fs.existsSync(incidentPath)
    ? fs.readFileSync(incidentPath, "utf8")
    : JSON.stringify(INCIDENT_BRIEF, null, 2);
  let incidentBrief = {};
  try {
    incidentBrief = JSON.parse(incidentBriefRaw);
  } catch {
    incidentBrief = {};
  }
  return {
    code_files: {
      payment_service: read("payment_service.js"),
      retry_policy: read("retry_policy.js"),
      checkout_controller: read("checkout_controller.js")
    },
    production_logs: read("production_logs.txt"),
    business_ticket: read("vip_discount_ticket.md"),
    incident_brief: incidentBrief,
    incident_brief_raw: incidentBriefRaw
  };
}

async function callAgentDirect(role, sessionId, candidateMessage) {
  const normalized = normalizeRole(role);
  const fromOrchestrator = String(candidateMessage || "").toLowerCase().includes("intent:");
  if (fromOrchestrator && isImmediateSameRoleTurn(sessionId, normalized)) {
    console.log(`[agent-direct] skip_consecutive_role session=${sessionId} role=${normalized}`);
    return null;
  }
  if (!USE_N8N_DIRECT_AGENTS) {
    let focusDecision = { focus: "unknown", nudge: "" };
    let replySource = "ai";
    let guardrailViolation = "";
    const workstream = getSessionWorkstreamState(sessionId);
    try {
      focusDecision = await llmClassifyCandidateFocus(normalized, sessionId, candidateMessage);
    } catch (err) {
      console.error(`[agent-direct-local] focus_router_error role=${normalized} err=${String(err && err.message ? err.message : err)}`);
    }

    let aiMessages = [];
    try {
      aiMessages = await llmAgentReply(normalized, sessionId, candidateMessage, focusDecision);
    } catch (err) {
      console.error(`[agent-direct-local] llm_error role=${normalized} err=${String(err && err.message ? err.message : err)}`);
    }
    let finalMessages = (Array.isArray(aiMessages) ? aiMessages : [])
      .map((m) => String(m || "").trim())
      .filter(Boolean);
    const seenThisTurn = new Set();
    finalMessages = finalMessages.filter((m) => {
      const key = normalizeTextForCompare(m);
      if (!key || seenThisTurn.has(key)) return false;
      seenThisTurn.add(key);
      return true;
    });

    finalMessages = finalMessages.filter((m) => !isStallOrLowValueQuestion(m));
    finalMessages = finalMessages.filter((m) => !isRecentDuplicateRoleQuestion(sessionId, normalized, m, 6));

    if (!finalMessages.length && (focusDecision.focus === "off_topic" || focusDecision.focus === "mixed")) {
      const aiNudge = String(focusDecision.nudge || "").trim();
      if (aiNudge) {
        finalMessages = [aiNudge];
        replySource = "ai_nudge_only";
      }
    }

    if (!finalMessages.length) {
      if (STRICT_AI_DECISIONS && OPENAI_API_KEY) {
        finalMessages = [
          String(focusDecision.nudge || "").trim() ||
            "Let us stay on incident execution. Confirm your next containment action and one validation signal."
        ];
        replySource = "ai_nudge_only";
      } else {
        finalMessages = [heuristicAgentReply(normalized, candidateMessage)];
        replySource = "heuristic_fallback";
      }
    }
    finalMessages = finalMessages.map((m) => {
      if (isRecentDuplicateRoleQuestion(sessionId, normalized, m, 8)) {
        return duplicateBreaker(normalized, candidateMessage);
      }
      return m;
    });
    const humanizedMessages = [];
    for (const m of finalMessages) {
      const result = await llmHumanizeAgentMessage(
        normalized,
        sessionId,
        m,
        workstream,
        focusDecision,
        candidateMessage
      );
      if (result.changed && replySource === "ai") {
        replySource = "ai_humanized";
      }
      if (result.violation && !guardrailViolation) {
        guardrailViolation = result.violation;
      }
      if (result.text) {
        humanizedMessages.push(result.text);
      }
    }
    finalMessages = humanizedMessages.filter(Boolean);
    if (!finalMessages.length) {
      finalMessages = [
        normalized === "ba"
          ? "I need one clear business commitment now: rollout sequencing and ETA for leadership communication."
          : normalized === "qa"
            ? "I need one validation signal now: do we agree no new duplicate-charge logs for 10 minutes?"
            : "Choose the safer remediation path now and give one rollback trigger plus one monitoring signal."
      ];
      replySource = "ai_nudge_only";
      if (!guardrailViolation) guardrailViolation = "guardrail_empty_repaired";
    }

    const firstDelayMs = (fromOrchestrator ? 1700 : 2400) + Math.floor(Math.random() * 1200);
    await sleep(firstDelayMs);

    const turnId = `turn_${normalized}_${Date.now()}`;
    let firstPayload = null;
    const bounded = finalMessages.slice(0, 1);
    for (let idx = 0; idx < bounded.length; idx++) {
      const msgText = bounded[idx];
      const payload = {
        session_id: sessionId,
        message_id: `msg_${normalized}_${Date.now()}_${idx + 1}`,
        agent: normalized,
        kind: "question",
        text: msgText,
        meta: {
          routed: true,
          direct: true,
          turn_id: turnId,
          turn_part: idx + 1,
          turn_parts_total: bounded.length,
          company: COMPANY_CONTEXT.company,
          audience: AUDIENCE_PERSONA.audience,
          persona_role: AGENT_PERSONAS[normalized]?.role || normalized,
          focus_classification: focusDecision.focus || "unknown",
          reply_source: replySource,
          role_violation: guardrailViolation
        }
      };
      if (!firstPayload) firstPayload = payload;
      pushMessage(payload);
      console.log(`[agent-direct-local] role=${payload.agent} text="${payload.text}"`);
      if (idx < bounded.length - 1) {
        await sleep(220 + Math.floor(Math.random() * 180));
      }
    }

    return firstPayload;
  }

  const url =
    normalized === "qa"
      ? N8N_AGENT_QA_URL
      : normalized === "ba"
        ? N8N_AGENT_BA_URL
        : N8N_AGENT_TECHLEAD_URL;

  const upstream = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: sessionId,
      candidate_last_message: candidateMessage
    })
  });
  const text = await upstream.text();
  const data = text ? JSON.parse(text) : {};
  if (!upstream.ok) {
    throw new Error(`agent_call_failed:${upstream.status}`);
  }

  const payload = {
    session_id: sessionId,
    message_id: `msg_${data.agent || normalized}_${Date.now()}`,
    agent: data.agent || normalized,
    kind: "question",
    text: data.text || "",
    meta: { routed: true, direct: true }
  };
  const humanizedUpstream = await llmHumanizeAgentMessage(
    payload.agent,
    sessionId,
    payload.text,
    getSessionWorkstreamState(sessionId),
    null,
    candidateMessage
  );
  payload.text = humanizedUpstream.text;
  if (humanizedUpstream.violation) {
    payload.meta.role_violation = humanizedUpstream.violation;
  }
  if (humanizedUpstream.changed) {
    payload.meta.reply_source = "n8n_humanized";
  } else {
    payload.meta.reply_source = "n8n";
  }

  const firstDelayMs = (fromOrchestrator ? 1500 : 2200) + Math.floor(Math.random() * 900);
  await sleep(firstDelayMs);

  pushMessage(payload);
  console.log(`[agent-direct] role=${payload.agent} text="${payload.text}"`);
  return payload;
}

const server = http.createServer(async (req, res) => {
  const method = req.method || "GET";
  const parsed = new URL(req.url || "/", `http://${req.headers.host}`);
  const pathname = parsed.pathname;

  if (method === "GET" && pathname === "/healthz") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    const indexPath = path.join(PUBLIC_DIR, "index.html");
    if (!fs.existsSync(indexPath)) {
      sendJson(res, 500, { ok: false, error: "missing_index_html" });
      return;
    }
    const html = fs.readFileSync(indexPath, "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (method === "GET" && pathname.startsWith("/recordings/")) {
    const fileName = decodeURIComponent(pathname.slice("/recordings/".length));
    const safeName = path.basename(fileName);
    const filePath = path.join(RECORDINGS_DIR, safeName);
    if (!fs.existsSync(filePath)) {
      sendJson(res, 404, { ok: false, error: "recording_not_found" });
      return;
    }
    const ext = path.extname(safeName).replace(".", "");
    const contentType = contentTypeFromExtension(ext);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": fs.statSync(filePath).size,
      "Cache-Control": "no-store"
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  if (method === "POST" && pathname === "/sim/session/agent-message") {
    try {
      const payload = await readJsonBody(req);
      pushMessage(payload);

      const role = payload.agent || "unknown";
      const text = payload.text || "";
      console.log(`[agent-message] role=${role} text="${text}"`);

      sendJson(res, 200, { ok: true, stored: true, count: messages.length });
    } catch (err) {
      const message = err && err.message ? err.message : "unknown_error";
      const status = message === "invalid_json" ? 400 : 422;
      sendJson(res, status, { ok: false, error: message });
    }
    return;
  }

  if (method === "GET" && pathname === "/api/context") {
    try {
      sendJson(res, 200, { ok: true, context: readContextFiles() });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err.message || err) });
    }
    return;
  }

  if (method === "POST" && pathname === "/api/session/recording") {
    try {
      const sessionId = String(parsed.searchParams.get("session_id") || "").trim();
      if (!sessionId) {
        sendJson(res, 400, { ok: false, error: "missing_session_id" });
        return;
      }
      const raw = await readBinaryBody(req);
      if (!raw.length) {
        sendJson(res, 400, { ok: false, error: "empty_recording" });
        return;
      }
      const mimeType = String(req.headers["content-type"] || "video/webm");
      const requestedName = String(req.headers["x-filename"] || "").trim();
      const ext = extensionFromMimeType(mimeType);
      const safeSession = sanitizeToken(sessionId, "session");
      const safeBase = requestedName
        ? sanitizeToken(path.basename(requestedName, path.extname(requestedName)), `recording_${Date.now()}`)
        : `recording_${Date.now()}`;
      const fileName = `${safeSession}_${safeBase}.${ext}`;
      const filePath = path.join(RECORDINGS_DIR, fileName);
      fs.writeFileSync(filePath, raw);
      const recording = {
        session_id: sessionId,
        file_name: fileName,
        file_path: filePath,
        url: `/recordings/${encodeURIComponent(fileName)}`,
        mime_type: mimeType,
        size_bytes: raw.length,
        created_at: new Date().toISOString()
      };
      if (!Array.isArray(sessionRecordings[sessionId])) {
        sessionRecordings[sessionId] = [];
      }
      sessionRecordings[sessionId].push(recording);
      pushMessage({
        session_id: sessionId,
        message_id: `msg_system_recording_${Date.now()}`,
        agent: "system",
        kind: "recording_uploaded",
        text: `Screen recording saved: ${fileName}`
      });
      sendJson(res, 200, { ok: true, recording });
    } catch (err) {
      const message = String(err && err.message ? err.message : err);
      const status = message === "payload_too_large" ? 413 : 500;
      sendJson(res, status, { ok: false, error: message });
    }
    return;
  }

  if (method === "GET" && pathname === "/api/session/recordings") {
    const sessionId = String(parsed.searchParams.get("session_id") || "").trim();
    if (!sessionId) {
      sendJson(res, 400, { ok: false, error: "missing_session_id" });
      return;
    }
    const recordings = sessionRecordings[sessionId] || [];
    sendJson(res, 200, {
      ok: true,
      session_id: sessionId,
      count: recordings.length,
      recordings
    });
    return;
  }

  if (method === "GET" && pathname === "/api/agent/personas") {
    sendJson(res, 200, {
      ok: true,
      company: COMPANY_CONTEXT,
      agents: AGENT_PERSONAS,
      audience: AUDIENCE_PERSONA
    });
    return;
  }

  if (method === "POST" && pathname === "/api/session/start") {
    try {
      const payload = await readJsonBody(req);
      const sessionId = payload.session_id || `sess_${Date.now()}`;
      const now = Date.now();
      const durationSec = Number(payload.duration_sec || 600);
      clearSessionOrchestrator(sessionId);
      sessions[sessionId] = {
        session_id: sessionId,
        started_at_ms: now,
        end_at_ms: now + durationSec * 1000,
        ended: false,
        runtime: null
      };
      sessionRecordings[sessionId] = [];
      ensureSessionRuntime(sessionId, durationSec);

      let n8n = { ok: false, status: 0, body: {} };
      try {
        const upstream = await fetch(N8N_START_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId })
        });
        const text = await upstream.text();
        const upstreamBody = text ? JSON.parse(text) : {};
        n8n = { ok: upstream.ok, status: upstream.status, body: upstreamBody };
      } catch (err) {
        n8n = {
          ok: false,
          status: 0,
          body: { error: "n8n_start_unreachable", detail: String(err && err.message ? err.message : err) }
        };
      }
      pushMessage({
        session_id: sessionId,
        message_id: `msg_system_start_${Date.now()}`,
        agent: "system",
        kind: "session_start",
        text: "Simulation started. Timer is running."
      });
      startSessionOrchestrator(sessionId, durationSec);
      sendJson(res, 200, {
        ok: true,
        n8n,
        session_id: sessionId,
        started_at_ms: now,
        end_at_ms: now + durationSec * 1000,
        duration_sec: durationSec
      });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err.message || err) });
    }
    return;
  }

  if (method === "POST" && pathname === "/api/session/event") {
    try {
      const payload = await readJsonBody(req);
      const sessionId = payload.session_id || `sess_${Date.now()}`;
      const session = ensureSession(sessionId);
      if (isSessionEnded(sessionId)) {
        sendJson(res, 409, { ok: false, error: "session_ended" });
        return;
      }
      if (!session.runtime) {
        ensureSessionRuntime(sessionId, Math.max(1, Math.floor((session.end_at_ms - session.started_at_ms) / 1000)));
      }
      const eventType = String(payload.event_type || "candidate_message");
      const signalData = payload.data || {};

      if (eventType === "mic_state_changed") {
        session.runtime.mic_active = !!signalData.mic_active;
        sendJson(res, 200, { ok: true, mode: "signal", event_type: eventType });
        return;
      }
      if (eventType === "speech_end") {
        session.runtime.mic_active = false;
        sendJson(res, 200, { ok: true, mode: "signal", event_type: eventType });
        return;
      }
      if (eventType === "typing_state_changed") {
        const active = !!signalData.typing_active;
        session.runtime.typing_active = active;
        if (active) {
          session.runtime.last_typing_at_ms = Date.now();
        }
        sendJson(res, 200, { ok: true, mode: "signal", event_type: eventType });
        return;
      }

      const candidateText = String(payload.text || "").trim();
      if (eventType === "candidate_message" && candidateText) {
        session.runtime.last_candidate_event_ms = Date.now();
        session.runtime.typing_active = false;
        pushMessage({
          session_id: sessionId,
          message_id: `msg_candidate_${Date.now()}`,
          agent: "candidate",
          kind: "candidate_message",
          text: candidateText,
          thread_root: String(payload.thread_root || ""),
          meta: {
            addressed_to: String(payload.addressed_to || "")
          }
        });
      }
      const addressed = String(payload.addressed_to || "").toLowerCase();
      const directRole =
        addressed === "qa" || addressed === "ba" || addressed === "tech_lead" || addressed === "techlead"
          ? (addressed === "tech_lead" ? "techlead" : addressed)
          : "";

      if (directRole) {
        const directPayload = await callAgentDirect(
          directRole,
          sessionId,
          payload.text || ""
        );
        sendJson(res, 200, { ok: true, mode: "direct", payload: directPayload });
        return;
      }

      const body = {
        session_id: sessionId,
        event_type: eventType,
        // n8n runs in Docker, so "localhost" from container is not host machine.
        frontend_agent_webhook: `${PUBLIC_BASE_URL}/sim/session/agent-message`,
        data: {
          text: candidateText,
          addressed_to: payload.addressed_to || "",
          thread_root: payload.thread_root || ""
        }
      };
      console.log(`[api/session/event] outbound=${JSON.stringify(body)}`);

      const upstream = await fetch(N8N_EVENT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const text = await upstream.text();
      const upstreamBody = text ? JSON.parse(text) : {};
      sendJson(res, upstream.status, { ok: upstream.ok, mode: "orchestrator", upstream: upstreamBody });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err.message || err) });
    }
    return;
  }

  if (method === "POST" && pathname === "/api/session/code") {
    try {
      const payload = await readJsonBody(req);
      const sessionId = payload.session_id || `sess_${Date.now()}`;
      ensureSession(sessionId);
      if (isSessionEnded(sessionId)) {
        sendJson(res, 409, { ok: false, error: "session_ended" });
        return;
      }
      const code = String(payload.code || "").trim();
      if (!code) {
        sendJson(res, 400, { ok: false, error: "missing_code" });
        return;
      }
      const message = {
        session_id: sessionId,
        message_id: `msg_candidate_code_${Date.now()}`,
        agent: "candidate",
        kind: "candidate_code",
        text: code
      };
      pushMessage(message);
      sendJson(res, 200, { ok: true, stored: true });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err.message || err) });
    }
    return;
  }

  if (method === "POST" && pathname === "/api/session/stop") {
    try {
      const payload = await readJsonBody(req);
      const sessionId = payload.session_id;
      if (!sessionId) {
        sendJson(res, 400, { ok: false, error: "missing_session_id" });
        return;
      }
      const s = ensureSession(sessionId);
      s.ended = true;
      s.end_at_ms = Date.now();
      clearSessionOrchestrator(sessionId);
      const report = evaluateSession(sessionId);
      evaluations[sessionId] = report;
      pushMessage({
        session_id: sessionId,
        message_id: `msg_system_end_${Date.now()}`,
        agent: "system",
        kind: "session_end",
        text: "Session ended. Input is now locked."
      });
      sendJson(res, 200, { ok: true, session_id: sessionId, ended: true, evaluation: report });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err.message || err) });
    }
    return;
  }

  if (method === "GET" && pathname === "/api/session/status") {
    const sessionId = parsed.searchParams.get("session_id");
    if (!sessionId) {
      sendJson(res, 400, { ok: false, error: "missing_session_id" });
      return;
    }
    const s = getSession(sessionId);
    if (!s) {
      sendJson(res, 404, { ok: false, error: "session_not_found" });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      session_id: s.session_id,
      started_at_ms: s.started_at_ms,
      end_at_ms: s.end_at_ms,
      ended: isSessionEnded(sessionId)
    });
    return;
  }

  if (method === "POST" && pathname === "/api/session/evaluate") {
    try {
      const payload = await readJsonBody(req);
      const sessionId = payload.session_id;
      if (!sessionId) {
        sendJson(res, 400, { ok: false, error: "missing_session_id" });
        return;
      }
      const report = evaluateSession(sessionId);
      evaluations[sessionId] = report;
      sendJson(res, 200, { ok: true, evaluation: report });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err.message || err) });
    }
    return;
  }

  if (method === "GET" && pathname === "/api/session/evaluation") {
    const sessionId = parsed.searchParams.get("session_id");
    if (!sessionId) {
      sendJson(res, 400, { ok: false, error: "missing_session_id" });
      return;
    }
    const report = evaluations[sessionId];
    if (!report) {
      sendJson(res, 404, { ok: false, error: "evaluation_not_found" });
      return;
    }
    sendJson(res, 200, { ok: true, evaluation: report });
    return;
  }

  if (method === "GET" && pathname === "/sim/session/messages") {
    const sessionId = parsed.searchParams.get("session_id");
    const filtered = sessionId
      ? messages.filter((m) => String(m.payload?.session_id || "") === sessionId)
      : messages;
    sendJson(res, 200, { ok: true, count: filtered.length, messages: filtered });
    return;
  }

  if (method === "DELETE" && pathname === "/sim/session/messages") {
    const sessionId = parsed.searchParams.get("session_id");
    if (!sessionId) {
      messages.length = 0;
      sendJson(res, 200, { ok: true, cleared: true, mode: "all" });
      return;
    }
    let removed = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (String(messages[i].payload?.session_id || "") === sessionId) {
        messages.splice(i, 1);
        removed += 1;
      }
    }
    sessionRecordings[sessionId] = [];
    sendJson(res, 200, { ok: true, cleared: true, mode: "session", removed, session_id: sessionId });
    return;
  }

  notFound(res);
});

server.listen(PORT, () => {
  console.log(`Local receiver listening on http://localhost:${PORT}`);
  if (!OPENAI_API_KEY && !USE_N8N_DIRECT_AGENTS) {
    console.warn("[warn] OPENAI_API_KEY missing. Agent replies may degrade.");
  }
  console.log(`N8N start webhook: ${N8N_START_URL}`);
  console.log(`N8N event webhook: ${N8N_EVENT_URL}`);
  console.log(`Public base URL: ${PUBLIC_BASE_URL}`);
  console.log("GET  /");
  console.log("GET  /api/context");
  console.log("GET  /api/agent/personas");
  console.log("POST /api/session/recording?session_id=...");
  console.log("GET  /api/session/recordings?session_id=...");
  console.log("GET  /recordings/<file>");
  console.log("POST /api/session/start");
  console.log("POST /api/session/event");
  console.log("POST /api/session/code");
  console.log("POST /api/session/stop");
  console.log("GET  /api/session/status?session_id=...");
  console.log("POST /api/session/evaluate");
  console.log("GET  /api/session/evaluation?session_id=...");
  console.log("POST /sim/session/agent-message");
  console.log("GET  /sim/session/messages");
});
