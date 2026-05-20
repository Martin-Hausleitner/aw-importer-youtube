#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  applyVideoMetadata,
  buildWatchSessions,
  dedupeEvents,
  eventFromActivityWatch,
  eventFromChromeHistoryRow,
  eventFromTakeoutEntry,
  filterEventsSince,
  METADATA_SCHEMA_VERSION,
  normalizeVideoMetadata,
  shouldReplaceExistingSession,
} from "./youtube-sync.mjs";

const DEFAULT_BASE_URL = "http://127.0.0.1:5600/api/0";
const APP_DIR = path.join(os.homedir(), "Library", "Application Support", "aw-importer-youtube");
const STATE_PATH = path.join(APP_DIR, "state.json");
const METADATA_CACHE_PATH = path.join(APP_DIR, "youtube-metadata-cache.json");
const LOG_DIR = path.join(os.homedir(), "Library", "Logs", "aw-importer-youtube");

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const baseUrl = opts.baseUrl || process.env.AW_BASE_URL || DEFAULT_BASE_URL;
  const now = new Date();
  const since = opts.since ? new Date(opts.since) : new Date(now.getTime() - opts.lookbackDays * 24 * 3600 * 1000);

  fs.mkdirSync(APP_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });

  const info = await awGet(baseUrl, "/info");
  const bucketId = opts.bucket || `aw-import-youtube-watch-sessions_${info.hostname || os.hostname()}`;

  const awEvents = await collectActivityWatchEvents(baseUrl, since, now);
  const chromeEvents = collectChromeHistoryEvents(since);
  const takeoutEvents = collectTakeoutEvents(since);
  const candidates = dedupeEvents([...awEvents, ...chromeEvents, ...takeoutEvents]);
  const sessions = buildWatchSessions(candidates);
  const enrichedSessions = opts.metadata ? enrichSessionsWithMetadata(sessions, opts.metadataLimit) : sessions;
  const existingByKey = opts.skipExisting ? new Map() : await existingSessionsByKey(baseUrl, bucketId, since, now);
  const replacements = [];
  const newEvents = [];
  for (const event of enrichedSessions) {
    const existing = existingByKey.get(event.data.sync_key);
    if (!existing) {
      newEvents.push(event);
    } else if (shouldReplaceExistingSession(existing, event)) {
      replacements.push({ existing, next: event });
    }
  }

  if (!opts.dryRun && (newEvents.length || replacements.length)) {
    await ensureBucket(baseUrl, bucketId, info.hostname || os.hostname());
    for (const replacement of replacements) {
      await deleteEvent(baseUrl, bucketId, replacement.existing.id);
    }
    await insertEvents(baseUrl, bucketId, [...replacements.map((replacement) => replacement.next), ...newEvents]);
  } else if (!opts.dryRun) {
    await ensureBucket(baseUrl, bucketId, info.hostname || os.hostname());
  }

  const state = {
    lastRun: now.toISOString(),
    bucketId,
    since: since.toISOString(),
    dryRun: opts.dryRun,
    rawCandidates: candidates.length,
    sessions: enrichedSessions.length,
    inserted: opts.dryRun ? 0 : newEvents.length,
    replaced: opts.dryRun ? 0 : replacements.length,
    wouldInsert: opts.dryRun ? newEvents.length : undefined,
    wouldReplace: opts.dryRun ? replacements.length : undefined,
    sources: {
      activitywatch: awEvents.length,
      chrome_history: chromeEvents.length,
      google_takeout: takeoutEvents.length,
    },
    metadata: {
      enabled: opts.metadata,
      cachePath: METADATA_CACHE_PATH,
      limit: opts.metadataLimit,
    },
  };
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
}

function parseArgs(args) {
  const opts = {
    lookbackDays: 14,
    dryRun: false,
    metadata: true,
    metadataLimit: 50,
    skipExisting: false,
    takeoutDirs: [],
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--skip-existing") opts.skipExisting = true;
    else if (arg === "--lookback-days") opts.lookbackDays = Number(args[++i]);
    else if (arg === "--since") opts.since = args[++i];
    else if (arg === "--base-url") opts.baseUrl = args[++i];
    else if (arg === "--bucket") opts.bucket = args[++i];
    else if (arg === "--takeout-dir") opts.takeoutDirs.push(args[++i]);
    else if (arg === "--metadata-limit") opts.metadataLimit = Number(args[++i]);
    else if (arg === "--no-metadata") opts.metadata = false;
    else if (arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(opts.lookbackDays) || opts.lookbackDays <= 0) {
    throw new Error("--lookback-days must be a positive number");
  }
  if (!Number.isFinite(opts.metadataLimit) || opts.metadataLimit < 0) {
    throw new Error("--metadata-limit must be a non-negative number");
  }
  return opts;
}

function printHelp() {
  process.stdout.write(`Usage: node src/cli.mjs [options]

Options:
  --lookback-days N   Import the last N days (default: 14)
  --since ISO         Import from an explicit timestamp
  --dry-run           Print counts without writing ActivityWatch events
  --base-url URL      ActivityWatch API base URL
  --bucket ID         Destination ActivityWatch bucket
  --metadata-limit N  Fetch metadata for up to N uncached videos per run (default: 50)
  --no-metadata       Skip yt-dlp metadata enrichment
  --skip-existing     Do not fetch existing destination events before insert
`);
}

async function collectActivityWatchEvents(baseUrl, since, now) {
  const buckets = await awGet(baseUrl, "/buckets/");
  const ids = Object.keys(buckets).filter((id) => /watcher-(web|window)/.test(id));
  const out = [];
  for (const id of ids) {
    const qs = new URLSearchParams({ start: since.toISOString(), end: now.toISOString() });
    const events = await awGet(baseUrl, `/buckets/${encodeURIComponent(id)}/events?${qs}`);
    for (const event of events) {
      const normalized = eventFromActivityWatch(id, event);
      if (normalized) out.push(normalized);
    }
  }
  return out;
}

function collectChromeHistoryEvents(since) {
  const histories = findBrowserHistoryFiles();
  const out = [];
  for (const historyPath of histories) {
    for (const row of readHistoryRows(historyPath)) {
      const event = eventFromChromeHistoryRow({ ...row, profile: profileLabel(historyPath) });
      if (event) out.push(event);
    }
  }
  return filterEventsSince(out, since);
}

function findBrowserHistoryFiles() {
  const roots = [
    path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome"),
    path.join(os.homedir(), "Library", "Application Support", "BraveSoftware", "Brave-Browser"),
    path.join(os.homedir(), "Library", "Application Support", "Comet"),
    path.join(os.homedir(), "Library", "Application Support", "com.operasoftware.Opera"),
  ];
  const files = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    walk(root, 4, (file) => {
      if (path.basename(file) === "History") files.push(file);
    });
  }
  return files;
}

function readHistoryRows(historyPath) {
  const tmp = path.join(os.tmpdir(), `aw-youtube-history-${process.pid}-${Buffer.from(historyPath).toString("hex").slice(0, 16)}`);
  try {
    fs.copyFileSync(historyPath, tmp);
    const sql = `
      select url, title, last_visit_time
      from urls
      where url like '%youtube.com/watch%'
         or url like '%music.youtube.com/watch%'
         or url like '%youtube.com/shorts/%'
         or url like '%youtu.be/%'
      order by last_visit_time desc
    `;
    const raw = execFileSync("sqlite3", ["-json", tmp, sql], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function collectTakeoutEvents(since) {
  const files = findTakeoutHistoryFiles();
  const out = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      const entries = Array.isArray(parsed) ? parsed : [];
      for (const entry of entries) {
        const event = eventFromTakeoutEntry(entry);
        if (event) out.push(event);
      }
    } catch {
      continue;
    }
  }
  return filterEventsSince(out, since);
}

function findTakeoutHistoryFiles() {
  const roots = [
    path.join(os.homedir(), "Downloads"),
    path.join(os.homedir(), "ActivityWatchImports"),
    path.join(os.homedir(), "Library", "CloudStorage", "OneDrive-Personal", "ActivityWatchImports"),
    path.join(os.homedir(), "Library", "Mobile Documents", "com~apple~CloudDocs", "ActivityWatchImports"),
  ];
  const files = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    walk(root, 5, (file) => {
      if (path.basename(file) === "youtube-watch-history.json") files.push(file);
    });
  }
  return files;
}

async function existingSessionsByKey(baseUrl, bucketId, since, now) {
  try {
    const qs = new URLSearchParams({ start: since.toISOString(), end: now.toISOString() });
    const events = await awGet(baseUrl, `/buckets/${encodeURIComponent(bucketId)}/events?${qs}`);
    return new Map(events.filter((event) => event?.data?.sync_key).map((event) => [event.data.sync_key, event]));
  } catch {
    return new Map();
  }
}

async function ensureBucket(baseUrl, bucketId, hostname) {
  const payload = { client: "aw-importer-youtube", type: "media.youtube.watch.session", hostname };
  const res = await fetch(`${baseUrl}/buckets/${encodeURIComponent(bucketId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (![200, 201, 304].includes(res.status)) {
    throw new Error(`ActivityWatch bucket create failed: ${res.status} ${await res.text()}`);
  }
}

async function insertEvents(baseUrl, bucketId, events) {
  const chunkSize = 250;
  for (let i = 0; i < events.length; i += chunkSize) {
    const chunk = events.slice(i, i + chunkSize);
    const res = await fetch(`${baseUrl}/buckets/${encodeURIComponent(bucketId)}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) {
      throw new Error(`ActivityWatch insert failed: ${res.status} ${await res.text()}`);
    }
  }
}

async function deleteEvent(baseUrl, bucketId, eventId) {
  if (eventId === undefined || eventId === null) return;
  const res = await fetch(`${baseUrl}/buckets/${encodeURIComponent(bucketId)}/events/${eventId}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`ActivityWatch delete failed: ${res.status} ${await res.text()}`);
  }
}

function enrichSessionsWithMetadata(sessions, metadataLimit) {
  const cache = loadMetadataCache();
  let fetched = 0;
  const enriched = sessions.map((session) => {
    const videoId = session.data.video_id;
    if (!videoId) return session;
    let metadata = cache[videoId];
    if (metadataNeedsRefresh(metadata) && fetched < metadataLimit) {
      metadata = fetchVideoMetadata(videoId);
      fetched += 1;
      if (metadata) {
        metadata.metadata_fetched_at = new Date().toISOString();
        cache[videoId] = metadata;
      }
    }
    return metadata ? applyVideoMetadata(session, metadata) : session;
  });
  saveMetadataCache(cache);
  return enriched;
}

function loadMetadataCache() {
  try {
    return JSON.parse(fs.readFileSync(METADATA_CACHE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveMetadataCache(cache) {
  const tmp = `${METADATA_CACHE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, METADATA_CACHE_PATH);
}

function fetchVideoMetadata(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  try {
    const raw = execFileSync(
      "yt-dlp",
      ["--dump-single-json", "--skip-download", "--no-playlist", "--no-warnings", url],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 45000, stdio: ["ignore", "pipe", "ignore"] },
    );
    const data = JSON.parse(raw);
    return normalizeVideoMetadata({ ...data, metadata_source: "yt-dlp" }, videoId);
  } catch {
    return null;
  }
}

function metadataNeedsRefresh(metadata) {
  if (!metadata) return true;
  return Number(metadata.metadata_schema_version || 0) < METADATA_SCHEMA_VERSION;
}

async function awGet(baseUrl, pathPart) {
  const res = await fetch(`${baseUrl}${pathPart}`);
  if (!res.ok) throw new Error(`ActivityWatch GET failed: ${res.status} ${pathPart}`);
  return await res.json();
}

function walk(root, maxDepth, onFile, depth = 0) {
  if (depth > maxDepth) return;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walk(full, maxDepth, onFile, depth + 1);
    else if (entry.isFile()) onFile(full);
  }
}

function profileLabel(historyPath) {
  const parts = historyPath.split(path.sep);
  const idx = parts.lastIndexOf("Application Support");
  return idx >= 0 ? parts.slice(idx + 1, -1).join("/") : path.dirname(historyPath);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
