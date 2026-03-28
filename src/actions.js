const ALLOWED_ACTIONS = new Set([
  "gateway-status",
  "gateway-restart",
  "sessions-list",
  "cron-list",
  "health-check",
  "clear-stale-sessions",
  "prune-stale",
]);

function executeAction(action, deps) {
  const { runOpenClaw, extractJSON, PORT } = deps;
  const results = { success: false, action, output: "", error: null };

  if (!ALLOWED_ACTIONS.has(action)) {
    results.error = `Unknown action: ${action}`;
    return results;
  }

  try {
    switch (action) {
      case "gateway-status":
        results.output = runOpenClaw("gateway status 2>&1") || "Unknown";
        results.success = true;
        break;
      case "gateway-restart":
        results.output = "To restart gateway, run: openclaw gateway restart";
        results.success = true;
        results.note = "Dashboard cannot restart gateway for safety";
        break;
      case "sessions-list":
        results.output = runOpenClaw("sessions 2>&1") || "No sessions";
        results.success = true;
        break;
      case "cron-list":
        results.output = runOpenClaw("cron list 2>&1") || "No cron jobs";
        results.success = true;
        break;
      case "health-check": {
        const gateway = runOpenClaw("gateway status 2>&1");
        const sessions = runOpenClaw("sessions --json 2>&1");
        let sessionCount = 0;
        try {
          const data = JSON.parse(sessions);
          sessionCount = data.sessions?.length || 0;
        } catch (e) {}
        results.output = [
          `Gateway: ${gateway?.includes("running") ? "OK Running" : "NOT Running"}`,
          `Sessions: ${sessionCount}`,
          `Dashboard: OK Running on port ${PORT}`,
        ].join("\n");
        results.success = true;
        break;
      }
      case "clear-stale-sessions":
      case "prune-stale": {
        // Try to read session files and count stale sessions
        const staleOutput = runOpenClaw("sessions --json 2>&1");
        let staleCount = 0;
        let staleKeys = [];
        try {
          const staleJson = extractJSON(staleOutput);
          if (staleJson) {
            const data = JSON.parse(staleJson);
            (data.sessions || []).forEach((s) => {
              if (s.ageMs > 24 * 60 * 60 * 1000) {
                staleCount++;
                if (s.key) staleKeys.push(s.key);
              }
            });
          }
        } catch (e) {}

        if (action === "prune-stale") {
          if (staleCount === 0) {
            results.output = "✅ No stale sessions found (all sessions < 24h old)";
            results.success = true;
          } else {
            results.output = `🧹 Found ${staleCount} stale session${staleCount > 1 ? "s" : ""} (>24h old)\nTo clean, run: openclaw sessions cleanup --enforce`;
            results.success = true;
          }
          break;
        }
        // clear-stale-sessions
        if (staleCount === 0) {
          results.output = "✅ No stale sessions to clear";
          results.success = true;
        } else {
          results.output = `Found ${staleCount} stale session${staleCount > 1 ? "s" : ""} (>24h old)\nTo clear: openclaw sessions prune`;
          results.success = true;
        }
        break;
      }
    }
  } catch (e) {
    results.error = e.message;
  }

  return results;
}

module.exports = { executeAction, ALLOWED_ACTIONS };
