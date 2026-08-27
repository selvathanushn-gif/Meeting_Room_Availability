/**
 * /rooms — a Slack slash command that lists currently-available meeting rooms
 * for a given office, using Google Calendar room resources.
 *
 * Flow:
 *   1. Slack POSTs the slash command here.
 *   2. We verify the Slack signature and ACK within 3 seconds.
 *   3. Asynchronously we: list room resources (Admin SDK, cached),
 *      run freebusy.query in batches of 50, keep rooms with no busy block now,
 *      and post the result back to Slack via response_url.
 *
 * Requires Node 18+ (uses global fetch).
 */

const express = require("express");
const crypto = require("crypto");
const { google } = require("googleapis");

// ---------------------------------------------------------------------------
// Config (all from env — see .env.example)
// ---------------------------------------------------------------------------
const {
  SLACK_SIGNING_SECRET,
  GOOGLE_SA_EMAIL,
  GOOGLE_SA_PRIVATE_KEY,
  GOOGLE_ADMIN_SUBJECT, // a Workspace admin user to impersonate (needed for Admin SDK)
  PORT = 3000,
} = process.env;

// Map the keyword a user types (`/rooms london`) to a Google buildingId.
// buildingId comes from the Admin console / Admin SDK resources.buildings.list.
// Add one entry per office. The keys are what users type.
const OFFICES = {
  london: { buildingId: "Staging-Kanto", label: "Kanto" },
  nyc: { buildingId: "Staging-Bucharest", label: "Bucharest" },
  sf: { buildingId: "Staging-Seoul", label: "Seoul" },
};

// Rooms to hide from /rooms results, by resource email (exact match).
// Use this for exec/boardrooms, phone booths, or team-reserved spaces you
// don't want surfaced to everyone. Get the emails from the Admin console
// (Buildings and resources) or from a one-off run of listRooms().
const EXCLUDED_ROOM_EMAILS = new Set([
  // "exec-boardroom@resource.calendar.google.com",
  // "c_188...@resource.calendar.google.com",
]);

// Optional: also hide any room whose name matches one of these patterns
// (case-insensitive). Handy when hidden rooms share a naming convention.
const EXCLUDED_NAME_PATTERNS = [
  // /phone booth/i,
  // /^EXEC /i,
];

function isHidden(r) {
  if (EXCLUDED_ROOM_EMAILS.has(r.resourceEmail)) return true;
  const name = r.resourceName || r.generatedResourceName || "";
  return EXCLUDED_NAME_PATTERNS.some((re) => re.test(name));
}

// How far ahead we read each room's calendar (minutes). Larger gives better
// "free until" info; keep it comfortably above MIN_FREE_MINUTES.
const LOOKAHEAD_MIN = 120;

// A room must be free for at least this many minutes from now to be shown.
// This is the buffer that hides rooms which are free this instant but about
// to be booked. Bump to 30 if you want more runway; drop to 5 for a looser list.
const MIN_FREE_MINUTES = 15;

// Google's freebusy.query resolves at most 50 calendars per request.
const FREEBUSY_BATCH = 50;

// ---------------------------------------------------------------------------
// Google auth — service account with domain-wide delegation
// ---------------------------------------------------------------------------
function getAuth() {
  return new google.auth.JWT({
    email: GOOGLE_SA_EMAIL,
    key: GOOGLE_SA_PRIVATE_KEY.replace(/\\n/g, "\n"),
    subject: GOOGLE_ADMIN_SUBJECT,
    scopes: [
      "https://www.googleapis.com/auth/admin.directory.resource.calendar.readonly",
      "https://www.googleapis.com/auth/calendar.freebusy",
    ],
  });
}

// ---------------------------------------------------------------------------
// Room resource listing (cached — rooms rarely change)
// ---------------------------------------------------------------------------
let roomCache = { at: 0, rooms: [] };
const ROOM_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function listRooms(auth) {
  if (Date.now() - roomCache.at < ROOM_CACHE_TTL_MS && roomCache.rooms.length) {
    return roomCache.rooms;
  }
  const directory = google.admin({ version: "directory_v1", auth });
  const rooms = [];
  let pageToken;
  do {
    const res = await directory.resources.calendars.list({
      customer: "my_customer",
      maxResults: 500,
      pageToken,
    });
    for (const r of res.data.items || []) {
      if (r.resourceCategory !== "CONFERENCE_ROOM") continue; // skip desks, equipment, etc.
      if (isHidden(r)) continue; // skip rooms we don't want surfaced
      rooms.push({
        email: r.resourceEmail,
        name: r.resourceName || r.generatedResourceName,
        buildingId: r.buildingId || null,
        floor: r.floorName || null,
        capacity: r.capacity || null,
      });
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  roomCache = { at: Date.now(), rooms };
  return rooms;
}

// ---------------------------------------------------------------------------
// Availability check via freebusy.query (batched)
// ---------------------------------------------------------------------------
// Minutes a room is free starting now, given its busy blocks.
// Returns 0 if occupied right now, or Infinity if nothing is booked
// within the lookahead window.
function freeMinutesFrom(nowMs, busy) {
  let nextStart = Infinity;
  for (const b of busy) {
    const s = Date.parse(b.start);
    const e = Date.parse(b.end);
    if (s <= nowMs && e > nowMs) return 0; // busy this very moment
    if (s > nowMs) nextStart = Math.min(nextStart, s);
  }
  return nextStart === Infinity ? Infinity : Math.round((nextStart - nowMs) / 60000);
}

async function findAvailable(auth, rooms) {
  if (!rooms.length) return [];
  const calendar = google.calendar({ version: "v3", auth });
  const now = new Date();
  const end = new Date(now.getTime() + LOOKAHEAD_MIN * 60000);

  const results = [];
  for (let i = 0; i < rooms.length; i += FREEBUSY_BATCH) {
    const chunk = rooms.slice(i, i + FREEBUSY_BATCH);
    const res = await calendar.freebusy.query({
      requestBody: {
        timeMin: now.toISOString(),
        timeMax: end.toISOString(),
        items: chunk.map((r) => ({ id: r.email })),
      },
    });
    const cals = res.data.calendars || {};
    for (const r of chunk) {
      const info = cals[r.email];
      if (!info || info.errors) continue; // unreadable -> treat as unavailable
      const freeMin = freeMinutesFrom(now.getTime(), info.busy || []);
      // Only show rooms with enough runway before their next booking.
      if (freeMin >= MIN_FREE_MINUTES) results.push({ ...r, freeMin });
    }
  }

  // Right-size first (smaller rooms first); tiebreak by most free time.
  return results.sort(
    (a, b) => (a.capacity || 0) - (b.capacity || 0) || b.freeMin - a.freeMin
  );
}

// ---------------------------------------------------------------------------
// Slack Block Kit formatting
// ---------------------------------------------------------------------------
function fmtFree(freeMin) {
  if (freeMin >= LOOKAHEAD_MIN) return `free ${Math.floor(LOOKAHEAD_MIN / 60)}h+`;
  if (freeMin >= 60) {
    const h = Math.floor(freeMin / 60);
    const m = freeMin % 60;
    return m ? `free ~${h}h${m}m` : `free ~${h}h`;
  }
  return `free ~${freeMin} min`;
}

function buildBlocks(officeLabel, freeRooms) {
  if (!freeRooms.length) {
    return [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:no_entry: No rooms free for at least ${MIN_FREE_MINUTES} min in *${officeLabel}*.`,
        },
      },
    ];
  }
  const lines = freeRooms
    .map((r) => {
      const bits = [fmtFree(r.freeMin)];
      if (r.floor) bits.push(`floor ${r.floor}`);
      if (r.capacity) bits.push(`${r.capacity} seats`);
      return `:white_check_mark: *${r.name}*  _(${bits.join(", ")})_`;
    })
    .join("\n");
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Rooms free now in ${officeLabel}* (≥${MIN_FREE_MINUTES} min runway):\n${lines}`,
      },
    },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `Checked ${new Date().toLocaleTimeString()}` },
      ],
    },
  ];
}

async function postToSlack(responseUrl, blocks) {
  await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response_type: "ephemeral", blocks }),
  });
}

// ---------------------------------------------------------------------------
// Slack request signature verification
// ---------------------------------------------------------------------------
function verifySlack(req) {
  const ts = req.headers["x-slack-request-timestamp"];
  const sig = req.headers["x-slack-signature"];
  if (!ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // replay guard
  const base = `v0:${ts}:${req.rawBody}`;
  const expected =
    "v0=" +
    crypto.createHmac("sha256", SLACK_SIGNING_SECRET).update(base).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const app = express();
app.use(
  express.urlencoded({
    extended: true,
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);

app.post("/slack/rooms", async (req, res) => {
  if (!verifySlack(req)) return res.status(401).send("bad signature");

  const text = (req.body.text || "").trim().toLowerCase();
  const responseUrl = req.body.response_url;
  const office = OFFICES[text];

  // No/unknown office -> ACK immediately with a helpful prompt.
  if (!office) {
    const options = Object.keys(OFFICES).join(", ");
    return res.json({
      response_type: "ephemeral",
      text: `Which office? Try \`/rooms <office>\`. Options: ${options}`,
    });
  }

  // ACK within 3s, then do the slow work and post via response_url.
  res.json({ response_type: "ephemeral", text: `:mag: Checking rooms in ${office.label}…` });

  (async () => {
    try {
      const auth = getAuth();
      await auth.authorize();
      const all = await listRooms(auth);
      const inOffice = all.filter((r) => r.buildingId === office.buildingId);
      const free = await findAvailable(auth, inOffice);
      await postToSlack(responseUrl, buildBlocks(office.label, free));
    } catch (err) {
      console.error(err);
      await postToSlack(responseUrl, [
        {
          type: "section",
          text: { type: "mrkdwn", text: ":warning: Couldn't check rooms right now. Try again shortly." },
        },
      ]);
    }
  })();
});

app.get("/health", (_req, res) => res.send("ok"));

app.listen(PORT, () => console.log(`rooms-bot listening on :${PORT}`));
