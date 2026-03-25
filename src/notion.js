/**
 * Notion API module using curl
 * Queries Notion databases for Projects and Space HQ documents
 */

const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

// Load config
const configPath = path.join(__dirname, "../config/notion.json");
let config = { apiKey: "", projectBoard: null, spaceHQ: null };

try {
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  }
} catch (e) {
  console.error("[Notion] Failed to load config:", e.message);
}

// Support env:var syntax for apiKey
let apiKey = config.apiKey;
if (typeof apiKey === "string" && apiKey.startsWith("env:")) {
  apiKey = process.env[apiKey.slice(4)] || "";
}
const API_KEY = apiKey;
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

/**
 * Make a curl request to the Notion API
 * @param {string} method - HTTP method
 * @param {string} endpoint - API endpoint (appended to base URL)
 * @param {object} body - Request body (for POST/PATCH)
 * @param {number} pageSize - Number of results per page
 * @returns {object} Parsed JSON response
 */
function notionCurl(method, endpoint, body = null, pageSize = 100) {
  const url = `${NOTION_API}${endpoint}`;

  const headers = [
    `Authorization: Bearer ${API_KEY}`,
    `Notion-Version: ${NOTION_VERSION}`,
    "Content-Type: application/json",
  ];

  const args = ["-s", "-X", method];
  headers.forEach((h) => args.push("-H", h));
  if (body) {
    args.push("-d", JSON.stringify(body));
  }
  args.push(url);

  try {
    const output = execFileSync("curl", args, { timeout: 15000 });
    return JSON.parse(output.toString());
  } catch (e) {
    const stderr = e.stderr ? e.stderr.toString() : "";
    if (stderr.includes("404") || stderr.includes("Could not resolve host")) {
      return { object: "error", code: "not_found", message: "Notion resource not found" };
    }
    console.error("[Notion] curl error:", e.message);
    return { object: "error", code: "internal_error", message: e.message };
  }
}

/**
 * Query a Notion database with pagination support
 * @param {string} databaseId - Notion database ID
 * @param {object} body - Query body
 * @returns {array} All results from the database
 */
function queryDatabase(databaseId, body = {}) {
  const allResults = [];
  let cursor = undefined;

  const queryBody = {
    page_size: 100,
    ...body,
  };

  // Paginate through all results
  do {
    if (cursor) {
      queryBody.start_cursor = cursor;
    }

    const response = notionCurl("POST", `/databases/${databaseId}/query`, queryBody);

    if (response.object === "error") {
      console.error(`[Notion] Database query error: ${response.message}`);
      return [];
    }

    if (response.results) {
      allResults.push(...response.results);
    }

    cursor = response.has_more ? response.next_cursor : null;
  } while (cursor);

  return allResults;
}

/**
 * Extract a property value from a Notion page property
 */
function extractProperty(prop) {
  if (!prop) return null;

  switch (prop.type) {
    case "title":
      return prop.title?.map((t) => t.plain_text).join("") || "";
    case "rich_text":
      return prop.rich_text?.map((t) => t.plain_text).join("") || "";
    case "select":
      return prop.select?.name || null;
    case "multi_select":
      return prop.multi_select?.map((s) => s.name) || [];
    case "date":
      return prop.date?.start || null;
    case "people":
      return prop.people?.map((p) => p.name || p.id) || [];
    case "checkbox":
      return prop.checkbox || false;
    case "number":
      return prop.number || null;
    case "url":
      return prop.url || null;
    case "email":
      return prop.email || null;
    case "phone_number":
      return prop.phone_number || null;
    case "status":
      return prop.status?.name || null;
    default:
      return null;
  }
}

/**
 * Map Notion page to a clean project object
 */
function mapProject(page) {
  const props = page.properties || {};

  // Find the name property (could be "Name", "Title", etc.)
  let name = "";
  for (const [key, val] of Object.entries(props)) {
    if (val.type === "title") {
      name = val.title?.map((t) => t.plain_text).join("") || "";
      break;
    }
  }

  // Extract standard fields
  const status = extractProperty(props["Status"] || props["status"]);
  const priority = extractProperty(props["Priority"] || props["priority"]);
  const dueDate = extractProperty(props["Due Date"] || props["Due"] || props["due"]);
  const assignee = extractProperty(props["Assignee"] || props["assignee"]);
  const category = extractProperty(props["Category"] || props["category"]);
  const description = extractProperty(props["Description"] || props["Tech Notes"] || props["Workflow"]) || "";
  const projectUrl = extractProperty(props["Project URL"] || props["URL"]) || null;
  const archived = extractProperty(props["Archived"]) || false;

  return {
    id: page.id,
    name,
    status: status || "No Status",
    priority: priority || null,
    dueDate: dueDate || null,
    assignee: assignee ? (Array.isArray(assignee) ? assignee.join(", ") : assignee) : null,
    category: category ? (Array.isArray(category) ? category.join(", ") : category) : null,
    description,
    projectUrl,
    archived,
    url: page.url,
    lastEdited: page.last_edited_time,
  };
}

/**
 * Get all projects from the project board database
 * @returns {array} Array of project objects
 */
function getProjects() {
  if (!config.projectBoard?.databaseId) {
    return [];
  }

  try {
    const results = queryDatabase(config.projectBoard.databaseId);
    return results.map(mapProject);
  } catch (e) {
    console.error("[Notion] getProjects error:", e.message);
    return [];
  }
}

/**
 * Get a single project with full block content
 * @param {string} id - Notion page ID
 * @returns {object} Project with block content
 */
function getProject(id) {
  try {
    // Fetch page info
    const page = notionCurl("GET", `/pages/${id}`);
    if (page.object === "error") {
      return { error: page.message };
    }

    const project = mapProject(page);

    // Fetch block children
    const blocks = getBlockChildren(id);

    return {
      ...project,
      blocks,
    };
  } catch (e) {
    console.error("[Notion] getProject error:", e.message);
    return { error: e.message };
  }
}

/**
 * Get block children for a page
 * @param {string} pageId - Notion page ID
 * @returns {array} Array of blocks
 */
function getBlockChildren(pageId) {
  const allBlocks = [];
  let cursor = undefined;

  do {
    const params = cursor ? `?start_cursor=${cursor}` : "";
    const response = notionCurl("GET", `/blocks/${pageId}/children${params}`);

    if (response.object === "error") {
      break;
    }

    if (response.results) {
      allBlocks.push(...response.results);
    }

    cursor = response.has_more ? response.next_cursor : null;
  } while (cursor);

  return allBlocks;
}

/**
 * Render a Notion block to plain text
 * @param {object} block - Notion block object
 * @returns {string} Plain text representation
 */
function blockToText(block) {
  const type = block.type;
  const content = block[type] || {};

  switch (type) {
    case "paragraph":
      return content.rich_text?.map((t) => t.plain_text).join("") || "";
    case "heading_1":
      return `# ${content.rich_text?.map((t) => t.plain_text).join("") || ""}`;
    case "heading_2":
      return `## ${content.rich_text?.map((t) => t.plain_text).join("") || ""}`;
    case "heading_3":
      return `### ${content.rich_text?.map((t) => t.plain_text).join("") || ""}`;
    case "bulleted_list_item":
      return `• ${content.rich_text?.map((t) => t.plain_text).join("") || ""}`;
    case "numbered_list_item":
      return `1. ${content.rich_text?.map((t) => t.plain_text).join("") || ""}`;
    case "to_do":
      const checked = content.checked ? "☑" : "☐";
      return `${checked} ${content.rich_text?.map((t) => t.plain_text).join("") || ""}`;
    case "toggle":
      return `▶ ${content.rich_text?.map((t) => t.plain_text).join("") || ""}`;
    case "code":
      return `\`\`\`${content.language || ""}\n${content.rich_text?.map((t) => t.plain_text).join("") || ""}\n\`\`\``;
    case "quote":
      return `> ${content.rich_text?.map((t) => t.plain_text).join("") || ""}`;
    case "callout":
      return `💡 ${content.rich_text?.map((t) => t.plain_text).join("") || ""}`;
    case "divider":
      return "─────────────────────────────────";
    case "image":
      const caption = content.caption?.map((t) => t.plain_text).join("") || "image";
      const url = content.type === "external" ? content.external?.url : content.file?.url;
      return `[Image: ${caption}](${url || ""})`;
    case "video":
      const vidCaption = content.caption?.map((t) => t.plain_text).join("") || "video";
      const vidUrl = content.type === "external" ? content.external?.url : content.file?.url;
      return `[Video: ${vidCaption}](${vidUrl || ""})`;
    case "bookmark":
      return `[Bookmark: ${content.url}](${content.url})`;
    case "embed":
      return `[Embed: ${content.url}](${content.url})`;
    case "child_database":
      return `[Child Database: ${content.title || block.id}]`;
    case "table":
      return `[Table: ${content.table_width || ""} cols]`;
    case "column_list":
      return "";
    case "column":
      return "";
    default:
      if (content.rich_text) {
        return content.rich_text.map((t) => t.plain_text).join("");
      }
      return "";
  }
}

/**
 * Convert blocks to plain text with hierarchy
 */
function blocksToText(blocks, indent = 0) {
  const lines = [];
  let inBulletList = false;
  let inNumberedList = false;

  for (const block of blocks) {
    const type = block.type;

    // Handle list continuity
    if (type === "bulleted_list_item") {
      if (!inBulletList) {
        inBulletList = true;
      }
      lines.push("  ".repeat(indent) + blockToText(block));
    } else if (type === "numbered_list_item") {
      if (!inNumberedList) {
        inNumberedList = true;
      }
      lines.push("  ".repeat(indent) + blockToText(block));
    } else {
      inBulletList = false;
      inNumberedList = false;

      const text = blockToText(block);
      if (text) {
        lines.push("  ".repeat(indent) + text);
      }
    }

    // Process children recursively
    if (block.has_children && block.children) {
      const childText = blocksToText(block.children, indent + 1);
      if (childText) {
        lines.push(childText);
      }
    }
  }

  return lines.join("\n");
}

/**
 * Get all Space HQ entries
 * @returns {array} Array of document objects
 */
function getSpaceHQ() {
  if (!config.spaceHQ?.databaseId) {
    return [];
  }

  try {
    const results = queryDatabase(config.spaceHQ.databaseId);
    return results.map((page) => {
      const props = page.properties || {};

      // Find name property
      let name = "";
      for (const [key, val] of Object.entries(props)) {
        if (val.type === "title") {
          name = val.title?.map((t) => t.plain_text).join("") || "";
          break;
        }
      }

      // Find description
      let description = "";
      const descProp = props["Description"] || props["Summary"] || props["Notes"];
      if (descProp) {
        description = extractProperty(descProp) || "";
      }

      return {
        id: page.id,
        name,
        description: description.slice(0, 200),
        url: page.url,
        lastEdited: page.last_edited_time,
      };
    });
  } catch (e) {
    console.error("[Notion] getSpaceHQ error:", e.message);
    return [];
  }
}

/**
 * Get document content for a Space HQ entry
 * @param {string} id - Notion page ID
 * @returns {object} Document with content
 */
function getDocumentContent(id) {
  try {
    const page = notionCurl("GET", `/pages/${id}`);
    if (page.object === "error") {
      return { error: page.message };
    }

    const props = page.properties || {};

    // Find name
    let name = "";
    for (const [key, val] of Object.entries(props)) {
      if (val.type === "title") {
        name = val.title?.map((t) => t.plain_text).join("") || "";
        break;
      }
    }

    const blocks = getBlockChildren(id);
    const contentText = blocksToText(blocks);

    return {
      id: page.id,
      name,
      url: page.url,
      content: contentText,
      blocks,
    };
  } catch (e) {
    console.error("[Notion] getDocumentContent error:", e.message);
    return { error: e.message };
  }
}

/**
 * Render a single Notion block to docx paragraph
 * @param {object} block - Notion block object
 * @param {object} Document - docx Document class
 * @returns {object} docx element or null
 */
function blockToDocx(block, Document) {
  const type = block.type;
  const content = block[type] || {};

  const TextUtils = require("docx").TextUtils;
  const makeBold = (text) => new Document.TextRun({ text, bold: true });
  const makeItalic = (text) => new Document.TextRun({ text, italics: true });
  const plainText = (richText) =>
    richText
      ?.map((t) => t.plain_text || "")
      .join("") || "";

  const richToRuns = (richText) => {
    if (!richText || !richText.length) return [];
    return richText.map((t) => {
      const text = t.plain_text || "";
      const styles = {};
      if (t.annotations?.bold) styles.bold = true;
      if (t.annotations?.italic) styles.italics = true;
      if (t.annotations?.code) styles.highlight = true;
      if (t.annotations?.strikethrough) styles.strike = true;
      return new Document.TextRun({ text, ...styles });
    });
  };

  switch (type) {
    case "paragraph":
      if (!content.rich_text?.length) return new Document.Paragraph({});
      return new Document.Paragraph({ children: richToRuns(content.rich_text) });
    case "heading_1":
      return new Document.Heading(1, {
        children: richToRuns(content.rich_text),
      });
    case "heading_2":
      return new Document.Heading(2, {
        children: richToRuns(content.rich_text),
      });
    case "heading_3":
      return new Document.Heading(3, {
        children: richToRuns(content.rich_text),
      });
    case "bulleted_list_item":
      return new Document.BulletLevel({
        children: richToRuns(content.rich_text),
      });
    case "numbered_list_item":
      return new Document.NumberingLevel({
        children: richToRuns(content.rich_text),
      });
    case "to_do": {
      const checked = content.checked ? "☑" : "☐";
      return new Document.Paragraph({
        children: [
          new Document.TextRun({ text: checked + " " }),
          ...richToRuns(content.rich_text),
        ],
      });
    }
    case "toggle":
      return new Document.Paragraph({
        children: [
          new Document.TextRun({ text: "▶ ", bold: true }),
          ...richToRuns(content.rich_text),
        ],
      });
    case "code":
      return new Document.Paragraph({
        children: [
          new Document.TextRun({
            text: content.rich_text?.map((t) => t.plain_text).join("") || "",
            font: "Courier New",
            size: 18,
          }),
        ],
      });
    case "quote":
      return new Document.Paragraph({
        children: richToRuns(content.rich_text),
        heading: Document.HeadingLevel.HEADING_4,
      });
    case "callout":
      return new Document.Paragraph({
        children: [
          new Document.TextRun({ text: "💡 " }),
          ...richToRuns(content.rich_text),
        ],
      });
    case "divider":
      return new Document.Paragraph({
        children: [new Document.TextRun({ text: "─────────────────────────────────" })],
      });
    case "image": {
      const url = content.type === "external" ? content.external?.url : content.file?.url;
      const caption = content.caption?.map((t) => t.plain_text).join("") || "image";
      return new Document.Paragraph({
        children: [new Document.TextRun({ text: `[Image: ${caption}](${url || ""})`, italics: true })],
      });
    }
    case "video": {
      const url = content.type === "external" ? content.external?.url : content.file?.url;
      const caption = content.caption?.map((t) => t.plain_text).join("") || "video";
      return new Document.Paragraph({
        children: [new Document.TextRun({ text: `[Video: ${caption}](${url || ""})`, italics: true })],
      });
    }
    case "bookmark":
      return new Document.Paragraph({
        children: [
          new Document.TextRun({ text: `Bookmark: ${content.url}`, color: "0563C1", underline: {} }),
        ],
      });
    default:
      if (content.rich_text?.length) {
        return new Document.Paragraph({ children: richToRuns(content.rich_text) });
      }
      return null;
  }
}

/**
 * Convert Notion blocks to docx document children
 */
function blocksToDocx(blocks, Document) {
  const elements = [];
  let inBulletList = false;
  let inNumberedList = false;

  for (const block of blocks) {
    const type = block.type;

    if (type === "bulleted_list_item") {
      if (!inBulletList) {
        elements.push(
          new Document.BulletLevel({
            children: [],
            level: 0,
          }),
        );
        inBulletList = true;
      }
      elements.push(blockToDocx(block, Document));
    } else if (type === "numbered_list_item") {
      if (!inNumberedList) {
        elements.push(
          new Document.NumberingLevel({
            children: [],
            level: 0,
          }),
        );
        inNumberedList = true;
      }
      elements.push(blockToDocx(block, Document));
    } else {
      inBulletList = false;
      inNumberedList = false;
      const el = blockToDocx(block, Document);
      if (el) elements.push(el);
    }

    // Process children recursively
    if (block.has_children && block.children) {
      const childElements = blocksToDocx(block.children, Document);
      elements.push(...childElements);
    }
  }

  return elements;
}

/**
 * Get document content as a docx Buffer
 * @param {string} id - Notion page ID
 * @returns {Buffer} Word document buffer
 */
function getDocumentDocx(id) {
  const { Document, Packer, Paragraph, TextRun, Heading, HeadingLevel, BulletLevel, NumberingLevel } = require("docx");

  try {
    const page = notionCurl("GET", `/pages/${id}`);
    if (page.object === "error") {
      return { error: page.message };
    }

    const props = page.properties || {};

    // Find name
    let name = "";
    for (const [key, val] of Object.entries(props)) {
      if (val.type === "title") {
        name = val.title?.map((t) => t.plain_text).join("") || "";
        break;
      }
    }

    const blocks = getBlockChildren(id);

    // Build docx elements
    const children = [
      new Document.Heading(1, { children: [new Document.TextRun({ text: name || "Untitled Document" })] }),
    ];

    const blockElements = blocksToDocx(blocks, Document);
    children.push(...blockElements);

    const doc = new Document({
      title: name || "Untitled",
      creator: "OpenClaw Command Center",
      description: `Exported from Notion: ${name}`,
      sections: [
        {
          properties: {},
          children,
        },
      ],
    });

    return Packer.toBuffer(doc);
  } catch (e) {
    console.error("[Notion] getDocumentDocx error:", e.message);
    return { error: e.message };
  }
}

module.exports = {
  getProjects,
  getProject,
  getSpaceHQ,
  getDocumentContent,
  getDocumentDocx,
};
