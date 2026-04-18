# DocuSeal MCP Server — Deploy + Verify Guide

**Fix version:** v0.3.0 (2026-04-18)
**Root cause patched:** GET `/mcp` now returns 405 in stateless mode instead of hanging an SSE stream forever. This was silently breaking the Cowork plugin handshake.

---

## Step 1 — Deploy the updated server to Railway

Railway does **not** auto-deploy from GitHub for this service. You have to push via the Railway CLI from the server directory.

Open PowerShell and run:

```powershell
cd "C:\path\to\Abot Developments\tools\docuseal-mcp-server"
railway link                    # only if you haven't already — pick the docuseal-mcp-server service
railway up
```

Wait for the build + deploy to finish (Railway will print a green checkmark). The service URL doesn't change — it's still `https://docuseal-mcp-server-production.up.railway.app`.

## Step 2 — Rotate the MCP auth token in Railway

The v2 token was exposed in a prior chat session. The v3 plugin ships with a **new** token — update Railway to match.

1. Go to the Railway dashboard → `docuseal-mcp-server` service → **Variables**
2. Find `MCP_AUTH_TOKEN` and set it to:
   ```
   3QQ4VvJfsOOMaSPU4LURiq2nyMQNt8bD
   ```
3. Railway will auto-redeploy the service with the new variable. Wait ~30 seconds.

## Step 3 — Verify the server works (before touching Cowork)

Run this from PowerShell — a real MCP handshake that mimics what Cowork does. You should see tool definitions come back.

```powershell
# Health check
curl.exe -sS https://docuseal-mcp-server-production.up.railway.app/health

# Initialize (should return JSON-RPC initialize response with protocolVersion)
curl.exe -sS -X POST https://docuseal-mcp-server-production.up.railway.app/mcp `
  -H "Content-Type: application/json" `
  -H "Accept: application/json, text/event-stream" `
  -H "Authorization: Bearer 3QQ4VvJfsOOMaSPU4LURiq2nyMQNt8bD" `
  -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"preflight\",\"version\":\"0.1\"}}}'

# tools/list (should return 5 tools: search_templates, load_template, create_template, search_documents, send_documents)
curl.exe -sS -X POST https://docuseal-mcp-server-production.up.railway.app/mcp `
  -H "Content-Type: application/json" `
  -H "Accept: application/json, text/event-stream" `
  -H "Authorization: Bearer 3QQ4VvJfsOOMaSPU4LURiq2nyMQNt8bD" `
  -d '{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}'

# GET /mcp — this MUST return 405 now (the fix). If it hangs, the fix didn't deploy.
curl.exe -sS -i --max-time 5 https://docuseal-mcp-server-production.up.railway.app/mcp `
  -H "Authorization: Bearer 3QQ4VvJfsOOMaSPU4LURiq2nyMQNt8bD"
```

**Pass criteria:**
- Health returns `{"status":"ok",...}`
- Initialize returns protocolVersion + capabilities
- tools/list returns 5 tools
- **GET returns 405 immediately** (NOT a hang — this is the whole point of the fix)

## Step 4 — Install the v3 plugin in Cowork

1. Fully quit Cowork (Cmd/Ctrl+Q — not just closing the window)
2. Go to Settings → Plugins → uninstall `docuseal-mcp-v2` if present
3. Reopen Cowork
4. Drag `docuseal-mcp-v3.plugin` (at the workspace root) into a conversation
5. Click **Install** on the preview card
6. Fully quit and reopen Cowork again
7. Start a fresh conversation

## Step 5 — Verify tools appear in Cowork

In the new conversation, say:

> "List the DocuSeal tools you have access to."

You should see the 5 tools: `search_templates`, `load_template`, `create_template`, `search_documents`, `send_documents` (possibly namespaced like `docuseal-mcp:search_templates` or `mcp__plugin_docuseal-mcp_docuseal__search_templates`).

If they don't appear:

1. Railway logs will now show `[mcp] POST /mcp rpc=initialize auth=present` for every Cowork handshake attempt. Check the Railway logs — if there are NO entries when Cowork starts, Cowork isn't reaching the server at all (check plugin is actually installed). If there ARE entries but tools don't appear, there's a remaining handshake issue — capture the log lines for the next debug session.
2. In Cowork Settings → MCP Servers, check if `docuseal` shows connected/green.

## What changed in this fix

**Before (v2 server code):**
```typescript
app.all("/mcp", requireAuth, async (req, res) => {
  // routed BOTH GET and POST through transport.handleRequest()
  // in stateless mode, GET opens SSE stream that hangs forever
});
```

**After (v3 server code):**
```typescript
app.post("/mcp", requireAuth, async (req, res) => {
  // POST → process JSON-RPC through transport
});
app.get("/mcp", requireAuth, (_req, res) => {
  res.status(405).json(...);  // MCP SDK client handles 405 gracefully
});
app.delete("/mcp", requireAuth, (_req, res) => {
  res.status(405).json(...);
});
// + request logging middleware for diagnostics
```

## Next step after this works — DocuSeal side

Once tools appear in Cowork, there are two remaining blockers for actually sending signing emails:

1. **Configure SMTP on the self-hosted DocuSeal instance** (Resend recommended — 3,000 emails/month free). Env vars go on the DocuSeal Railway service, not the MCP server:
   - `SMTP_ADDRESS=smtp.resend.com`
   - `SMTP_PORT=587`
   - `SMTP_USERNAME=resend`
   - `SMTP_PASSWORD=<resend API key>`
2. **Confirm `DOCUSEAL_API_KEY` in the MCP server env** is from the self-hosted instance, not app.docuseal.com. Log into `https://docuseal-railway-production-cb87.up.railway.app` → Profile → API → copy the key → update the MCP server Railway variable.
