import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response } from "express";
import axios, { AxiosInstance } from "axios";
import { z } from "zod";

// ── Config ────────────────────────────────────────────────────────────────────

const DOCUSEAL_API_KEY = process.env.DOCUSEAL_API_KEY || "";
const DOCUSEAL_BASE_URL = (process.env.DOCUSEAL_BASE_URL || "https://app.docuseal.com").replace(/\/$/, "");
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";
const PORT = parseInt(process.env.PORT || "3000", 10);

if (!DOCUSEAL_API_KEY) {
  console.error("ERROR: DOCUSEAL_API_KEY environment variable is required");
  process.exit(1);
}
if (!MCP_AUTH_TOKEN) {
  console.error("ERROR: MCP_AUTH_TOKEN environment variable is required");
  process.exit(1);
}

// ── DocuSeal API Client ───────────────────────────────────────────────────────

const api: AxiosInstance = axios.create({
  baseURL: `${DOCUSEAL_BASE_URL}/api/v1`,
  headers: {
    "X-Auth-Token": DOCUSEAL_API_KEY,
    "Content-Type": "application/json",
    "Accept": "application/json",
  },
  timeout: 15000,
});

async function docusealGet<T>(path: string, params?: Record<string, unknown>): Promise<T> {
  const response = await api.get<T>(path, { params });
  return response.data;
}

async function docusealPost<T>(path: string, body: unknown): Promise<T> {
  const response = await api.post<T>(path, body);
  return response.data;
}

// ── MCP Server Factory ────────────────────────────────────────────────────────
// One server instance per request (stateless pattern — scales cleanly on Railway)

function createServer(): McpServer {
  const server = new McpServer({
    name: "docuseal-mcp-server",
    version: "1.0.0",
  });

  // ── Tool: search_templates ──────────────────────────────────────────────────

  server.registerTool(
    "search_templates",
    {
      title: "Search Templates",
      description: `Search DocuSeal document templates by name.

Returns a list of matching templates with their IDs, names, and field counts.
Use the returned template ID with send_documents or load_template.

Args:
  - q (string): Search query to filter templates by name
  - limit (number, optional): Max results to return (default 10)

Examples:
  - "Find the SOW template" → q="SOW"
  - "List all proposal templates" → q="proposal"`,
      inputSchema: {
        q: z.string().describe("Search query to filter templates by name"),
        limit: z.number().int().min(1).max(50).default(10).optional()
          .describe("Number of templates to return (default 10)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ q, limit = 10 }) => {
      try {
        const data = await docusealGet("/templates", { q, limit });
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err: unknown) {
        return { isError: true, content: [{ type: "text" as const, text: `Error searching templates: ${errorMessage(err)}` }] };
      }
    }
  );

  // ── Tool: load_template ─────────────────────────────────────────────────────

  server.registerTool(
    "load_template",
    {
      title: "Load Template",
      description: `Load a DocuSeal template by ID, returning its fields and signer roles.

Use this to inspect a template before sending — confirms field names and roles
needed for the send_documents submitters array.

Args:
  - template_id (number): The template's numeric ID (get from search_templates)`,
      inputSchema: {
        template_id: z.number().int().positive().describe("Template identifier"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ template_id }) => {
      try {
        const data = await docusealGet(`/templates/${template_id}`);
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err: unknown) {
        return { isError: true, content: [{ type: "text" as const, text: `Error loading template ${template_id}: ${errorMessage(err)}` }] };
      }
    }
  );

  // ── Tool: create_template ───────────────────────────────────────────────────

  server.registerTool(
    "create_template",
    {
      title: "Create Template",
      description: `Create a new DocuSeal document template.

Provide a URL to a PDF or DOCX file to upload it as a template, or provide only
a name to create an empty template and receive an edit URL to upload the file
via the DocuSeal web UI.

Args:
  - name (string): Template name (required)
  - url (string, optional): Public URL of a PDF or DOCX file to use as the template base

Returns:
  - Template ID, edit URL, and template details`,
      inputSchema: {
        name: z.string().describe("Template name"),
        url: z.string().url().optional()
          .describe("Optional public URL of a PDF or DOCX file to upload as the template base"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ name, url }) => {
      try {
        const body: Record<string, unknown> = { name };
        if (url) body.documents = [{ name, url }];
        const data = await docusealPost("/templates", body);
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err: unknown) {
        return { isError: true, content: [{ type: "text" as const, text: `Error creating template: ${errorMessage(err)}` }] };
      }
    }
  );

  // ── Tool: search_documents ──────────────────────────────────────────────────

  server.registerTool(
    "search_documents",
    {
      title: "Search Documents",
      description: `Search DocuSeal document submissions (sent documents).

Returns a list of submissions with their signing status, submitters, and timestamps.

Args:
  - q (string): Search query (name, email, or document name)
  - limit (number, optional): Max results to return (default 10)`,
      inputSchema: {
        q: z.string().describe("Search query to filter submissions"),
        limit: z.number().int().min(1).max(50).default(10).optional()
          .describe("Number of submissions to return (default 10)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ q, limit = 10 }) => {
      try {
        const data = await docusealGet("/submissions", { q, limit });
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err: unknown) {
        return { isError: true, content: [{ type: "text" as const, text: `Error searching documents: ${errorMessage(err)}` }] };
      }
    }
  );

  // ── Tool: send_documents ────────────────────────────────────────────────────

  server.registerTool(
    "send_documents",
    {
      title: "Send Document for Signing",
      description: `Send a DocuSeal template to one or more signers via email.

Each submitter must have a name, email, and matching role from the template.
Use load_template first to confirm the available roles.

Args:
  - template_id (number): Template ID to send (get from search_templates)
  - submitters (array): List of signers, each with:
    - name (string): Signer's full name
    - email (string): Signer's email address
    - role (string, optional): Role name from the template (e.g. "Client", "Provider")

Returns:
  - Submission ID and status

Examples:
  - Send SOW to Josh: template_id=3467148, submitters=[{name:"Josh Robertson", email:"josh@cerberusautostyling.ca", role:"Client"}]`,
      inputSchema: {
        template_id: z.number().int().positive().describe("Template identifier"),
        submitters: z.array(z.object({
          name: z.string().describe("Submitter full name"),
          email: z.string().email().describe("Submitter email address"),
          role: z.string().optional().describe("Signing role name from the template"),
          fields: z.array(z.object({
            name: z.string(),
            value: z.unknown(),
          })).optional().describe("Optional prefilled field values (become read-only for this submitter)"),
        })).min(1).describe("List of signers"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ template_id, submitters }) => {
      try {
        const data = await docusealPost("/submissions", { template_id, submitters });
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err: unknown) {
        return { isError: true, content: [{ type: "text" as const, text: `Error sending document: ${errorMessage(err)}` }] };
      }
    }
  );

  return server;
}

// ── Express App ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Auth middleware
function requireAuth(req: Request, res: Response, next: () => void): void {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token || token !== MCP_AUTH_TOKEN) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// Health check (no auth required — Railway uses this)
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "docuseal-mcp-server", base_url: DOCUSEAL_BASE_URL });
});

// MCP endpoint
app.post("/mcp", requireAuth, async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });
  const server = createServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", (_req, res) => {
  res.status(405).json({ error: "MCP endpoint requires POST" });
});

// Start
app.listen(PORT, () => {
  console.log(`DocuSeal MCP server running on port ${PORT}`);
  console.log(`DocuSeal base URL: ${DOCUSEAL_BASE_URL}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function errorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const detail = err.response?.data?.error || err.response?.data?.message || err.message;
    return `HTTP ${status}: ${detail}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
