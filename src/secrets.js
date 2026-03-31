/**
 * 1Password Secrets Module
 *
 * Wraps the `op` CLI for secrets management.
 * Vault name, secret name, notes, audit log, Notion page links.
 *
 * Usage:
 *   source /home/openclaw/.openclaw/op-env.sh   (loads OP_TOKEN)
 *   node src/secrets.js list
 *   node src/secrets.js get "<item-name>"
 *   node src/secrets.js audit "<item-name>"
 */

const { execFileSync, execSync, exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

// Load config
const CONFIG_PATH = path.join(__dirname, "../config/secrets.json");
let config = { vaultName: "RhomBot's Vault" };

try {
  if (fs.existsSync(CONFIG_PATH)) {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  }
} catch (e) {
  console.warn("[Secrets] Config load failed:", e.message);
}

// Vault to use
const VAULT_NAME = config.vaultName || "RhomBot's Vault";

/**
 * Run an op CLI command, returning stdout or throwing on error.
 * Uses execFileSync (no shell) to avoid quote parsing issues.
 * Requires OP_TOKEN env var to be set (source op-env.sh first).
 */
function op(args, options = {}) {
  const { silent = false } = options;
  const fullArgs = ["--format", "json", ...args];
  try {
    // execFileSync bypasses shell — no quote escaping issues
    const output = execFileSync("op", fullArgs, {
      encoding: "utf8",
      timeout: 15000,
      env: { ...process.env },
    });
    return JSON.parse(output);
  } catch (e) {
    if (silent) return null;
    const msg = e.stderr || e.message || "";
    if (msg.includes("not signed in") || msg.includes("authentication")) {
      throw new Error("1Password not authenticated. Run: source ~/.openclaw/op-env.sh");
    }
    if (msg.includes("could not find")) {
      return null; // Not found, not an error for our purposes
    }
    throw new Error(`op CLI error: ${msg.slice(0, 200)}`);
  }
}

/**
 * List all items in the configured vault.
 * Returns array of { id, name, title, category, vault, tags, notes, created, updated }.
 */
function listItems() {
  const items = op(["item", "list", "--vault", VAULT_NAME]);
  if (!items || !Array.isArray(items)) return [];

  return items.map((item) => ({
    id: item.id,
    name: item.title,
    title: item.title,
    category: item.category || "credential",
    vault: VAULT_NAME,
    tags: item.tags || [],
    notes: item.extra || item.note || "",
    created: item.createdAt,
    updated: item.updatedAt,
    // Try to extract a Notion page URL from notes
    notionUrl: extractNotionUrl(item.note || item.extra || ""),
  }));
}

/**
 * Extract a Notion page URL from notes text.
 * Looks for patterns like: notion.so/... or https://www.notion.so/...
 */
function extractNotionUrl(notes) {
  if (!notes) return null;
  const match = notes.match(/https?:\/\/(?:www\.)?notion\.so\/[^\s<>\"']+/);
  return match ? match[0].split("?")[0] : null; // Strip query params
}

/**
 * Get a single item's full details.
 * Returns { id, name, category, vault, tags, notes, fields, created, updated, notionUrl }.
 */
function getItem(name) {
  const item = op(["item", "get", name, "--vault", VAULT_NAME]);
  if (!item) return null;

  // Parse fields — 1Password stores different field types
  const fields = {};
  if (item.fields) {
    for (const [key, val] of Object.entries(item.fields)) {
      if (val && typeof val === "object") {
        fields[key] = {
          value: val.value || "",
          type: val.type || "text",
          id: val.id || key,
        };
      }
    }
  }

  return {
    id: item.id,
    name: item.title,
    title: item.title,
    category: item.category || "credential",
    vault: VAULT_NAME,
    tags: item.tags || [],
    notes: item.note || item.extra || "",
    fields,
    created: item.createdAt,
    updated: item.updatedAt,
    notionUrl: extractNotionUrl(item.note || item.extra || ""),
  };
}

/**
 * Get audit log for a specific item.
 * Returns array of { timestamp, action, actor, ipAddress }.
 *
 * Note: The op CLI does not expose item-level audit logs directly.
 * We return the item's createdAt/updatedAt as a proxy.
 * For full audit logs, use the 1Password Admin API or dashboard.
 */
function getItemAudit(itemName) {
  const item = op(["item", "get", itemName, "--vault", VAULT_NAME]);
  if (!item) return [];

  const events = [];

  if (item.createdAt) {
    events.push({
      timestamp: item.createdAt,
      action: "created",
      actor: item.creator?.name || item.createdByUser?.name || "unknown",
      detail: "Item created",
    });
  }

  if (item.updatedAt) {
    events.push({
      timestamp: item.updatedAt,
      action: "updated",
      actor: item.lastModifiedBy?.name || "unknown",
      detail: "Last modified",
    });
  }

  // Get the item's history if available
  try {
    const history = op(["item", "history", itemName, "--vault", VAULT_NAME], { silent: true });
    if (history && Array.isArray(history)) {
      // history contains older versions — add them as audit events
      history.forEach((version) => {
        if (version.updatedAt && version.updatedAt !== item.updatedAt) {
          events.push({
            timestamp: version.updatedAt,
            action: "version",
            actor: version.lastModifiedBy?.name || "unknown",
            detail: `Version ${version.version?.number || "?"}`,
          });
        }
      });
    }
  } catch (e) {
    // History not available for this item type — skip
  }

  return events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

/**
 * Handle incoming HTTP request for secrets endpoints.
 * Supports: GET /api/secrets         → list all items
 *           GET /api/secrets?name=...  → get single item
 *           GET /api/secrets/audit?name=... → audit log for item
 */
async function handleSecretsRequest(req, res, pathname, query) {
  // Set CORS headers
  res.setHeader("Content-Type", "application/json");

  // Health check — verify op CLI is reachable
  try {
    execSync("op --version", { encoding: "utf8", timeout: 5000 });
  } catch (e) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "1Password CLI not available. Ensure op is installed and authenticated." }));
    return;
  }

  // Route: /api/secrets/audit?name=...
  if (pathname === "/api/secrets/audit") {
    const name = query.get("name");
    if (!name) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing ?name= parameter" }));
      return;
    }
    try {
      const audit = getItemAudit(name);
      res.writeHead(200);
      res.end(JSON.stringify({ name, vault: VAULT_NAME, audit }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Route: /api/secrets?name=...
  if (pathname === "/api/secrets") {
    const name = query.get("name");
    if (name) {
      try {
        const item = getItem(name);
        if (!item) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Item "${name}" not found` }));
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify(item));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // List all
    try {
      const items = listItems();
      res.writeHead(200);
      res.end(JSON.stringify({ vault: VAULT_NAME, items }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Not found
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
}

// CLI mode
if (require.main === module) {
  const cmd = process.argv[2];
  const arg = process.argv[3];

  try {
    if (cmd === "list") {
      const items = listItems();
      console.log(JSON.stringify(items, null, 2));
    } else if (cmd === "get") {
      if (!arg) { console.error("Usage: node secrets.js get <name>"); process.exit(1); }
      const item = getItem(arg);
      console.log(JSON.stringify(item, null, 2));
    } else if (cmd === "audit") {
      if (!arg) { console.error("Usage: node secrets.js audit <name>"); process.exit(1); }
      console.log(JSON.stringify(getItemAudit(arg), null, 2));
    } else {
      console.error("Usage: node secrets.js [list|get <name>|audit <name>]");
      process.exit(1);
    }
  } catch (e) {
    console.error("Error:", e.message);
    process.exit(1);
  }
}

module.exports = { handleSecretsRequest, listItems, getItem, getItemAudit };
