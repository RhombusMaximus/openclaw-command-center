/**
 * Push Listener — Event-Driven Notifications
 *
 * Polls CCC /api/state every 30s and diffs the session map against the last
 * known state. Fires Telegram DMs to Boss (or email fallback) when rules match.
 *
 * Key transitions detected:
 * - Session: disappeared (sub-agent finished, crashed, or was pruned)
 * - Session: error state detected
 *
 * Usage:
 *   node src/push-listener.js [--once] [--dry-run]
 *
 * Rules config: config/push-rules.json
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { URL } = require("url");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.join(os.homedir(), ".openclaw", "workspace");
const CONFIG_DIR = path.join(__dirname, "..");
const STATE_DIR = path.join(WORKSPACE, "state", "push-listener");
const RULES_FILE = path.join(CONFIG_DIR, "config", "push-rules.json");
const CCC_URL = process.env.CCC_URL || "http://localhost:3333";
const POLL_MS = 30000;

const DRY_RUN = process.argv.includes("--dry-run");
const ONCE = process.argv.includes("--once");

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const LOG_FILE = path.join(WORKSPACE, "logs", "push-listener.log");
const LOG_MAX_LINES = 2000;

function log(level, ...args) {
  const ts = new Date().toISOString();
  const msg = `[${ts}] [${level}] ${args.join(" ")}`;
  console.log(msg);
  try {
    let lines = fs.existsSync(LOG_FILE)
      ? fs.readFileSync(LOG_FILE, "utf8").split("\n").slice(-LOG_MAX_LINES)
      : [];
    lines.push(msg);
    fs.writeFileSync(LOG_FILE, lines.join("\n") + "\n");
  } catch {}
}

const logInfo = (...a) => log("INFO", ...a);
const logWarn = (...a) => log("WORN", ...a);
const logError = (...a) => log("ERROR", ...a);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function readListenerState() {
  try {
    const p = path.join(STATE_DIR, "listener-state.json");
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : { sessions: {}, lastUpdate: null };
  } catch { return { sessions: {}, lastUpdate: null }; }
}

function writeListenerState(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(STATE_DIR, "listener-state.json"), JSON.stringify(state, null, 2));
  } catch (e) { logError("State write failed:", e.message); }
}

function readRuleState(ruleId) {
  try {
    const p = path.join(STATE_DIR, `rule-${ruleId}.json`);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : { lastNotified: null };
  } catch { return { lastNotified: null }; }
}

function writeRuleState(ruleId, state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(STATE_DIR, `rule-${ruleId}.json`), JSON.stringify(state, null, 2));
  } catch (e) { logError("Rule state write failed:", e.message); }
}

// ---------------------------------------------------------------------------
// CCC Fetch
// ---------------------------------------------------------------------------

function cccFetch(pathname) {
  return new Promise((resolve) => {
    const url = new URL(`${CCC_URL}${pathname}`);
    const req = http.get(
      { hostname: url.hostname, port: url.port || 80, path: url.pathname, timeout: 15000 },
      (res) => {
        if (res.statusCode !== 200) { resolve(null); return; }
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

// ---------------------------------------------------------------------------
// Session Tracking
// ---------------------------------------------------------------------------

function extractSessionStates(update) {
  const state = {};
  for (const s of update.sessions || []) {
    state[s.sessionKey] = {
      sessionKey: s.sessionKey,
      sessionId: s.sessionId,
      active: s.active,
      recentlyActive: s.recentlyActive,
      label: s.label || s.sessionKey,
      topic: s.topic || null,
      tokens: s.tokens || 0,
      outcome: s.outcome || null,
      error: s.error || null,
    };
  }
  return state;
}

function diffSessions(prev, curr) {
  const events = [];
  const prevKeys = new Set(Object.keys(prev));
  const currKeys = new Set(Object.keys(curr));

  for (const key of prevKeys) {
    if (!currKeys.has(key)) {
      const was = prev[key];
      events.push({
        type: "session.ended",
        sessionKey: was.sessionKey,
        sessionId: was.sessionId,
        label: was.label,
        topic: was.topic,
        outcome: was.outcome || (was.active ? "unknown" : "idle"),
        error: was.error || null,
        tokens: was.tokens,
      });
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Notification Delivery
// ---------------------------------------------------------------------------

async function notify(title, body, options = {}) {
  const { urgent = false, ruleId = null } = options;
  if (DRY_RUN) { logInfo(`[DRY-RUN] notify: ${title} — ${body}`); return { ok: true }; }
  const tg = await sendTelegram(`🔔 *${title}*\n\n${body}`, urgent);
  if (tg.ok) return tg;
  logWarn(`Telegram failed, falling back to email:`, tg.error);
  return sendEmail(title, body);
}

async function sendTelegram(text, urgent = false) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (!token || !chatId) return { ok: false, error: "env missing" };

  const body = JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", disable_notification: !urgent });
  return new Promise((resolve) => {
    const req = https.request(
      { hostname: "api.telegram.org", path: `/bot${token}/sendMessage`, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => { try { const j = JSON.parse(d); resolve(j.ok ? { ok: true } : { ok: false, error: j.description }); }
          catch { resolve({ ok: false, error: d.slice(0, 80) }); } });
      },
    );
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ ok: false, error: "timeout" }); });
    req.write(body);
    req.end();
  });
}

async function sendEmail(subject, body) {
  const resendKey = process.env.RESEND_API_KEY;
  const toEmail = process.env.ALERT_EMAIL || "clinten.carballo@gmail.com";
  if (!resendKey) return { ok: false, error: "RESEND_API_KEY not set" };

  const payload = JSON.stringify({ from: "no-reply@update.clinten.co", to: [toEmail], subject: `🔔 ${subject}`, text: body });
  return new Promise((resolve) => {
    const req = https.request(
      { hostname: "api.resend.com", path: "/email", method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${resendKey}`, "Content-Length": Buffer.byteLength(payload) } },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => { try { const j = JSON.parse(d); resolve(res.statusCode < 300 ? { ok: true } : { ok: false, error: j.message }); }
          catch { resolve({ ok: false, error: d.slice(0, 80) }); } });
      },
    );
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ ok: false, error: "timeout" }); });
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Rule Engine
// ---------------------------------------------------------------------------

function loadRules() {
  try {
    if (!fs.existsSync(RULES_FILE)) return getDefaultRules();
    const rules = JSON.parse(fs.readFileSync(RULES_FILE, "utf8")).rules || [];
    return rules.length ? rules : getDefaultRules();
  } catch (e) { logError("Rule load error:", e.message); return getDefaultRules(); }
}

function getDefaultRules() {
  return [
    { id: "subagent-done", name: "Sub-agent Done", description: "Notify when a sub-agent task finishes",
      eventType: "session.ended", match: { sessionKeyPattern: ":subagent:" },
      cooldownMs: 30000,
      notify: { title: "✅ Sub-agent Done", bodyTemplate: "* {{label}}* finished ({{outcome}})", urgent: false },
      enabled: true },
    { id: "session-crash", name: "Session Error", description: "Notify when a session ends with an error",
      eventType: "session.ended", match: { outcomePattern: "error|crashed|failed" },
      cooldownMs: 60000,
      notify: { title: "💥 Session Ended in Error", bodyTemplate: "* {{label}}* ended: {{outcome}}", urgent: true },
      enabled: true },
  ];
}

function matchRule(rule, event) {
  if (rule.eventType && rule.eventType !== event.type) return false;
  if (rule.match?.sessionKeyPattern && !(event.sessionKey || "").includes(rule.match.sessionKeyPattern)) return false;
  if (rule.match?.outcomePattern) {
    try { if (!new RegExp(rule.match.outcomePattern, "i").test(event.outcome || "")) return false; }
    catch {}
  }
  return true;
}

function shouldFire(rule) {
  if (!rule.enabled) return false;
  if (DRY_RUN) return true;
  const state = readRuleState(rule.id);
  if (!state.lastNotified) return true;
  return Date.now() - new Date(state.lastNotified).getTime() >= (rule.cooldownMs || 60000);
}

function renderTemplate(template, event) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const val = event[k];
    if (val === undefined || val === null) return "—";
    if (k === "tokens" && typeof val === "number") return val >= 1000 ? `${(val / 1000).toFixed(1)}k` : String(val);
    return String(val);
  });
}

// ---------------------------------------------------------------------------
// Main Poll Loop
// ---------------------------------------------------------------------------

let pollTimer = null;
let cccHealth = null;

async function poll() {
  const state = readListenerState();
  const prevSessions = state.sessions || {};

  const update = await cccFetch("/api/state");
  if (!update || !update.sessions) {
    logWarn("Poll: CCC /api/state returned no data");
    return;
  }

  const currSessions = extractSessionStates(update);
  const events = diffSessions(prevSessions, currSessions);

  // Always persist current session map so next poll starts fresh
  state.sessions = currSessions;
  state.lastUpdate = new Date().toISOString();
  writeListenerState(state);

  if (events.length === 0) {
    logInfo(`Poll: ${Object.keys(currSessions).length} sessions tracked, no transitions`);
    return;
  }

  logInfo(`Poll: detected ${events.length} transition(s):`, events.map(e => `${e.type}(${e.outcome})`).join(", "));

  const rules = loadRules();
  for (const event of events) {
    for (const rule of rules) {
      if (!shouldFire(rule)) continue;
      if (!matchRule(rule, event)) continue;

      const title = renderTemplate(rule.notify.title, event);
      const body = renderTemplate(rule.notify.bodyTemplate, event);
      logInfo(`Rule "${rule.id}" matched — notifying: ${title}`);

      const result = await notify(title, body, { ruleId: rule.id, urgent: rule.notify.urgent });
      if (result.ok) {
        logInfo(`Notification sent: ${title}`);
        if (!DRY_RUN) writeRuleState(rule.id, { lastNotified: new Date().toISOString() });
      } else {
        logError(`Notification failed: ${result.error}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

logInfo("=".repeat(60));
logInfo("Push Listener starting");
logInfo(`CCC URL: ${CCC_URL}`);
logInfo(`Poll interval: ${POLL_MS}ms`);
logInfo(`Workspace: ${WORKSPACE}`);
logInfo(`Dry run: ${DRY_RUN}`);
logInfo("=".repeat(60));

async function pingCCC() {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: new URL(CCC_URL).hostname, port: new URL(CCC_URL).port || 80, path: "/api/health", timeout: 5000 },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => { try { resolve({ ok: true, data: JSON.parse(d) }); } catch { resolve({ ok: true }); } });
      },
    );
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "timeout" }); });
  });
}

async function main() {
  const ping = await pingCCC();
  if (!ping.ok) {
    logWarn(`CCC not reachable: ${ping.error} — will retry on poll`);
  } else {
    cccHealth = ping.data;
    logInfo(`CCC health:`, JSON.stringify(cccHealth).slice(0, 100));
  }

  // Initial poll
  await poll();

  if (ONCE) { logInfo("--once: done"); process.exit(0); }

  // Schedule recurring polls
  pollTimer = setInterval(poll, POLL_MS);
  logInfo(`Scheduled, polling every ${POLL_MS}ms`);

  process.on("SIGINT", () => { logInfo("Shutting down..."); clearInterval(pollTimer); process.exit(0); });
  process.on("SIGTERM", () => { logInfo("Shutting down..."); clearInterval(pollTimer); process.exit(0); });
}

main().catch((e) => { logError("Fatal:", e.message); process.exit(1); });
