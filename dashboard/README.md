# Office dashboard

React + Vite. Two screens: live delivery status, and the full attempt record.

Built on the Metronic component library, trimmed to the ten components this
product actually uses. The starter's demo layouts, routing, config and
21MB of sample media are removed; what remains is under `src/pod/`.

```
src/pod/
  AppShell.tsx        sidebar, header, navigation
  LiveStatusPage.tsx  today's tiles and newest attempts, fed by SSE
  AttemptsPage.tsx    the full record, filtered and keyset-paged
  SummaryDialog.tsx   AI draft review: edit, regenerate, approve and send
  api.ts              typed client, token refresh, SSE subscription
  outcomes.ts         outcome vocabulary, mirroring the server's
```

## Run

```bash
npm install
VITE_API_BASE=http://localhost:3000 npm run dev
```

Without `VITE_API_BASE` the app calls the same origin, which is how it runs
in production: Caddy serves these static files and proxies `/api` from the
same host, so there is no CORS surface and no environment-specific URL.

## Notes

- The live feed is a **doorbell**, not a data source. On an event the page
  re-reads from the API, which keeps the database the single source of truth
  for what the office sees.
- Evidence completeness is rendered as a first-class state. "Awaiting media"
  must never be mistaken for full proof.
- Generated summaries are shown as drafts. Send stays disabled until the text
  has been read, and the model's original wording is kept beside any edit.
