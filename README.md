# /rooms — Slack command for available meeting rooms

A `/rooms <office>` slash command that shows which meeting rooms are free right
now, using Google Calendar room resources. Reply is ephemeral (only the person
who ran it sees it).

## Files

| File | Purpose |
|------|---------|
| `server.js` | The whole service: verifies Slack, queries Google, replies. |
| `package.json` | Dependencies (`express`, `googleapis`). Node 18+. |
| `.env.example` | Template for the secrets/config you provide. |

---

## 1. Google Workspace setup

1. In the **Google Cloud console**, create a project and enable two APIs:
   **Google Calendar API** and **Admin SDK API**.
2. Create a **service account** and download its **JSON key**.
3. In the **Admin console** → Security → Access and data control → **API controls**
   → **Domain-wide delegation**, add the service account's client ID with exactly
   these scopes:
   ```
   https://www.googleapis.com/auth/admin.directory.resource.calendar.readonly
   https://www.googleapis.com/auth/calendar.freebusy
   ```
4. Make sure each meeting room is a **resource with a building assigned**
   (Admin console → Buildings and resources). The bot filters rooms by building.

## 2. Slack setup

1. Create an app at <https://api.slack.com/apps>.
2. **Slash Commands** → create `/rooms`, Request URL = `https://YOUR_HOST/slack/rooms`.
3. **Basic Information** → copy the **Signing Secret**.
4. **Install** the app to your workspace. (No bot token or OAuth scopes needed —
   replies go back through Slack's `response_url`.)

## 3. Configure

Copy `.env.example` to `.env` and fill in:

- `SLACK_SIGNING_SECRET` — from Slack Basic Information.
- `GOOGLE_SA_EMAIL` / `GOOGLE_SA_PRIVATE_KEY` — from the service-account JSON.
- `GOOGLE_ADMIN_SUBJECT` — a Workspace admin the service account impersonates.

Then edit the config at the top of `server.js`:

- **`OFFICES`** — map each keyword users type to a Google `buildingId`, e.g.
  `london: { buildingId: "LON-1", label: "London" }`.
- **`EXCLUDED_ROOM_EMAILS`** — rooms to hide from everyone (exec rooms, booths…).
- **`EXCLUDED_NAME_PATTERNS`** — optional regexes to hide rooms by name.
- **`MIN_FREE_MINUTES`** — a room must be free at least this long to show (default 15).
  This hides rooms that are free now but booked again very soon.
- **`LOOKAHEAD_MIN`** — how far ahead calendars are read for "free until" (default 120).

## 4. Run

```bash
npm install
npm start
```

The service needs a public **HTTPS** URL matching your slash command Request URL.
Any host works — Cloud Run, Render, Fly.io, or `ngrok http 3000` for testing.
`GET /health` returns `ok` for uptime checks.

## Usage

```
/rooms london
```

Returns the rooms in that office free for the next 30 minutes, smallest first.
`/rooms` with no office lists the valid keywords.

---

## How it works (quick reference)

1. Slack POSTs the command → signature verified → ACK within 3 s.
2. Room resources listed via Admin SDK (cached 1 hour), filtered to the office's
   building and minus the excluded rooms.
3. `freebusy.query` runs in batches of 50 (Google's per-request cap). For each
   room we compute how long it's free from now; only rooms with at least
   `MIN_FREE_MINUTES` of runway are shown, each labelled with how long it's free.
4. Result posted back to Slack via `response_url` as an ephemeral message.

## Notes / limits

- `freebusy.query` resolves at most **50 calendars per request** — handled by batching.
- Rooms the service can't read are treated as **not free** (fail safe), so a
  permissions glitch never sends someone to an occupied room.
- Excluded rooms never enter the cache or get checked — invisible to all users.

## Optional extensions (not built)

- **Book from Slack:** add an interactivity endpoint + "Book 30 min" button
  (`calendar.events.insert` with the room as attendee; needs `users:read.email`
  and the `calendar.events` scope on delegation).
- **Auto-detect office** from the requester's Slack profile instead of an argument.
- **Per-person visibility:** show some rooms only to certain Slack users/usergroups
  using `req.body.user_id`.
