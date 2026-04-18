# DocuSeal MCP Server — Deploy + Verify Guide

**Fix version:** v0.4.0 (2026-04-18) — **STATEFUL MODE**
**What changed:** The v0.3.0 fix (stateless + 405 on GET) was insufficient. Cowork's MCP client requires a real session-scoped SSE notification stream, and responding with 405 causes Cowork to loop retrying `initialize` forever without ever calling `tools/list`. This version runs the server in canonical MCP **stateful** mode: every `initialize` mints a session ID, returns it in a `Mcp-Session-Id` header, and subsequent GET with that session ID opens a long-lived SSE stream.

---

## Step 1 — Commit + push (Railway auto-deploys from GitHub)

From the repo (via Claude Code in Cursor, or your terminal):

```powershell
cd "C:\VS Code Projects\Abot Developments"
git add tools/docuseal-mcp-server/src/index.ts tools/docuseal-mcp-server/DEPLOY.md
git commit -m "fix(docuseal-mcp): switch to stateful MCP mode for Cowork compatibility"
git push
```

Railway will pick up the push and start a new build. Watch the deploy in the Railway dashboard — wait for the green checkmark (~1–2 min).

## Step 2 — Verify the server (stateful handshake preflight)

This preflight captures the `Mcp-Session-Id` from the initialize response and uses it on subsequent calls, exactly like Cowork does.

```powershell
$URL   = "https://docuseal-mcp-server-production.up.railway.app"
$TOKEN = "3QQ4VvJfsOOMaSPU4LURiq2nyMQNt8bD"

# 1. Health (no auth)
curl.exe -sS "$URL/health"

# 2. Initialize — capture response headers to get Mcp-Session-Id
curl.exe -sS -i -X POST "$URL/mcp" `
  -H "Content-Type: application/json" `
  -H "Accept: application/json, text/event-stream" `
  -H "Authorization: Bearer $TOKEN" `
  -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"preflight\",\"version\":\"0.1\"}}}'

# Look for a response header like:   Mcp-Session-Id: 7f3c...uuid...
# Copy that value into $SID below:
$SID = "PASTE_SESSION_ID_HERE"

# 3. notifications/initialized (with session ID)
curl.exe -sS -X POST "$URL/mcp" `
  -H "Content-Type: application/json" `
  -H "Accept: application/json, text/event-stream" `
  -H "Authorization: Bearer $TOKEN" `
  -H "Mcp-Session-Id: $SID" `
  -d '{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}'

# 4. tools/list (with session ID) — should return 5 tools
curl.exe -sS -X POST "$URL/mcp" `
  -H "Content-Type: application/json" `
  -H "Accept: application/json, text/event-stream" `
  -H "Authorization: Bearer $TOKEN" `
  -H "Mcp-Session-Id: $SID" `
  -d '{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}'

# 5. GET /mcp with session ID — this should HOLD OPEN (SSE stream).
#    Use --max-time 3 so the command returns; seeing headers then silence = healthy.
curl.exe -sS -i --max-time 3 "$URL/mcp" `
  -H "Authorization: Bearer $TOKEN" `
  -H "Mcp-Session-Id: $SID"

# 6. GET /mcp WITHOUT session ID — must return 400 (invalid session)
curl.exe -sS -i --max-time 3 "$URL/mcp" `
  -H "Authorization: Bearer $TOKEN"
```

**Pass criteria:**
- `/health` returns `{"status":"ok",...}`
- `initialize` response headers include `Mcp-Session-Id: <uuid>`
- `tools/list` returns 5 tools
- GET with valid session holds open (returns 200 + SSE content-type, then hangs until timeout — **this is correct**)
- GET without session returns 400 "Invalid or missing session ID"

If initialize succeeds but `tools/list` returns `"Bad Request: No valid session ID provided"`, the session map isn't persisting — check Railway logs for `[mcp] session initialized:` line.

## Step 3 — Rebuild the plugin (if token changed)

The current plugin is `docuseal-mcp-v3.plugin` at the workspace root. If the token in `Railway.env.MCP_AUTH_TOKEN` still matches what's baked into that plugin's `.mcp.json`, no rebuild needed. Otherwise rebuild:

```powershell
# Unzip, edit .mcp.json, rezip. Or ask Claude Cowork to rebuild it.
```

## Step 4 — Install the plugin in Cowork

1. Fully quit Cowork (Ctrl+Q — not just closing the window)
2. Settings → Plugins → uninstall any old `docuseal-mcp` versions
3. Reopen Cowork
4. Drag `docuseal-mcp-v3.plugin` into a conversation
5. Click **Install** on the preview card
6. Fully quit and reopen Cowork
7. Start a fresh conversation

## Step 5 — Verify tools appear

In a new conversation:

> "List the DocuSeal tools you have access to."

You should see `search_templates`, `load_template`, `create_template`, `search_documents`, `send_documents`.

If they don't appear, Railway logs should now show the full handshake sequence:
```
[mcp] POST /mcp rpc=initialize auth=present
[mcp] session initialized: <uuid>
[mcp] POST /mcp rpc=notifications/initialized auth=present
[mcp] GET /mcp auth=present          ← SSE stream (no 405!)
[mcp] POST /mcp rpc=tools/list auth=present   ← THIS line was missing before
```

If `tools/list` never appears in logs, the GET isn't establishing the SSE stream — check that the GET response has content-type `text/event-stream` and hangs open (isn't immediately 400/405).

## Why stateful, not stateless

The MCP Streamable HTTP spec allows both. Stateless is simpler (one server per POST, no session tracking) and works with Claude Code and `mcp-remote`. **Cowork's plugin MCP client does not.** Cowork:

1. POSTs `initialize` — expects `Mcp-Session-Id` in response headers
2. Opens a GET `/mcp` with that session ID to receive server→client notifications
3. Only advances to `tools/list` **after the SSE stream is open**

In stateless mode there is no session ID to return, and the GET either hangs forever (if routed through the transport) or returns 405 (per spec). Cowork interprets both as "the server is still initializing" and never progresses. Stateful mode is the only compatible path for Cowork plugin MCPs.

## Next step after tools work — DocuSeal email sending

Once tools appear in Cowork, there are two remaining blockers for actually sending signing emails:

1. **Configure SMTP on the self-hosted DocuSeal instance** (Resend recommended — 3,000 emails/month free). Env vars go on the DocuSeal Railway service, not the MCP server:
   - `SMTP_ADDRESS=smtp.resend.com`
   - `SMTP_PORT=587`
   - `SMTP_USERNAME=resend`
   - `SMTP_PASSWORD=<resend API key>`
2. **Confirm `DOCUSEAL_API_KEY` in the MCP server env** is from the self-hosted instance, not app.docuseal.com. Log into `https://docuseal-railway-production-cb87.up.railway.app` → Profile → API → copy the key → update the MCP server Railway variable.
