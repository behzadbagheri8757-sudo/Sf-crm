# BAGHERI CRM ↔ AI Assistant — Patch Notes

## What changed
- Added `js/views/assistant.js`: a read-only chat view under More → دستیار فروش باقری.
- Added route `/assistant` and loaded the view in `index.html`.
- The user enters `ASSISTANT_ACCESS_TOKEN` at runtime; it is not saved to localStorage.
- Selecting a customer requires explicit consent before sending the limited context to Render/Groq.
- Context is built locally from one selected customer: name, official CRM-calculated balance, five recent invoices, four recent visits, and the existing CRM recommendation. No phone/address or full database is sent.
- The server accepts optional plain-text `context` up to 3,000 characters; it is treated as untrusted data.
- No write endpoints were added. Invoice, payment, stock, FIFO, backup and CRM persistence logic were not changed.
- Conversation history remains in page memory only. Starting a new chat or leaving the view clears it.

## Tests performed locally
- `npm test` in `bagheri-ai-assistant-server`: **30 passed, 0 failed**.
- `node --check` on changed JavaScript files: **PASS**.
- Real iPhone / deployed Render / GitHub Pages browser test: **NOT RUN**.

## Required deployment steps
1. Commit/push the changed files to the same GitHub repository that serves BAGHERI CRM and the Render service.
2. In Render → SF-crm → Environment, add/update `ALLOWED_ORIGINS` with the exact GitHub Pages **origin only** (scheme + hostname, no path and no trailing slash). Example if the site uses the default GitHub Pages domain: `https://behzadbagheri8757-sudo.github.io`. If a custom domain is used, use that exact origin instead.
3. Wait for Render to deploy. Keep `ASSISTANT_ACCESS_TOKEN` and `GROQ_API_KEY` only in Render's Environment settings; never commit them.
4. Open CRM → More → دستیار فروش باقری. Enter the existing `ASSISTANT_ACCESS_TOKEN` in the password field. Try a general message first; then select one customer, tick consent, and ask a customer-specific question.
5. After testing, set `ENABLE_TEST_PAGE=false` in Render if it is still true.

## Known boundaries
- This is on-demand context transfer, not continuous sync.
- Only the selected customer's bounded summary is sent. General chat sends no CRM data.
- The summary is transmitted to the Render server and then Groq. Do not use customer context unless comfortable sending those selected fields to that third-party model provider.
- No actual deployed/iPhone test was possible from this environment; successful local tests do not prove production CORS/deploy configuration.
