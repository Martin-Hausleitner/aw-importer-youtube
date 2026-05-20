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
const SERVICE_LABEL = "io.activitywatch.aw-importer-youtube";
const DEFAULT_CONFIG = {
  baseUrl: DEFAULT_BASE_URL,
  bucket: null,
  lookbackDays: 14,
  metadata: true,
  metadataLimit: 50,
  skipExisting: false,
  browserHistoryRoots: [
    "~/Library/Application Support/Google/Chrome",
    "~/Library/Application Support/BraveSoftware/Brave-Browser",
    "~/Library/Application Support/Comet",
    "~/Library/Application Support/com.operasoftware.Opera",
  ],
  takeoutDirs: [
    "~/Downloads",
    "~/ActivityWatchImports",
    "~/Library/CloudStorage/OneDrive-Personal/ActivityWatchImports",
    "~/Library/Mobile Documents/com~apple~CloudDocs/ActivityWatchImports",
  ],
  privacy: {
    description: true,
    tags: true,
    stats: true,
    thumbnails: true,
  },
  service: {
    intervalSeconds: 60,
  },
};

async function main() {
  const opts = loadOptions(process.argv.slice(2));
  if (opts.command === "doctor") {
    await runDoctor(opts);
    return;
  }
  if (opts.command === "install-service") {
    installService(opts);
    return;
  }
  if (opts.command === "backfill" && !opts.dryRun && !opts.confirm) {
    throw new Error("Backfill writes many events. Re-run with --dry-run first, then add --confirm to write.");
  }
  await runSync(opts);
}

async function runSync(opts) {
  const baseUrl = opts.baseUrl;
  const now = new Date();
  const since = opts.since ? new Date(opts.since) : new Date(now.getTime() - opts.lookbackDays * 24 * 3600 * 1000);

  fs.mkdirSync(APP_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });

  const info = await awGet(baseUrl, "/info");
  const bucketId = opts.bucket || `aw-import-youtube-watch-sessions_${info.hostname || os.hostname()}`;

  const awEvents = await collectActivityWatchEvents(baseUrl, since, now);
  const chromeEvents = collectChromeHistoryEvents(since, opts.browserHistoryRoots);
  const takeoutEvents = collectTakeoutEvents(since, opts.takeoutDirs);
  const candidates = dedupeEvents([...awEvents, ...chromeEvents, ...takeoutEvents]);
  const sessions = buildWatchSessions(candidates);
  const enrichedSessions = opts.metadata ? enrichSessionsWithMetadata(sessions, opts.metadataLimit, opts.privacy) : sessions.map((event) => applyPrivacy(event, opts.privacy));
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
    quality: qualityReport(enrichedSessions),
    metadata: {
      enabled: opts.metadata,
      cachePath: METADATA_CACHE_PATH,
      limit: opts.metadataLimit,
    },
    configPath: opts.configPath || null,
  };
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
}

function loadOptions(args) {
  const parsed = parseArgs(args);
  const config = loadConfig(parsed.configPath);
  const opts = mergeOptions(DEFAULT_CONFIG, config, parsed);
  if (process.env.AW_BASE_URL && !parsed.baseUrl) opts.baseUrl = process.env.AW_BASE_URL;
  opts.browserHistoryRoots = opts.browserHistoryRoots.map(expandHome);
  opts.takeoutDirs = opts.takeoutDirs.map(expandHome);
  return opts;
}

function parseArgs(args) {
  const opts = { command: "sync", dryRun: false, takeoutDirs: [], browserHistoryRoots: [] };
  const commands = new Set(["sync", "backfill", "doctor", "install-service"]);
  if (args[0] && commands.has(args[0])) opts.command = args.shift();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--confirm" || arg === "--yes") opts.confirm = true;
    else if (arg === "--skip-existing") opts.skipExisting = true;
    else if (arg === "--config") opts.configPath = args[++i];
    else if (arg === "--lookback-days") opts.lookbackDays = Number(args[++i]);
    else if (arg === "--days") opts.lookbackDays = Number(args[++i]);
    else if (arg === "--since") opts.since = args[++i];
    else if (arg === "--base-url") opts.baseUrl = args[++i];
    else if (arg === "--bucket") opts.bucket = args[++i];
    else if (arg === "--takeout-dir") opts.takeoutDirs.push(args[++i]);
    else if (arg === "--browser-history-root") opts.browserHistoryRoots.push(args[++i]);
    else if (arg === "--metadata-limit") opts.metadataLimit = Number(args[++i]);
    else if (arg === "--no-metadata") opts.metadata = false;
    else if (arg === "--minimal-metadata") opts.privacy = { description: false, tags: false, stats: false, thumbnails: false };
    else if (arg === "--no-description") opts.privacy = { ...(opts.privacy || {}), description: false };
    else if (arg === "--no-tags") opts.privacy = { ...(opts.privacy || {}), tags: false };
    else if (arg === "--no-stats") opts.privacy = { ...(opts.privacy || {}), stats: false };
    else if (arg === "--no-thumbnails") opts.privacy = { ...(opts.privacy || {}), thumbnails: false };
    else if (arg === "--interval-seconds") opts.service = { ...(opts.service || {}), intervalSeconds: Number(args[++i]) };
    else if (arg === "--node-bin") opts.nodeBin = args[++i];
    else if (arg === "--project-dir") opts.projectDir = args[++i];
    else if (arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function loadConfig(configPath) {
  const candidates = configPath
    ? [configPath]
    : [
        path.join(process.cwd(), "aw-importer-youtube.config.json"),
        path.join(process.cwd(), "config.json"),
        path.join(APP_DIR, "config.json"),
      ];
  for (const candidate of candidates) {
    const fullPath = expandHome(candidate);
    if (!fs.existsSync(fullPath)) continue;
    try {
      return { ...JSON.parse(fs.readFileSync(fullPath, "utf8")), configPath: fullPath };
    } catch (error) {
      throw new Error(`Could not read config ${fullPath}: ${error.message}`);
    }
  }
  return {};
}

function mergeOptions(defaults, config, cli) {
  const merged = {
    ...defaults,
    ...config,
    ...cli,
    privacy: {
      ...defaults.privacy,
      ...(config.privacy || {}),
      ...(cli.privacy || {}),
    },
    service: {
      ...defaults.service,
      ...(config.service || {}),
      ...(cli.service || {}),
    },
  };
  if (cli.takeoutDirs?.length) merged.takeoutDirs = cli.takeoutDirs;
  if (cli.browserHistoryRoots?.length) merged.browserHistoryRoots = cli.browserHistoryRoots;
  validateOptions(merged);
  return merged;
}

function validateOptions(opts) {
  if (!Number.isFinite(opts.lookbackDays) || opts.lookbackDays <= 0) {
    throw new Error("--lookback-days must be a positive number");
  }
  if (!Number.isFinite(opts.metadataLimit) || opts.metadataLimit < 0) {
    throw new Error("--metadata-limit must be a non-negative number");
  }
  if (!Number.isFinite(opts.service.intervalSeconds) || opts.service.intervalSeconds < 10) {
    throw new Error("--interval-seconds must be at least 10");
  }
}

function expandHome(value) {
  if (!value) return value;
  return String(value).replace(/^~(?=$|\/)/, os.homedir());
}

function printHelp() {
  process.stdout.write(`Usage: node src/cli.mjs [command] [options]

Commands:
  sync             Import recent sessions (default)
  backfill         Import a longer range; requires --dry-run or --confirm
  doctor           Check ActivityWatch, local tools, and readable sources
  install-service  Install/update the macOS LaunchAgent

Options:
  --config PATH      Read JSON config (default: ./aw-importer-youtube.config.json if present)
  --lookback-days N   Import the last N days (default: 14)
  --days N          Alias for --lookback-days
  --since ISO         Import from an explicit timestamp
  --dry-run           Print counts without writing ActivityWatch events
  --confirm          Allow backfill writes
  --base-url URL      ActivityWatch API base URL
  --bucket ID         Destination ActivityWatch bucket
  --browser-history-root DIR  Add/override a Chromium-style history root
  --takeout-dir DIR   Add/override a Google Takeout search root
  --metadata-limit N  Fetch metadata for up to N uncached videos per run (default: 50)
  --no-metadata       Skip yt-dlp metadata enrichment
  --minimal-metadata  Store title, URL, IDs, timing, and channel basics only
  --no-description    Do not store video descriptions
  --no-tags           Do not store tags/categories/chapters/caption languages
  --no-stats          Do not store view/like/comment/rating stats
  --no-thumbnails     Do not store thumbnails
  --skip-existing     Do not fetch existing destination events before insert
  --interval-seconds N  LaunchAgent interval for install-service
  --node-bin PATH     Node binary for install-service
  --project-dir PATH  Project directory for install-service
`);
}

async function runDoctor(opts) {
  const checks = [];
  checks.push(await checkActivityWatch(opts.baseUrl));
  checks.push(checkExecutable("sqlite3"));
  checks.push(checkExecutable("yt-dlp", opts.metadata ? "required for metadata enrichment" : "optional because metadata is disabled"));
  const browserHistoryFiles = findBrowserHistoryFiles(opts.browserHistoryRoots);
  const takeoutFiles = findTakeoutHistoryFiles(opts.takeoutDirs);
  checks.push({
    name: "browser_history",
    ok: true,
    detail: `${browserHistoryFiles.length} History file(s) found`,
  });
  checks.push({
    name: "google_takeout",
    ok: true,
    detail: `${takeoutFiles.length} youtube-watch-history.json file(s) found`,
  });
  const report = {
    ok: checks.every((check) => check.ok),
    checks,
    configPath: opts.configPath || null,
    statePath: STATE_PATH,
    metadataCachePath: METADATA_CACHE_PATH,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

async function checkActivityWatch(baseUrl) {
  try {
    const info = await awGet(baseUrl, "/info");
    return { name: "activitywatch", ok: true, detail: `reachable at ${baseUrl}`, hostname: info.hostname };
  } catch (error) {
    return { name: "activitywatch", ok: false, detail: error.message };
  }
}

function checkExecutable(name, note = "") {
  try {
    execFileSync(name, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    return { name, ok: true, detail: note || "available" };
  } catch {
    return { name, ok: false, detail: note || "not available on PATH" };
  }
}

function installService(opts) {
  const nodeBin = opts.nodeBin || process.execPath;
  const projectDir = path.resolve(expandHome(opts.projectDir || process.cwd()));
  const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
  const plistPath = path.join(launchAgentsDir, `${SERVICE_LABEL}.plist`);
  const logDir = path.join(os.homedir(), "Library", "Logs", "aw-importer-youtube");
  const configArgs = opts.configPath ? `\n    <string>--config</string>\n    <string>${escapeXml(opts.configPath)}</string>` : "";
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodeBin)}</string>
    <string>${escapeXml(path.join(projectDir, "src", "cli.mjs"))}</string>
    <string>sync</string>${configArgs}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(projectDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${Math.round(opts.service.intervalSeconds)}</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(logDir, "launchd.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(logDir, "launchd.err.log"))}</string>
</dict>
</plist>
`;
  if (opts.dryRun) {
    process.stdout.write(`${JSON.stringify({ installed: false, dryRun: true, label: SERVICE_LABEL, plistPath, intervalSeconds: opts.service.intervalSeconds, plist }, null, 2)}\n`);
    return;
  }
  fs.mkdirSync(launchAgentsDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(plistPath, plist);
  try {
    execFileSync("launchctl", ["bootout", `gui/${process.getuid()}`, plistPath], { stdio: "ignore" });
  } catch {
    // Service may not be loaded yet.
  }
  execFileSync("launchctl", ["bootstrap", `gui/${process.getuid()}`, plistPath], { stdio: "inherit" });
  process.stdout.write(`${JSON.stringify({ installed: true, label: SERVICE_LABEL, plistPath, intervalSeconds: opts.service.intervalSeconds }, null, 2)}\n`);
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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

function collectChromeHistoryEvents(since, browserHistoryRoots) {
  const histories = findBrowserHistoryFiles(browserHistoryRoots);
  const out = [];
  for (const historyPath of histories) {
    for (const row of readHistoryRows(historyPath)) {
      const event = eventFromChromeHistoryRow({ ...row, profile: profileLabel(historyPath) });
      if (event) out.push(event);
    }
  }
  return filterEventsSince(out, since);
}

function findBrowserHistoryFiles(roots = DEFAULT_CONFIG.browserHistoryRoots.map(expandHome)) {
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

function collectTakeoutEvents(since, takeoutDirs) {
  const files = findTakeoutHistoryFiles(takeoutDirs);
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

function findTakeoutHistoryFiles(roots = DEFAULT_CONFIG.takeoutDirs.map(expandHome)) {
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

function enrichSessionsWithMetadata(sessions, metadataLimit, privacy) {
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
    return applyPrivacy(metadata ? applyVideoMetadata(session, metadata) : session, privacy);
  });
  saveMetadataCache(cache);
  return enriched;
}

function applyPrivacy(event, privacy) {
  const data = { ...(event.data || {}) };
  if (!privacy.description) delete data.description;
  if (!privacy.tags) {
    for (const key of ["categories", "tags", "chapters", "subtitle_languages", "automatic_caption_languages", "language"]) {
      delete data[key];
    }
  }
  if (!privacy.stats) {
    for (const key of ["view_count", "like_count", "comment_count", "average_rating"]) {
      delete data[key];
    }
  }
  if (!privacy.thumbnails) {
    for (const key of ["thumbnail", "thumbnails"]) {
      delete data[key];
    }
  }
  return { ...event, data };
}

function qualityReport(events) {
  const total = events.length;
  const count = (field) => events.filter((event) => event?.data?.[field] !== undefined && event?.data?.[field] !== null && event?.data?.[field] !== "").length;
  const sumWatchSeconds = events.reduce((sum, event) => sum + Number(event?.data?.watch_seconds || event?.duration || 0), 0);
  return {
    total,
    with_url: count("url"),
    with_video_id: count("video_id"),
    with_channel: count("channel"),
    with_description: count("description"),
    with_watch_minutes: count("watch_minutes"),
    total_watch_minutes: Math.round((sumWatchSeconds / 60) * 100) / 100,
  };
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
