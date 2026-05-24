// =====================
// GLOBAL CRASH HANDLERS
// =====================
process.on("uncaughtException", (err) => {
  console.error("[UncaughtException]", err.message, err.stack);
});

process.on("unhandledRejection", (err) => {
  if (err?.status === 503 || err?.status === 502) {
    console.warn("[Discord] Temporary API outage (503/502), ignoring");
    return;
  }
  console.error("[UnhandledRejection]", err?.message ?? err);
});

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  MessageFlags,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");

const fs = require("fs");

const TOKEN          = process.env.BOT_TOKEN;
const CHANNEL_ID     = "1507303203182481448";
const LOG_CHANNEL_ID = "1507303243812704406";

if (!TOKEN) {
  console.error("ERROR: Missing BOT_TOKEN environment variable.");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

// =====================
// SETTINGS
// =====================
const TICK_RATE                    = 15000;
const MAX_UNDO                     = 10;
const EVERYONE_WARNING_LIFESPAN_MS = 10 * 60 * 1000;
const WINDOW_GRACE_MS              = 15 * 60 * 1000;
const REPIN_INTERVAL_MS            = 30 * 60 * 1000;
const REPIN_AFTER_ACTIONS          = 10;

// =====================
// STATE
// =====================
let data = { kills: {} };
let dashboardMessage = null;

let spawnWarnings       = {};
let spawnWindowMessages = {};
let everyoneWarnings    = {};

let adminLogs = [];
let undoStack = [];

let backupMessage = null;
let logMessage    = null;

let repinInProgress  = false;
let lastBackupRepost = 0;
let lastRepinTime    = 0;
let actionsSinceRepin = 0;

const BACKUP_REPOST_COOLDOWN_MS = 60 * 1000;
const BOT_START_TIME            = Date.now();
const STARTUP_GRACE_MS          = 30 * 1000;

// =====================
// BOSSES
// =====================
const BOSS_RESPAWN_MS = 7 * 60 * 60 * 1000;
const BOSS_WINDOW_MS  = 1 * 60 * 60 * 1000;

function buildBosses() {
  const bosses = [];
  for (let i = 1; i <= 3; i++) bosses.push({ id: `lorencia_${i}`, name: `Kharzul #${i}`,         key: "kharzul",  label: "Kharzul"  });
  for (let i = 1; i <= 3; i++) bosses.push({ id: `davias_${i}`,   name: `Vescrya #${i}`,          key: "vescrya",  label: "Vescrya"  });
  for (let i = 1; i <= 2; i++) bosses.push({ id: `crywolf_${i}`,  name: `Muggron #${i} Crywolf`,  key: "muggron",  label: "Muggron"  });
  for (let i = 1; i <= 2; i++) bosses.push({ id: `barracks_${i}`, name: `Muggron #${i} Barracks`, key: "muggron",  label: "Muggron"  });
  return bosses;
}
const BOSSES = buildBosses();

function getBossInstances(key) {
  return BOSSES.filter(b => b.key === key);
}

function pickNextAvailableSlot(key) {
  const instances = getBossInstances(key);
  const now = Date.now();
  const empty = instances.find(b => !data.kills[b.id]);
  if (empty) return empty;
  const stale = instances.find(b => {
    const e = data.kills[b.id];
    if (!e) return false;
    return now > e.respawnTime + BOSS_WINDOW_MS;
  });
  if (stale) return stale;
  return null;
}

// =====================
// FIXED EVENTS
// =====================
const FIXED_EVENTS = [
  { name: "🟡 Golden Invasion",   times: ["00:31","04:31","08:31","12:31","16:31","20:31"], warnMinutes: 5 },
  { name: "🧙 White Wizard",      times: ["09:45","12:45","15:45","18:45"],                 warnMinutes: 5,  noEveryone: true },
  { name: "💀 Death King",        times: ["21:45","00:45","03:45","06:45"],                 warnMinutes: 5,  noEveryone: true },
  { name: "⚡ Zaikan",            times: ["00:55","06:55","12:55","18:55"],                 warnMinutes: 5,  noEveryone: true },
  { name: "🐉 Red Dragon",        times: ["08:00","20:00"],                                 warnMinutes: 5  },
  { name: "🎅 Cursed Santa",      times: ["02:35","08:35","14:35","20:35"],                 warnMinutes: 5,  noEveryone: true },
  { name: "🏰 Chaos Castle",      times: ["13:55","17:55","21:55","01:55","05:55","09:55"], warnMinutes: 5  },
  {
    name: "⚔️ Battle Royale",
    times: ["02:00","08:00","14:00","20:00","23:00"],
    warnMinutes: 10,
    extraNote: "⚠️ Registration opens **5 minutes before** the event starts — be ready!",
  },
  { name: "🐇 Lunar Rabbit",      times: ["05:25","11:25","17:25","23:25"], warnMinutes: 5, noEveryone: true },
  { name: "🔥 Fire Flame Ghost",  times: ["01:25","07:25","13:25","19:25"], warnMinutes: 5, noEveryone: true },
  { name: "🎁 Pouch of Blessing", times: ["03:25","09:25","15:25","21:25"], warnMinutes: 5, noEveryone: true },
  {
    name: "👹 Abaddon",
    times: ["03:50","17:50"],
    warnMinutes: 10,
    extraNote: "📍 Location: **Twisted Karutan** | 🎁 Drop: Armor Sets, Weapons",
  },
  {
    name: "💀 Lord Kundun",
    times: ["01:50","15:50"],
    warnMinutes: 10,
    extraNote: "📍 Location: **Shadow Abyss** | 🎁 Drop: Weapons",
  },
  {
    name: "🔥 Infernal Overlord",
    times: ["04:50","20:50"],
    warnMinutes: 10,
    extraNote: "📍 Location: **Kanturu Labyrinth** | 🎁 Drop: Armor Sets",
  },
  {
    name: "🪽 Aurindra",
    times: ["23:50"],
    warnMinutes: 10,
    extraNote: "📍 Location: **Crimson Icarus** | 🎁 Drop: Wing 2, Phoenix Feather, Wing 2.5",
  },
  {
    name: "❄️ Frigidons",
    times: ["00:00","03:00","06:00","09:00","12:00","15:00","18:00","21:00"],
    warnMinutes: 10,
    extraNote: "⚠️ Spawns **10 minutes** — start organising!",
  },
];

const eventPingedKeys = new Set();

// =====================
// TIMEZONE HELPER
// =====================
const SERVER_TZ = "Europe/Amsterdam";

function getAmsterdamOffsetMs(date) {
  const utcStr = date.toLocaleString("en-US", { timeZone: "UTC" });
  const tzStr  = date.toLocaleString("en-US", { timeZone: SERVER_TZ });
  return new Date(tzStr) - new Date(utcStr);
}

function parseServerTime(h, m) {
  const now       = new Date();
  const dateStr   = now.toLocaleDateString("en-CA", { timeZone: SERVER_TZ });
  const candidate = new Date(`${dateStr}T${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:00`);
  const tzOffset  = getAmsterdamOffsetMs(candidate);
  const utcMs     = candidate.getTime() - tzOffset;
  const kill      = new Date(utcMs);
  if (kill > now) kill.setDate(kill.getDate() - 1);
  return kill;
}

function toServerTimeStr(ms) {
  return new Date(ms).toLocaleTimeString("en-GB", {
    hour: "2-digit", minute: "2-digit",
    timeZone: SERVER_TZ, hour12: false
  });
}

function toServerDateTimeStr(ms) {
  return new Date(ms).toLocaleString("en-GB", {
    timeZone: SERVER_TZ, hour12: false,
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    day: "2-digit", month: "2-digit", year: "numeric"
  });
}

function nextOccurrenceMs(hhmm, afterMs) {
  const [h, m]  = hhmm.split(":").map(Number);
  const afterDt = new Date(afterMs);
  for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
    const base      = new Date(afterDt);
    base.setDate(base.getDate() + dayOffset);
    const dateStr   = base.toLocaleDateString("en-CA", { timeZone: SERVER_TZ });
    const candidate = new Date(`${dateStr}T${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:00`);
    const tzOffset  = getAmsterdamOffsetMs(candidate);
    const utcMs     = candidate.getTime() - tzOffset;
    if (utcMs >= afterMs) return utcMs;
  }
  const afterDt2   = new Date(afterMs);
  afterDt2.setDate(afterDt2.getDate() + 1);
  const dateStr2   = afterDt2.toLocaleDateString("en-CA", { timeZone: SERVER_TZ });
  const candidate2 = new Date(`${dateStr2}T${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:00`);
  const tzOffset2  = getAmsterdamOffsetMs(candidate2);
  return candidate2.getTime() - tzOffset2;
}

// =====================
// SAVE / LOAD
// =====================
function load() {
  if (fs.existsSync("data.json")) {
    data = JSON.parse(fs.readFileSync("data.json", "utf8"));
  }
  if (!data.kills) data.kills = {};
}

function save() {
  fs.writeFileSync("data.json.tmp", JSON.stringify(data, null, 2));
  fs.renameSync("data.json.tmp", "data.json");
}

// =====================
// RESTORE WARNING FLAGS ON STARTUP
// =====================
function restoreSpawnWarningFlags() {
  const now = Date.now();
  let freedCount = 0;

  for (const b of BOSSES) {
    const e = data.kills[b.id];
    if (!e) {
      spawnWarnings[b.id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
      continue;
    }

    const cooldown      = e.respawnTime - now;
    const windowEnd     = e.respawnTime + BOSS_WINDOW_MS;
    const windowExpired = now > windowEnd;

    if (windowExpired) {
      console.log(`[Startup] ${b.name} — window already expired. Freeing slot.`);
      logBot(`STARTUP FREED ${b.name} — window expired — last kill: ${toServerDateTimeStr(e.killTime)}`);
      delete data.kills[b.id];
      spawnWarnings[b.id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
      freedCount++;
      continue;
    }

    spawnWarnings[b.id] = {
      warned5:       cooldown <= 5 * 60 * 1000,
      warned20:      cooldown <= 0 && (windowEnd - now) <= 20 * 60 * 1000,
      windowCreated: cooldown <= 0,
      missedHandled: false,
    };
  }

  if (freedCount > 0) save();
  console.log(`[Startup] Spawn warning flags restored. ${freedCount} expired slot(s) freed.`);
}

// =====================
// REDEPLOY RECOVERY
// =====================
async function recoverFromDiscordBackup() {
  const now = Date.now();
  const localEmpty =
    !fs.existsSync("data.json") ||
    (() => {
      try {
        const d = JSON.parse(fs.readFileSync("data.json", "utf8"));
        return !d.kills || Object.values(d.kills).every(e => e.respawnTime < now - 2 * 60 * 60 * 1000);
      } catch { return true; }
    })();

  if (!localEmpty) {
    console.log("[Recovery] Local data.json exists and has timers — skipping Discord recovery.");
    return false;
  }

  console.log("[Recovery] Scanning Discord for latest backup...");
  try {
    const backupCh   = await client.channels.fetch(LOG_CHANNEL_ID);
    const fetched    = await backupCh.messages.fetch({ limit: 100 });
    const candidates = [...fetched.values()].filter(m =>
      m.author.id === client.user.id &&
      m.attachments.size > 0 &&
      [...m.attachments.values()].some(a => a.name && a.name.startsWith("backup-") && a.name.endsWith(".json"))
    );

    if (!candidates.length) { console.warn("[Recovery] No backup messages found."); return false; }

    const best       = candidates.sort((a, b) =>
      (b.editedTimestamp ?? b.createdTimestamp) - (a.editedTimestamp ?? a.createdTimestamp)
    )[0];
    const attachment = [...best.attachments.values()].find(a => a.name.startsWith("backup-") && a.name.endsWith(".json"));

    const response = await fetch(attachment.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await response.json();
    if (!json.kills) throw new Error("Backup JSON has no 'kills' field");

    const filtered = {};
    for (const [id, entry] of Object.entries(json.kills)) {
      if (entry.respawnTime >= now - 8 * 60 * 60 * 1000) filtered[id] = entry;
    }

    data = { kills: filtered };
    save();
    console.log(`[Recovery] Restored ${Object.keys(filtered).length} active timer(s).`);
    return true;
  } catch (err) {
    console.error("[Recovery] Failed:", err);
    return false;
  }
}

// =====================
// BACKUP — local files
// =====================
const BACKUP_INTERVAL_MS = 60 * 60 * 1000;
const MAX_LOCAL_BACKUPS  = 48;

function saveLocalBackup() {
  if (!fs.existsSync("backups")) fs.mkdirSync("backups");
  const stamp    = new Date().toISOString().replace(/:/g, "-").replace("T", "_").slice(0, 16);
  const filename = `backups/data.backup-${stamp}.json`;
  fs.writeFileSync(filename, JSON.stringify(data, null, 2));
  const files = fs.readdirSync("backups")
    .filter(f => f.startsWith("data.backup-") && f.endsWith(".json")).sort();
  if (files.length > MAX_LOCAL_BACKUPS)
    files.slice(0, files.length - MAX_LOCAL_BACKUPS).forEach(f => fs.unlinkSync(`backups/${f}`));
  return filename;
}

// =====================
// BACKUP — Discord
// =====================
function buildBackupEmbed(takenAt) {
  const stamp = toServerDateTimeStr(takenAt || Date.now());
  const lines = BOSSES.map(b => {
    const e = data.kills[b.id];
    if (!e) return `• **${b.name}**: —`;
    return `• **${b.name}**: by ${e.lastKiller} — kill: ${toServerDateTimeStr(e.killTime)} — respawn: ${toServerDateTimeStr(e.respawnTime)}`;
  });
  return new EmbedBuilder()
    .setTitle("💾 MU Timer Backup")
    .setColor(0x2b2d31)
    .setDescription(lines.join("\n"))
    .setFooter({ text: `Last updated: ${stamp} (server time)` });
}

function buildBackupFile() {
  const isoStamp = new Date().toISOString().replace(/:/g, "-").slice(0, 16);
  return { attachment: Buffer.from(JSON.stringify(data, null, 2), "utf8"), name: `backup-${isoStamp}.json` };
}

async function initBackupMessage(backupChannel) {
  try {
    const existing = await backupChannel.messages.fetch({ limit: 50 });
    const found = [...existing.values()].find(m =>
      m.author.id === client.user.id &&
      m.embeds.length > 0 &&
      m.embeds[0]?.title === "💾 MU Timer Backup"
    );
    if (found) { backupMessage = found; console.log("[Backup] Reusing existing backup message."); return; }
  } catch (err) {
    console.warn("[Backup] Could not scan for existing backup message:", err.message ?? err);
  }
  backupMessage = await backupChannel.send({
    embeds: [buildBackupEmbed(null)],
    files:  [buildBackupFile()],
    flags:  MessageFlags.SuppressNotifications
  });
  console.log("[Backup] Fresh backup message posted.");
}

async function updateDiscordBackup() {
  if (!backupMessage) return;
  try {
    await backupMessage.edit({ embeds: [buildBackupEmbed(Date.now())], files: [buildBackupFile()] });
    console.log("[Backup] Message updated.");
  } catch (err) {
    if (err.status === 503 || err.status === 502) {
      console.warn(`[Backup] Temporarily unavailable (${err.status}), retrying next cycle`);
    } else {
      console.error(`[Backup] Edit failed: ${err.status} ${err.message}`);
      backupMessage = null;
    }
  }
}

async function repostBackupToBottom() {
  try {
    const logCh = await client.channels.fetch(LOG_CHANNEL_ID);
    if (backupMessage) backupMessage.delete().catch(() => {});
    backupMessage = await logCh.send({
      embeds: [buildBackupEmbed(Date.now())],
      files:  [buildBackupFile()],
      flags:  MessageFlags.SuppressNotifications
    });
    console.log("[Backup] Reposted.");
  } catch (err) {
    console.error("[Backup] Repost failed:", err.message ?? err);
  }
}

async function runBackup() {
  try { console.log(`[Backup] ${saveLocalBackup()}`); await updateDiscordBackup(); }
  catch (err) { console.error("[Backup]", err.message ?? err); }
}

function startBackupLoop() {
  const now = new Date();
  const msUntilNextHour = BACKUP_INTERVAL_MS -
    (now.getMinutes() * 60000 + now.getSeconds() * 1000 + now.getMilliseconds());
  console.log(`[Backup] First hourly update in ${Math.round(msUntilNextHour / 60000)}m.`);
  setTimeout(() => { runBackup(); setInterval(runBackup, BACKUP_INTERVAL_MS); }, msUntilNextHour);
}

// =====================
// PERSISTENT LOG MESSAGE
// =====================
function buildLogEmbed() {
  const recent      = adminLogs.slice(0, 20);
  const description = recent.length
    ? recent.map(l => `\`${toServerDateTimeStr(l.time)}\` — **${l.user}** — ${l.action}`).join("\n")
    : "No actions logged yet.";
  return new EmbedBuilder()
    .setTitle("📜 Action Log (Last 20)")
    .setDescription(description)
    .setColor(0x5865f2)
    .setFooter({ text: "Auto-updates on every action" });
}

async function updateLogMessage() {
  if (!logMessage) return;
  try { await logMessage.edit({ embeds: [buildLogEmbed()] }); }
  catch (err) { console.error("[Log] Update failed:", err.message ?? err); }
}

// =====================
// FORMAT
// =====================
function format(ms) {
  if (ms <= 0) return "NOW";
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

function formatSeconds(ms) {
  if (ms <= 0) return "NOW";
  const totalSec = Math.floor(ms / 1000);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// =====================
// LOGGING
// =====================
function log(user, actionType) {
  adminLogs.unshift({ user: user.username, action: actionType, time: Date.now() });
  if (adminLogs.length > 200) adminLogs.pop();
  updateLogMessage();
}

function logBot(actionType) {
  adminLogs.unshift({ user: "🤖 BOT", action: actionType, time: Date.now() });
  if (adminLogs.length > 200) adminLogs.pop();
  updateLogMessage();
}

// =====================
// UNDO
// =====================
function snapshot() {
  undoStack.push(JSON.parse(JSON.stringify(data)));
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

function undo() {
  if (!undoStack.length) return false;
  data = undoStack.pop();
  save();
  return true;
}

function recalcSpawnWarningsAfterUndo() {
  const now = Date.now();
  for (const b of BOSSES) {
    const e = data.kills[b.id];
    if (!e) {
      spawnWarnings[b.id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
      continue;
    }
    const cooldown  = e.respawnTime - now;
    const windowEnd = e.respawnTime + BOSS_WINDOW_MS;
    spawnWarnings[b.id] = {
      warned5:       cooldown <= 5 * 60 * 1000,
      warned20:      cooldown <= 0 && (windowEnd - now) <= 20 * 60 * 1000,
      windowCreated: cooldown <= 0,
      missedHandled: now > windowEnd,
    };
  }
  console.log("[Undo] Spawn warning flags recalculated.");
}

// =====================
// ANNOUNCE HELPERS
// =====================
function stripPings(content) {
  return content.replace(/@everyone/g, "everyone").replace(/@here/g, "here");
}

async function forwardToLogChannel(content) {
  if (LOG_CHANNEL_ID === CHANNEL_ID) return;
  try {
    const logCh = await client.channels.fetch(LOG_CHANNEL_ID);
    await logCh.send({ content: stripPings(content), flags: MessageFlags.SuppressNotifications });
  } catch (err) { console.error("[Log Channel]", err.message ?? err); }
}

async function announceKill(channel, user, action, extra = "") {
  const content = `⚔️ **${user.username}** ${action} — ${toServerDateTimeStr(Date.now())} (server time)${extra ? `\n${extra}` : ""}`;
  const msg = await channel.send({ content, flags: MessageFlags.SuppressNotifications });
  setTimeout(() => { msg.delete().catch(() => {}); forwardToLogChannel(content); }, 5 * 60 * 1000);
}

async function announceAdmin(channel, user, action) {
  const content = `📢 **${user.username}** ${action} — ${toServerDateTimeStr(Date.now())} (server time)`;
  const msg     = await channel.send({ content, flags: MessageFlags.SuppressNotifications });
  setTimeout(() => { msg.delete().catch(() => {}); forwardToLogChannel(content); }, 5 * 60 * 1000);
}

// =====================
// @EVERYONE WARNINGS
// =====================
async function postEveryoneWarning(channel, key, content, lifespanMs = EVERYONE_WARNING_LIFESPAN_MS) {
  await clearEveryoneWarning(key);
  let msg;
  try { msg = await channel.send({ content }); }
  catch (err) { console.error("[Warning] Failed to post warning:", err.message ?? err); return; }
  const deleteTimer = setTimeout(() => {
    if (!everyoneWarnings[key]) return;
    everyoneWarnings[key].msg.delete().catch(() => {});
    forwardToLogChannel(stripPings(everyoneWarnings[key].content));
    delete everyoneWarnings[key];
  }, lifespanMs);
  everyoneWarnings[key] = { msg, content, deleteTimer };
}

async function clearEveryoneWarning(key) {
  const w = everyoneWarnings[key];
  if (!w) return;
  clearTimeout(w.deleteTimer);
  w.msg.delete().catch(() => {});
  delete everyoneWarnings[key];
}

// =====================
// SPAWN WINDOW EMBEDS & COMPONENTS
// =====================
function buildSpawnWindowEmbed(boss, windowStart, windowEnd) {
  const remaining = windowEnd - Date.now();
  const tsStart   = Math.floor(windowStart / 1000);
  const tsEnd     = Math.floor(windowEnd / 1000);
  const desc = remaining > 0
    ? `⏳ Time left: **${formatSeconds(remaining)}**\n🟢 Opened: ${toServerTimeStr(windowStart)} (server) — <t:${tsStart}:t> (your time)\n🔴 Closes: ${toServerTimeStr(windowEnd)} (server) — <t:${tsEnd}:t> (your time)`
    : `⌛ Window has closed — log the kill or wait for next respawn\n🟢 Opened: ${toServerTimeStr(windowStart)} (server) — <t:${tsStart}:t> (your time)\n🔴 Closed: ${toServerTimeStr(windowEnd)} (server) — <t:${tsEnd}:t> (your time)`;
  return new EmbedBuilder()
    .setTitle(`🟢 ${boss.name} — Spawn window active`)
    .setColor(0x00cc66)
    .setDescription(desc);
}

function buildSpawnWindowComponents(id) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("window_kill_"    + id).setLabel("💀 Killed").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("window_settime_" + id).setLabel("⏱️ Set Time").setStyle(ButtonStyle.Secondary)
  )];
}

// =====================
// DASHBOARD EMBED (ephemeral, full view)
// =====================
function buildDashboardEmbed() {
  const now   = Date.now();
  const embed = new EmbedBuilder()
    .setTitle("🔥 LIVE MU TRACKER — Full View")
    .setColor(0xffaa00)
    .setFooter({ text: `Full view — all boss slots` });

  const keys = [...new Set(BOSSES.map(b => b.key))];

  for (const key of keys) {
    const instances = getBossInstances(key);
    const label     = instances[0].label;
    const lines     = instances.map(b => {
      const e = data.kills[b.id];
      if (!e) return `**${b.name}**: 🟢 READY`;
      const cooldown   = e.respawnTime - now;
      const windowEnd  = e.respawnTime + BOSS_WINDOW_MS;
      const windowLeft = windowEnd - now;
      const tsRespawn  = Math.floor(e.respawnTime / 1000);
      if (cooldown > 0)     return `**${b.name}**: ⏳ ${format(cooldown)} → <t:${tsRespawn}:t> *(${e.lastKiller})*`;
      if (windowLeft > 0)   return `**${b.name}**: 🟢 WINDOW ${formatSeconds(windowLeft)} *(${e.lastKiller})*`;
      return `**${b.name}**: ⚠️ expired *(${e.lastKiller})*`;
    });
    embed.addFields({ name: `• ${label}`, value: lines.join("\n") });
  }

  return embed;
}

// =====================
// RESPAWN SCHEDULE EMBED
// =====================
function buildRespawnEmbed() {
  const now     = Date.now();
  const entries = [];

  for (const b of BOSSES) {
    const e = data.kills[b.id];
    if (!e) continue;

    const cooldown   = e.respawnTime - now;
    const windowEnd  = e.respawnTime + BOSS_WINDOW_MS;
    const windowLeft = windowEnd - now;
    const tsRespawn  = Math.floor(e.respawnTime / 1000);

    if (cooldown < -10 * 60 * 1000 && windowLeft <= 0) continue;

    let statusLine, sortTime;

    if (cooldown > 0) {
      statusLine = `⏳ Spawns <t:${tsRespawn}:R> — <t:${tsRespawn}:t> (${toServerTimeStr(e.respawnTime)} server)`;
      sortTime   = e.respawnTime;
    } else if (windowLeft > 0) {
      const tsEnd = Math.floor(windowEnd / 1000);
      statusLine = `🟢 **WINDOW OPEN** — closes in **${formatSeconds(windowLeft)}** (<t:${tsEnd}:t>)`;
      sortTime   = windowEnd;
    } else {
      continue;
    }

    entries.push({
      sortTime,
      line: `**${b.name}** *(${e.lastKiller})*\n  ${statusLine}`
    });
  }

  entries.sort((a, b) => b.sortTime - a.sortTime);

  const description = entries.length
    ? entries.map(e => e.line).join("\n\n")
    : "✅ No active timers — all bosses ready!";

  return new EmbedBuilder()
    .setTitle("📅 Respawn Schedule — Longest wait at top")
    .setColor(0xffaa00)
    .setDescription(description)
    .setFooter({ text: `${entries.length} active timer(s) • ${toServerTimeStr(now)} server time` });
}

// =====================
// BUTTONS
// =====================
function buildButtons() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("boss_kill_kharzul").setLabel("Kharzul").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("boss_kill_vescrya").setLabel("Vescrya").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("boss_kill_muggron").setLabel("Muggron").setStyle(ButtonStyle.Primary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("insert_time").setLabel("📝 Insert").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("reset_boss").setLabel("🧹 Reset").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("undo").setLabel("↩️ Undo").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("show_respawn").setLabel("📅 Respawn").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("show_dashboard").setLabel("📊 Dashboard").setStyle(ButtonStyle.Secondary)
  );

  return [row1, row2];
}

// =====================
// REPIN DASHBOARD
// =====================
async function repinDashboard(channel) {
  if (repinInProgress) { console.log("[Repin] Already in progress, skipping."); return; }
  repinInProgress = true;
  try {
    const now = Date.now();

    const newDashboard = await channel.send({
      content: "**🔥 MU — Boss Tracker**",
      components: buildButtons(),
      flags: MessageFlags.SuppressNotifications
    }).catch(err => { console.error("[Repin] Failed to post dashboard:", err.message ?? err); return null; });

    if (!newDashboard) return;

    // Delete old dashboard AFTER new one is posted to avoid gap
    if (dashboardMessage) {
      await dashboardMessage.delete().catch(() => {});
    }
    dashboardMessage = newDashboard;

    // Re-post any active spawn window cards
    for (const id of Object.keys(spawnWindowMessages)) {
      const w = spawnWindowMessages[id];
      if (w.msg) w.msg.delete().catch(() => {});
      if (w.windowEnd + WINDOW_GRACE_MS > now) {
        const boss = BOSSES.find(b => b.id === id);
        w.msg = await channel.send({
          embeds:     [buildSpawnWindowEmbed(boss, w.windowStart, w.windowEnd)],
          components: buildSpawnWindowComponents(id),
          flags:      MessageFlags.SuppressNotifications
        }).catch(() => null);
      } else {
        delete spawnWindowMessages[id];
      }
    }

    lastRepinTime     = now;
    actionsSinceRepin = 0;
    console.log("[Repin] Dashboard stack refreshed.");
  } finally { repinInProgress = false; }
}

// =====================
// MAYBE REPIN AFTER ACTION
// Only repins on the 30-min timer — never on individual actions.
// This prevents duplicate dashboards from appearing after kills.
// =====================
async function maybeRepinAfterAction(channel) {
  actionsSinceRepin++;
  if (repinInProgress) return;

  const now = Date.now();
  const timerElapsed = now - lastRepinTime >= REPIN_INTERVAL_MS;
  if (!timerElapsed) return; // let the periodic loop handle repositioning

  console.log(`[Repin] 30-min timer elapsed — repinning (actions=${actionsSinceRepin})`);
  await repinDashboard(channel);
}

// =====================
// SPAWN WINDOW CREATION
// =====================
async function createSpawnWindow(boss, id, channel, windowEnd) {
  if (spawnWindowMessages[id]) return;
  const windowStart = windowEnd - BOSS_WINDOW_MS;
  const msg = await channel.send({
    embeds:     [buildSpawnWindowEmbed(boss, windowStart, windowEnd)],
    components: buildSpawnWindowComponents(id),
    flags:      MessageFlags.SuppressNotifications
  }).catch(err => { console.error(`[SpawnWindow] Failed for ${id}:`, err.message ?? err); return null; });

  if (!msg) return;
  const deleteAfter = (windowEnd - Date.now()) + WINDOW_GRACE_MS;
  const deleteTimer = setTimeout(() => { msg.delete().catch(() => {}); delete spawnWindowMessages[id]; }, Math.max(deleteAfter, 0));
  spawnWindowMessages[id] = { msg, windowStart, windowEnd, boss, deleteTimer };
}

// =====================
// MISSED WINDOW
// =====================
async function handleMissedWindow(boss, id) {
  const e = data.kills[id];
  if (!e) return;
  const lastKill    = toServerDateTimeStr(e.killTime);
  const nextRespawn = toServerDateTimeStr(e.respawnTime);
  console.log(`[MissedWindow] ${boss.name} — window missed. Freeing slot.`);
  logBot(`MISSED WINDOW ${boss.name} — last kill: ${lastKill} — respawn was: ${nextRespawn} — slot freed`);
  clearBossCards(id);
  delete data.kills[id];
  save();
  spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
}

// =====================
// MAIN LOOP
// =====================
function startLoop() {
  setInterval(async () => {
    try {
      const channel = dashboardMessage
        ? dashboardMessage.channel
        : await client.channels.fetch(CHANNEL_ID).catch(() => null);
      if (!channel) return;

      const now = Date.now();

      if (now - lastRepinTime >= REPIN_INTERVAL_MS) {
        console.log("[Loop] Periodic repin triggered.");
        if (!repinInProgress) await repinDashboard(channel);
        checkWarnings(channel);
        await checkFixedEvents(channel);
        return;
      }

      if (!dashboardMessage) {
        if (!repinInProgress) repinDashboard(channel);
        checkWarnings(channel);
        await checkFixedEvents(channel);
        return;
      }

      // Dashboard is buttons-only — just refresh components
      try {
        await dashboardMessage.edit({ components: buildButtons() });
      } catch (err) {
        if (err.code === 10008) {
          console.warn("[Loop] Dashboard deleted — repinning.");
          dashboardMessage = null;
          if (!repinInProgress) repinDashboard(channel);
        } else if (err.status !== 503 && err.status !== 502) {
          console.error("[Loop] Dashboard edit failed:", err.code, err.message);
          if (err.code !== 50013) dashboardMessage = null;
        }
        checkWarnings(channel);
        await checkFixedEvents(channel);
        return;
      }

      // Update spawn window cards
      for (const [id, w] of Object.entries(spawnWindowMessages)) {
        if (!w.msg) continue;
        try {
          await w.msg.edit({
            embeds:     [buildSpawnWindowEmbed(w.boss, w.windowStart, w.windowEnd)],
            components: buildSpawnWindowComponents(id)
          });
        } catch (err) { if (err.code === 10008) delete spawnWindowMessages[id]; }
      }

      checkWarnings(channel);
      await checkFixedEvents(channel);

    } catch (err) { console.error("[Loop] Tick error:", err.message ?? err); }
  }, TICK_RATE);
}

// =====================
// WARNING SYSTEM
// =====================
function checkWarnings(channel) {
  const now = Date.now();
  if (now - BOT_START_TIME < STARTUP_GRACE_MS) return;

  for (const b of BOSSES) {
    const e = data.kills[b.id];
    if (!e) continue;

    const cooldown               = e.respawnTime - now;
    const windowEnd              = e.respawnTime + BOSS_WINDOW_MS;
    const windowLeft             = windowEnd - now;
    const timeSinceWindowExpired = now - windowEnd;

    if (!spawnWarnings[b.id])
      spawnWarnings[b.id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };

    const w = spawnWarnings[b.id];

    // 5-min warning
    if (cooldown > 0 && cooldown <= 5 * 60 * 1000 && !w.warned5) {
      w.warned5 = true;
      postEveryoneWarning(channel, `${b.id}_5min`,
        `@everyone ⏳ **${b.name}** spawns in 5 minutes`, Math.max(cooldown, 0));
    }

    // Window opens
    if (cooldown <= 0 && windowLeft > 0 && !w.windowCreated) {
      w.windowCreated = true;
      clearEveryoneWarning(`${b.id}_5min`);
      createSpawnWindow(b, b.id, channel, windowEnd);
    }

    // 20-min window closing warning
    if (cooldown <= 0 && windowLeft > 0 && windowLeft <= 20 * 60 * 1000 && !w.warned20) {
      w.warned20 = true;
      postEveryoneWarning(channel, `${b.id}_20min`,
        `@everyone ⚠️ **${b.name}** spawn window closes in 20 minutes!`);
    }

    // Missed window — 10 min grace after window closes → free slot, log only
    if (timeSinceWindowExpired >= 10 * 60 * 1000 && !w.missedHandled) {
      w.missedHandled = true;
      handleMissedWindow(b, b.id);
    }
  }
}

// =====================
// FIXED EVENT WARNINGS
// =====================
async function checkFixedEvents(channel) {
  const now = Date.now();

  for (const ev of FIXED_EVENTS) {
    for (const hhmm of ev.times) {
      const eventMs   = nextOccurrenceMs(hhmm, now);
      const warnMs    = ev.warnMinutes * 60 * 1000;
      const timeUntil = eventMs - now;

      if (timeUntil > warnMs + (1 * 60 * 1000) || timeUntil < -TICK_RATE) continue;

      const eventDate = new Date(eventMs).toLocaleDateString("en-CA", { timeZone: SERVER_TZ });
      const key       = `${ev.name}|${hhmm}|${eventDate}`;
      if (eventPingedKeys.has(key)) continue;
      eventPingedKeys.add(key);

      const actualMins   = Math.max(1, Math.round(timeUntil / 60000));
      const eventTimeStr = toServerTimeStr(eventMs);
      const tsEvent      = Math.floor(eventMs / 1000);

      const prefix = ev.noEveryone ? "" : "@everyone ";
      let msgText =
        `${prefix}⏰ **${ev.name}** starts in **${actualMins} minute${actualMins !== 1 ? "s" : ""}**!\n` +
        `🕒 ${eventTimeStr} (server time) — <t:${tsEvent}:t> (your local time)`;
      if (ev.extraNote) msgText += `\n${ev.extraNote}`;

      channel.send({ content: msgText, flags: ev.noEveryone ? MessageFlags.SuppressNotifications : undefined })
        .then(sent => {
          setTimeout(() => {
            sent.delete().catch(() => {});
            forwardToLogChannel(stripPings(msgText));
          }, 5 * 60 * 1000);
        }).catch(() => {});

      if (eventPingedKeys.size > 500) {
        const yesterday = new Date(now - 25 * 60 * 60 * 1000).toLocaleDateString("en-CA", { timeZone: SERVER_TZ });
        for (const k of eventPingedKeys) { if (k.endsWith(`|${yesterday}`)) eventPingedKeys.delete(k); }
      }
    }
  }
}

// =====================
// DAILY REMINDER — 22:22 server time
// =====================
function scheduleDailyReminder() {
  function msUntilNext2222() {
    const now    = Date.now();
    const nextMs = nextOccurrenceMs("22:22", now);
    return nextMs <= now ? nextOccurrenceMs("22:22", now + 61 * 1000) - now : nextMs - now;
  }

  async function fireDailyReminder() {
    try {
      const channel = dashboardMessage
        ? dashboardMessage.channel
        : await client.channels.fetch(CHANNEL_ID).catch(() => null);
      if (!channel) return;

      const content = `@everyone 🌙 Did you finish your dailies? Dungeons? Did you drink your milk? Now's the time to do so.`;
      const msg = await channel.send({ content }).catch(err => {
        console.error("[DailyReminder] Failed:", err.message ?? err); return null;
      });
      if (msg) {
        setTimeout(() => {
          msg.delete().catch(() => {});
          forwardToLogChannel(stripPings(content));
        }, 10 * 60 * 1000);
      }
    } catch (err) { console.error("[DailyReminder] Error:", err.message ?? err); }
    setTimeout(fireDailyReminder, msUntilNext2222());
  }

  const delay = msUntilNext2222();
  console.log(`[DailyReminder] First reminder in ${Math.round(delay / 60000)}m.`);
  setTimeout(fireDailyReminder, delay);
}

// =====================
// CLEANUP HELPER
// =====================
function clearBossCards(id) {
  if (spawnWindowMessages[id]) {
    clearTimeout(spawnWindowMessages[id].deleteTimer);
    if (spawnWindowMessages[id].msg) spawnWindowMessages[id].msg.delete().catch(() => {});
    delete spawnWindowMessages[id];
  }
  clearEveryoneWarning(`${id}_5min`);
  clearEveryoneWarning(`${id}_20min`);
}

// =====================
// KILL RECORD HELPER
// =====================
function recordKill(id, killTime, username) {
  const respawnTime = killTime + BOSS_RESPAWN_MS;
  data.kills[id]    = { killTime, respawnTime, lastKiller: username };
  save();
  spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
  clearBossCards(id);
  return respawnTime;
}

// =====================
// READY
// =====================
client.once(Events.ClientReady, async () => {
  console.log("Bot online");
  load();

  if (await recoverFromDiscordBackup()) console.log("[Recovery] Timers restored.");
  restoreSpawnWarningFlags();

  const channel = await client.channels.fetch(CHANNEL_ID);
  const logCh   = await client.channels.fetch(LOG_CHANNEL_ID);

  // Init persistent log message in log channel
  try {
    const existing = await logCh.messages.fetch({ limit: 50 });
    const found    = [...existing.values()].find(m =>
      m.author.id === client.user.id && m.embeds[0]?.title === "📜 Action Log (Last 20)"
    );
    if (found) { logMessage = found; console.log("[Log] Reusing existing log message."); }
    else {
      logMessage = await logCh.send({ embeds: [buildLogEmbed()], flags: MessageFlags.SuppressNotifications });
      console.log("[Log] Log message posted.");
    }
  } catch (err) { console.error("[Log] Could not init:", err.message ?? err); }

  try { await initBackupMessage(logCh); }
  catch (err) { console.error("[Backup] Could not init:", err.message ?? err); }

  dashboardMessage = await channel.send({
    content: "**🔥 MU — Boss Tracker**",
    components: buildButtons(),
    flags: MessageFlags.SuppressNotifications
  });

  lastRepinTime     = Date.now();
  actionsSinceRepin = 0;

  startLoop();
  startBackupLoop();
  scheduleDailyReminder();
  setTimeout(() => runBackup().catch(err => console.error("[Backup] Startup failed:", err.message ?? err)), 5000);
});

// =====================
// INTERACTIONS
// =====================
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;

  if (Date.now() - lastBackupRepost > BACKUP_REPOST_COOLDOWN_MS) {
    lastBackupRepost = Date.now();
    repostBackupToBottom();
  }

  // ── RESPAWN SCHEDULE ──
  if (interaction.isButton() && interaction.customId === "show_respawn") {
    return interaction.reply({ embeds: [buildRespawnEmbed()], flags: MessageFlags.Ephemeral });
  }

  // ── DASHBOARD — ephemeral full view ──
  if (interaction.isButton() && interaction.customId === "show_dashboard") {
    return interaction.reply({ embeds: [buildDashboardEmbed()], flags: MessageFlags.Ephemeral });
  }

  // ── BOSS KILL BUTTON ──
  if (interaction.isButton() && interaction.customId.startsWith("boss_kill_")) {
    const key  = interaction.customId.replace("boss_kill_", "");
    const boss = pickNextAvailableSlot(key);

    if (boss) {
      snapshot();
      const now         = Date.now();
      const respawnTime = recordKill(boss.id, now, interaction.user.username);
      log(interaction.user, `KILL ${boss.name} — kill: ${toServerDateTimeStr(now)} — respawn: ${toServerDateTimeStr(respawnTime)}`);
      await announceKill(interaction.channel, interaction.user, `killed **${boss.name}**`,
        `🕒 Kill: ${toServerDateTimeStr(now)} — 🔄 Respawn: ${toServerDateTimeStr(respawnTime)}`);
      await maybeRepinAfterAction(interaction.channel);
      return interaction.deferUpdate();
    }

    // All slots occupied — show picker
    const instances = getBossInstances(key);
    const now       = Date.now();
    log(interaction.user, `All ${key} slots occupied — showing picker`);
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`boss_slot_pick_${key}`)
      .setPlaceholder("All slots busy — pick which to overwrite")
      .addOptions(instances.map(b => {
        const e = data.kills[b.id];
        let status = "🟢 READY";
        if (e) {
          const cd         = e.respawnTime - now;
          const windowLeft = e.respawnTime + BOSS_WINDOW_MS - now;
          if (cd > 0)          status = `⏳ ${format(cd)}`;
          else if (windowLeft > 0) status = `🟢 WINDOW ${format(windowLeft)}`;
          else                 status = `⚠️ expired`;
        }
        return { label: `${b.name} — ${status}`, value: b.id };
      }));
    return interaction.reply({
      content: `⚠️ All **${instances[0].label}** slots are active. Pick which one to overwrite:`,
      components: [new ActionRowBuilder().addComponents(menu)],
      flags: MessageFlags.Ephemeral
    });
  }

  // ── BOSS SLOT PICKER ──
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("boss_slot_pick_")) {
    snapshot();
    const id          = interaction.values[0];
    const boss        = BOSSES.find(b => b.id === id);
    const now         = Date.now();
    const respawnTime = recordKill(id, now, interaction.user.username);
    log(interaction.user, `KILL ${boss.name} (overwrite) — kill: ${toServerDateTimeStr(now)} — respawn: ${toServerDateTimeStr(respawnTime)}`);
    await announceKill(interaction.channel, interaction.user, `killed **${boss.name}**`,
      `🕒 Kill: ${toServerDateTimeStr(now)} — 🔄 Respawn: ${toServerDateTimeStr(respawnTime)}`);
    await maybeRepinAfterAction(interaction.channel);
    return interaction.deferUpdate();
  }

  // ── WINDOW KILL ──
  if (interaction.isButton() && interaction.customId.startsWith("window_kill_")) {
    snapshot();
    const id          = interaction.customId.replace("window_kill_", "");
    const boss        = BOSSES.find(b => b.id === id);
    const now         = Date.now();
    const respawnTime = recordKill(id, now, interaction.user.username);
    log(interaction.user, `WINDOW KILL ${boss.name} — kill: ${toServerDateTimeStr(now)} — respawn: ${toServerDateTimeStr(respawnTime)}`);
    await announceKill(interaction.channel, interaction.user, `killed **${boss.name}** (window kill)`,
      `🕒 Kill: ${toServerDateTimeStr(now)} — 🔄 Respawn: ${toServerDateTimeStr(respawnTime)}`);
    await maybeRepinAfterAction(interaction.channel);
    return interaction.deferUpdate();
  }

  // ── WINDOW SET TIME — show modal ──
  if (interaction.isButton() && interaction.customId.startsWith("window_settime_")) {
    const id   = interaction.customId.replace("window_settime_", "");
    const boss = BOSSES.find(b => b.id === id);
    log(interaction.user, `Opened set-time modal for ${boss.name} (window)`);
    const modal = new ModalBuilder()
      .setCustomId(`window_killtime_${id}`)
      .setTitle(`Set Kill Time — ${boss.name}`);
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("time")
        .setLabel("HH:MM (24h, server time)")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("e.g. 21:34 — leave blank for current time")
        .setRequired(false)
    ));
    return interaction.showModal(modal);
  }

  // ── WINDOW SET TIME — modal submit ──
  if (interaction.isModalSubmit() && interaction.customId.startsWith("window_killtime_")) {
    snapshot();
    const id   = interaction.customId.replace("window_killtime_", "");
    const boss = BOSSES.find(b => b.id === id);
    const raw  = interaction.fields.getTextInputValue("time").trim();
    const now  = Date.now();
    const killTime = raw === "" ? now : parseServerTime(...raw.split(":").map(Number)).getTime();
    const respawnTime = recordKill(id, killTime, interaction.user.username);
    log(interaction.user, `MANUAL SET (window) ${boss.name} — kill: ${toServerDateTimeStr(killTime)} — respawn: ${toServerDateTimeStr(respawnTime)}`);
    await announceKill(interaction.channel, interaction.user, `manually set **${boss.name}** kill time (from window)`,
      `🕒 Kill: ${toServerDateTimeStr(killTime)} — 🔄 Respawn: ${toServerDateTimeStr(respawnTime)}`);
    await maybeRepinAfterAction(interaction.channel);
    return interaction.deferUpdate();
  }

  // ── INSERT TIME — boss picker ──
  if (interaction.isButton() && interaction.customId === "insert_time") {
    log(interaction.user, `Opened insert: boss selection menu`);
    const menu = new StringSelectMenuBuilder()
      .setCustomId("select_boss_insert")
      .setPlaceholder("Select boss slot")
      .addOptions(BOSSES.map(b => {
        const e   = data.kills[b.id];
        const now = Date.now();
        let status = "🟢 READY";
        if (e) {
          const cd         = e.respawnTime - now;
          const windowLeft = e.respawnTime + BOSS_WINDOW_MS - now;
          if (cd > 0)          status = `⏳ ${format(cd)}`;
          else if (windowLeft > 0) status = `🟢 WIN ${format(windowLeft)}`;
          else                 status = `⚠️ expired`;
        }
        return { label: `${b.name} — ${status}`, value: b.id };
      }));
    return interaction.reply({
      content: "📝 **Insert Kill Time** — Select boss slot:",
      components: [new ActionRowBuilder().addComponents(menu)],
      flags: MessageFlags.Ephemeral
    });
  }

  // ── INSERT TIME — modal trigger ──
  if (interaction.isStringSelectMenu() && interaction.customId === "select_boss_insert") {
    const id   = interaction.values[0];
    const boss = BOSSES.find(b => b.id === id);
    log(interaction.user, `Insert: selected ${boss.name}`);
    const modal = new ModalBuilder()
      .setCustomId(`killtime_${id}`)
      .setTitle(`Insert Kill Time — ${boss.name}`);
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("time")
        .setLabel("HH:MM (24h, server time)")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("e.g. 21:34 — leave blank for current time")
        .setRequired(false)
    ));
    return interaction.showModal(modal);
  }

  // ── INSERT / OVERWRITE — modal submit ──
  if (interaction.isModalSubmit() && interaction.customId.startsWith("killtime_")) {
    snapshot();
    const id   = interaction.customId.replace("killtime_", "");
    const boss = BOSSES.find(b => b.id === id);
    const raw  = interaction.fields.getTextInputValue("time").trim();
    const now  = Date.now();
    const killTime    = raw === "" ? now : parseServerTime(...raw.split(":").map(Number)).getTime();
    const respawnTime = recordKill(id, killTime, interaction.user.username);
    log(interaction.user, `MANUAL SET ${boss.name} — kill: ${toServerDateTimeStr(killTime)} — respawn: ${toServerDateTimeStr(respawnTime)}`);
    await announceKill(interaction.channel, interaction.user, `manually set **${boss.name}** kill time`,
      `🕒 Kill: ${toServerDateTimeStr(killTime)} — 🔄 Respawn: ${toServerDateTimeStr(respawnTime)}`);
    await maybeRepinAfterAction(interaction.channel);
    return interaction.deferUpdate();
  }

  // ── RESET — picker ──
  if (interaction.isButton() && interaction.customId === "reset_boss") {
    log(interaction.user, `Opened reset menu`);
    const keys = [...new Set(BOSSES.map(b => b.key))];
    const options = [
      ...keys.map(key => {
        const label = BOSSES.find(b => b.key === key).label;
        return { label: `Reset ALL ${label}`, value: `RESET_KEY_${key}` };
      }),
      ...BOSSES.map(b => ({ label: `Reset ${b.name}`, value: b.id })),
      { label: "☠️ DELETE ALL TIMERS", value: "DELETE_ALL" },
    ];
    const menu = new StringSelectMenuBuilder()
      .setCustomId("reset_select")
      .setPlaceholder("Select what to reset")
      .addOptions(options);
    return interaction.reply({
      content: "🧹 What do you want to reset?",
      components: [new ActionRowBuilder().addComponents(menu)],
      flags: MessageFlags.Ephemeral
    });
  }

  // ── RESET — apply ──
  if (interaction.isStringSelectMenu() && interaction.customId === "reset_select") {
    snapshot();
    const value = interaction.values[0];

    if (value === "DELETE_ALL") {
      for (const b of BOSSES) {
        clearBossCards(b.id);
        delete data.kills[b.id];
        spawnWarnings[b.id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
      }
      save();
      log(interaction.user, `RESET ALL TIMERS`);
      await announceAdmin(interaction.channel, interaction.user, "reset **ALL** timers ☠️");
      await maybeRepinAfterAction(interaction.channel);
      return interaction.deferUpdate();
    }

    if (value.startsWith("RESET_KEY_")) {
      const key     = value.replace("RESET_KEY_", "");
      const targets = BOSSES.filter(b => b.key === key);
      for (const b of targets) {
        clearBossCards(b.id);
        delete data.kills[b.id];
        spawnWarnings[b.id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
      }
      save();
      const label = targets[0]?.label ?? key;
      log(interaction.user, `RESET ALL ${label}`);
      await announceAdmin(interaction.channel, interaction.user, `reset all **${label}** timers`);
      await maybeRepinAfterAction(interaction.channel);
      return interaction.deferUpdate();
    }

    // Single slot reset
    const boss = BOSSES.find(b => b.id === value);
    clearBossCards(value);
    delete data.kills[value];
    spawnWarnings[value] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
    save();
    log(interaction.user, `RESET timer for ${boss.name}`);
    await announceAdmin(interaction.channel, interaction.user, `reset timer for **${boss.name}**`);
    await maybeRepinAfterAction(interaction.channel);
    return interaction.deferUpdate();
  }

  // ── UNDO ──
  if (interaction.isButton() && interaction.customId === "undo") {
    if (undo()) {
      log(interaction.user, `UNDO`);
      recalcSpawnWarningsAfterUndo();
      await announceAdmin(interaction.channel, interaction.user, "used **undo**");
      await maybeRepinAfterAction(interaction.channel);
    }
    return interaction.deferUpdate();
  }
});

client.login(TOKEN);
