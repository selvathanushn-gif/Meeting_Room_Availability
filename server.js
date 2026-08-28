/**
 * /rooms — a Slack slash command that lists currently-available meeting rooms
 * for a given office and party size, using Google Calendar room resources.
 *
 * Flow:
 *   /rooms                  -> office dropdown -> size dropdown -> results
 *   /rooms <office>         -> size dropdown -> results
 *   /rooms <office> <size>  -> results directly
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

// Map the keyword a user types (`/rooms kanto`) to a Google buildingId.
// The keys are what users type; they also populate the office dropdown.
const OFFICES = {
  kanto: { buildingId: "Staging-Kanto", label: "Kanto" },
  bucharest: { buildingId: "Staging-Bucharest", label: "Bucharest" },
  seoul: { buildingId: "Staging-Seoul", label: "Seoul" },
};

// Party-size options offered in the dropdown (2..10 in twos).
const SIZES = [2, 4, 6, 8, 10];

// Rooms to hide from /rooms results, by resource email (exact match).
const EXCLUDED_ROOM_EMAILS = new Set([
  "c_188es4u2tu9ashnfg642hts7e18s0@resource.calendar.google.com",
  // "c_188...@resource.calendar.google.com",
]);

// Optional: also hide any room whose name matches one of these patterns.
const EXCLUDED_NAME_PATTERNS = [
  // /phone booth/i,
  // /^EXEC /i,
];

function isHidden(r) {
  if (EXCLUDED_ROOM_EMAILS.has(r.resourceEmail)) return true;
  const name = r.resourceName || r.generatedResourceName || "";
  return EXCLUDED_NAME_PATTERNS.some((re) => re.test(name));
}

// How far ahead we read each room's calendar (minutes).
const LOOKAHEAD_MIN = 120;

// A room must be free for at least this many minutes from now to be shown.
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
      if (r.resourceCategory !== "CONFERENCE_ROOM") continue; // skip desks, equipment
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
      if (freeMin >= MIN_FREE_MINUTES) results.push({ ...r, freeMin });
    }
  }
  return results;
}

// Order rooms by how well they fit `target` people:
//   1) rooms that seat >= target, closest fit first (least wasted seats)
//   2) rooms too small, largest first (nearest alternative)
//   3) rooms with unknown capacity, last
function rankByCapacity(rooms, target) {
  const rank = (cap) => {
    if (cap == null) return [2, 0];
    if (cap >= target) return [0, cap - target];
    return [1, target - cap];
  };
  return [...rooms].sort((a, b) => {
    const [ga, da] = rank(a.capacity);
    const [gb, db] = rank(b.capacity);
    return ga - gb || da - db || (a.capacity || 0) - (b.capacity || 0);
  });
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

function buildBlocks(officeLabel, freeRooms, targetSize = null) {
  const forWhom = targetSize ? ` for ~${targetSize} people` : "";
  if (!freeRooms.length) {
    return [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:no_entry: No rooms free for at least ${MIN_FREE_MINUTES} min in *${officeLabel}*${forWhom}.`,
        },
      },
    ];
  }
  const lines = freeRooms
    .map((r) => {
      const bits = [fmtFree(r.freeMin)];
      if (r.floor) bits.push(`floor ${r.floor}`);
      bits.push(r.capacity ? `${r.capacity} seats` : "capacity n/a");
      // Flag rooms that are smaller than the requested party size.
      const tooSmall = targetSize && r.capacity != null && r.capacity < targetSize;
      const marker = tooSmall ? ":warning:" : ":white_check_mark:";
      return `${marker} *${r.name}*  _(${bits.join(", ")})_`;
    })
    .join("\n");
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Rooms free now in ${officeLabel}${forWhom}* (≥${MIN_FREE_MINUTES} min runway):\n${lines}`,
      },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `Checked ${new Date().toLocaleTimeString()}` }],
    },
  ];
}

async function postToSlack(responseUrl, blocks, replaceOriginal = false) {
  await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      response_type: "ephemeral",
      replace_original: replaceOriginal,
      blocks,
    }),
  });
}

// Dropdown 1: pick an office. Shown when /rooms is run with no office.
function buildOfficePicker() {
  const options = Object.entries(OFFICES).map(([key, o]) => ({
    text: { type: "plain_text", text: o.label },
    value: key,
  }));
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: "Which office? Pick one to see what's free right now:" },
      accessory: {
        type: "static_select",
        action_id: "pick_office",
        placeholder: { type: "plain_text", text: "Choose an office" },
        options,
      },
    },
  ];
}

// Dropdown 2: pick a party size. The office is encoded in each option value
// ("kanto:6") so the next interaction knows both office and size.
function buildSizePicker(officeKey) {
  const label = OFFICES[officeKey] ? OFFICES[officeKey].label : officeKey;
  const options = SIZES.map((n) => ({
    text: { type: "plain_text", text: `${n} people` },
    value: `${officeKey}:${n}`,
  }));
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${label}* — how many people is the room for?` },
      accessory: {
        type: "static_select",
        action_id: "pick_size",
        placeholder: { type: "plain_text", text: "Party size" },
        options,
      },
    },
  ];
}

// Shared worker: find an office's free rooms, rank by fit, post back to Slack.
async function sendRoomsFor(officeKey, responseUrl, replaceOriginal = false, targetSize = null) {
  const office = OFFICES[officeKey];
  if (!office) return;
  try {
    const auth = getAuth();
    await auth.authorize();
    const all = await listRooms(auth);
    const inOffice = all.filter((r) => r.buildingId === office.buildingId);
    let free = await findAvailable(auth, inOffice);
    free = targetSize ? rankByCapacity(free, targetSize) : free.sort((a, b) => (a.capacity || 0) - (b.capacity || 0));
    await postToSlack(responseUrl, buildBlocks(office.label, free, targetSize), replaceOriginal);
  } catch (err) {
    console.error(err);
    await postToSlack(
      responseUrl,
      [
        {
          type: "section",
          text: { type: "mrkdwn", text: ":warning: Couldn't check rooms right now. Try again shortly." },
        },
      ],
      replaceOriginal
    );
  }
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

// Slash command: /rooms [office] [size]
app.post("/slack/rooms", async (req, res) => {
  if (!verifySlack(req)) return res.status(401).send("bad signature");

  const parts = (req.body.text || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const officeKey = parts[0];
  const sizeArg = parts[1] ? parseInt(parts[1], 10) : null;
  const responseUrl = req.body.response_url;
  const office = OFFICES[officeKey];

  // No/unknown office -> office dropdown.
  if (!office) {
    return res.json({ response_type: "ephemeral", blocks: buildOfficePicker() });
  }

  // Office but no valid size -> size dropdown.
  if (!SIZES.includes(sizeArg)) {
    return res.json({ response_type: "ephemeral", blocks: buildSizePicker(officeKey) });
  }

  // Office + size -> results.
  res.json({
    response_type: "ephemeral",
    text: `:mag: Checking rooms in ${office.label} for ~${sizeArg} people…`,
  });
  sendRoomsFor(officeKey, responseUrl, false, sizeArg);
});

// Handles both dropdown selections (Slack Interactivity).
app.post("/slack/interactivity", async (req, res) => {
  if (!verifySlack(req)) return res.status(401).send("bad signature");

  let payload;
  try {
    payload = JSON.parse(req.body.payload);
  } catch {
    return res.status(400).send("bad payload");
  }

  // Ack immediately so Slack doesn't time out.
  res.status(200).send("");

  const action = (payload.actions || [])[0];
  const responseUrl = payload.response_url;
  if (!action || !action.selected_option) return;

  try {
    // Office chosen -> replace office menu with the size menu.
    if (action.action_id === "pick_office") {
      const officeKey = action.selected_option.value;
      await postToSlack(responseUrl, buildSizePicker(officeKey), true);
      return;
    }

    // Size chosen -> value is "officeKey:size". Show results.
    if (action.action_id === "pick_size") {
      const [officeKey, sizeStr] = action.selected_option.value.split(":");
      const size = parseInt(sizeStr, 10);
      const office = OFFICES[officeKey];
      await postToSlack(
        responseUrl,
        [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `:mag: Checking rooms in ${office ? office.label : officeKey} for ~${size} people…`,
            },
          },
        ],
        true
      );
      await sendRoomsFor(officeKey, responseUrl, true, size);
      return;
    }
  } catch (err) {
    console.error(err);
    await postToSlack(
      responseUrl,
      [{ type: "section", text: { type: "mrkdwn", text: ":warning: Something went wrong. Try again." } }],
      true
    );
  }
});

app.get("/health", (_req, res) => res.send("ok"));

// ---------------------------------------------------------------------------
// Keep-alive: on Render's free tier the service spins down after ~15 min idle.
// Pinging our own /health endpoint keeps the instance awake while it's running.
// ---------------------------------------------------------------------------
function startKeepAlive() {
  const base = process.env.SELF_URL || process.env.RENDER_EXTERNAL_URL;
  if (!base) return;
  const url = `${base.replace(/\/$/, "")}/health`;
  const EVERY_MS = 10 * 60 * 1000; // 10 min, safely under the 15-min idle window
  const timer = setInterval(async () => {
    try {
      await fetch(url);
    } catch (err) {
      console.error("keep-alive ping failed:", err.message);
    }
  }, EVERY_MS);
  timer.unref();
  console.log(`keep-alive pinging ${url} every ${EVERY_MS / 60000} min`);
}

app.listen(PORT, () => {
  console.log(`rooms-bot listening on :${PORT}`);
  startKeepAlive();
});
