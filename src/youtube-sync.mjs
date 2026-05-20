import crypto from "node:crypto";

const WEBKIT_EPOCH_MS = Date.UTC(1601, 0, 1);
const MATCH_WINDOW_MS = 12 * 60 * 60 * 1000;
const SESSION_GAP_MS = 5 * 60 * 1000;
export const METADATA_SCHEMA_VERSION = 2;

export function extractYouTubeVideoId(rawUrl) {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./, "");
    if (host === "youtu.be") {
      return validVideoId(url.pathname.split("/").filter(Boolean)[0]);
    }
    if (!host.endsWith("youtube.com")) return null;
    if (url.pathname === "/watch") return validVideoId(url.searchParams.get("v"));
    const parts = url.pathname.split("/").filter(Boolean);
    if (["shorts", "live", "embed"].includes(parts[0])) return validVideoId(parts[1]);
  } catch {
    return null;
  }
  return null;
}

export function canonicalYouTubeUrl(videoId) {
  return videoId ? `https://www.youtube.com/watch?v=${videoId}` : null;
}

export function parseYouTubeStartSeconds(rawUrl) {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    const value = url.searchParams.get("t") || url.searchParams.get("start");
    if (!value) return null;
    if (/^\d+$/.test(value)) return Number(value);
    const match = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/i);
    if (!match) return null;
    const seconds = Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
    return seconds || null;
  } catch {
    return null;
  }
}

export function normalizeYouTubeTitle(title) {
  if (!title || typeof title !== "string") return null;
  let cleaned = title.trim();
  cleaned = cleaned.replace(/^\(\d+\)\s+/, "");
  cleaned = cleaned.replace(/\s+-\s+(Google Chrome|Brave Browser|Brave|Comet|Opera)$/i, "");
  cleaned = cleaned.replace(/\s+-\s+Audio playing$/i, "");
  cleaned = cleaned.replace(/\s+-\s+YouTube$/i, "");
  cleaned = cleaned.replace(/^Watched\s+/i, "");
  cleaned = cleaned.trim();
  if (!cleaned || /^YouTube$/i.test(cleaned)) return null;
  return cleaned;
}

export function chromeTimeToIso(value) {
  const micros = Number(value || 0);
  return new Date(WEBKIT_EPOCH_MS + Math.floor(micros / 1000)).toISOString();
}

export function eventFromActivityWatch(bucketId, event) {
  const data = event?.data || {};
  const rawUrl = typeof data.url === "string" ? data.url : null;
  const videoId = extractYouTubeVideoId(rawUrl);
  const title = normalizeYouTubeTitle(data.title);
  const sourceApp = sourceAppForBucket(bucketId, data);
  const appLooksLikeYouTube = String(data.app || "").toLowerCase().includes("youtube");
  const browserWindowLooksLikeYouTube = isBrowserApp(data.app) && /\bYouTube\b/i.test(String(data.title || ""));
  const urlLooksLikeYouTube = rawUrl ? isYouTubeHost(rawUrl) : false;

  if (!videoId && !(title && (appLooksLikeYouTube || urlLooksLikeYouTube || browserWindowLooksLikeYouTube))) return null;

  const duration = Number(event.duration || 0);
  const timestamp = String(event.timestamp);
  const normalized = {
    timestamp,
    duration,
    data: {
      source: "activitywatch",
      source_bucket: bucketId,
      source_app: sourceApp,
      title,
      url: rawUrl,
      video_id: videoId,
      playback_start_seconds: parseYouTubeStartSeconds(rawUrl) ?? undefined,
      audible: typeof data.audible === "boolean" ? data.audible : undefined,
    },
  };
  removeUndefined(normalized.data);
  normalized.data.sync_key = stableSyncKey([
    normalized.data.source,
    bucketId,
    timestamp,
    duration,
    videoId,
    title,
  ]);
  return normalized;
}

export function eventFromChromeHistoryRow(row) {
  const videoId = extractYouTubeVideoId(row?.url);
  if (!videoId) return null;
  const title = normalizeYouTubeTitle(row.title);
  const timestamp = chromeTimeToIso(row.last_visit_time);
  return {
    timestamp,
    duration: 1,
    data: {
      source: "chrome_history",
      source_profile: row.profile || null,
      title,
      url: row.url,
      video_id: videoId,
      playback_start_seconds: parseYouTubeStartSeconds(row.url) ?? undefined,
      sync_key: stableSyncKey(["chrome_history", row.profile || "", timestamp, videoId, title]),
    },
  };
}

export function eventFromTakeoutEntry(entry) {
  const url = entry?.titleUrl || entry?.url || null;
  const videoId = extractYouTubeVideoId(url);
  if (!videoId || !entry?.time) return null;
  const title = normalizeYouTubeTitle(entry.title);
  const channel = Array.isArray(entry.subtitles) && entry.subtitles[0]?.name ? entry.subtitles[0].name : null;
  const timestamp = new Date(entry.time).toISOString();
  return {
    timestamp,
    duration: 1,
    data: {
      source: "google_takeout",
      title,
      url,
      video_id: videoId,
      playback_start_seconds: parseYouTubeStartSeconds(url) ?? undefined,
      channel,
      sync_key: stableSyncKey(["google_takeout", timestamp, videoId, title, channel]),
    },
  };
}

export function buildWatchSessions(events, options = {}) {
  const matchWindowMs = options.matchWindowMs ?? MATCH_WINDOW_MS;
  const sessionGapMs = options.sessionGapMs ?? SESSION_GAP_MS;
  const enriched = matchMissingVideoDetails(dedupeEvents(events), matchWindowMs);
  const sorted = enriched
    .filter((event) => event?.timestamp && event?.data?.title)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const markerKeysUsed = new Set();
  const sessions = [];

  for (const event of sorted) {
    const key = sessionGroupingKey(event);
    const isMarker = event.data.source !== "activitywatch";
    const start = new Date(event.timestamp);
    const duration = Math.max(0, Number(event.duration || 0));
    const end = new Date(start.getTime() + duration * 1000);

    if (isMarker) {
      const existing = sessions.find((session) => canMergeIntoSession(session, event, sessionGapMs));
      if (existing) {
        mergeEventIntoSession(existing, event, { markerOnly: true });
        markerKeysUsed.add(event.data.sync_key);
      }
      continue;
    }

    const previous = sessions[sessions.length - 1];
    if (previous && previous.__groupKey === key && start.getTime() - previous.__endMs <= sessionGapMs) {
      mergeEventIntoSession(previous, event);
    } else {
      sessions.push(createSession(event, key, start, end));
    }
  }

  for (const event of sorted) {
    if (event.data.source === "activitywatch") continue;
    if (markerKeysUsed.has(event.data.sync_key)) continue;
    const key = sessionGroupingKey(event);
    const start = new Date(event.timestamp);
    const end = new Date(start.getTime() + Math.max(1, Number(event.duration || 1)) * 1000);
    sessions.push(createSession(event, key, start, end, { markerOnly: true }));
  }

  return sessions
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    .map(finalizeSession);
}

export function applyVideoMetadata(session, metadata) {
  if (!metadata) return session;
  const out = cloneEvent(session);
  const data = out.data;
  const normalized = normalizeVideoMetadata(metadata, data.video_id);
  data.metadata_source = metadata.metadata_source || "yt-dlp";
  data.metadata_fetched_at = metadata.metadata_fetched_at || data.metadata_fetched_at;
  data.metadata_schema_version = normalized.metadata_schema_version;
  data.video_id = data.video_id || normalized.id || null;
  data.url = data.url || normalized.webpage_url || canonicalYouTubeUrl(data.video_id);
  data.title = data.title || normalized.title || null;
  data.description = normalized.description || data.description || null;
  data.channel = normalized.channel || normalized.uploader || data.channel || null;
  data.channel_id = normalized.channel_id || data.channel_id || null;
  data.channel_url = normalized.channel_url || data.channel_url || null;
  data.uploader = normalized.uploader || data.uploader || null;
  data.uploader_id = normalized.uploader_id || data.uploader_id || null;
  data.uploader_url = normalized.uploader_url || data.uploader_url || null;
  data.thumbnail = normalized.thumbnail || data.thumbnail || null;
  data.thumbnails = normalized.thumbnails || data.thumbnails;
  data.view_count = normalized.view_count ?? data.view_count;
  data.like_count = normalized.like_count ?? data.like_count;
  data.dislike_count = normalized.dislike_count ?? data.dislike_count;
  data.average_rating = normalized.average_rating ?? data.average_rating;
  data.comment_count = normalized.comment_count ?? data.comment_count;
  data.channel_follower_count = normalized.channel_follower_count ?? data.channel_follower_count;
  data.upload_date = normalized.upload_date || data.upload_date || null;
  data.upload_timestamp = normalized.upload_timestamp ?? data.upload_timestamp;
  data.release_timestamp = normalized.release_timestamp ?? data.release_timestamp;
  data.modified_timestamp = normalized.modified_timestamp ?? data.modified_timestamp;
  data.age_limit = normalized.age_limit ?? data.age_limit;
  data.availability = normalized.availability || data.availability || null;
  data.live_status = normalized.live_status || data.live_status || null;
  data.is_live = normalized.is_live ?? data.is_live;
  data.was_live = normalized.was_live ?? data.was_live;
  data.categories = normalized.categories || data.categories;
  data.tags = normalized.tags || data.tags;
  data.language = normalized.language || data.language || null;
  data.chapters = normalized.chapters || data.chapters;
  data.subtitle_languages = normalized.subtitle_languages || data.subtitle_languages;
  data.automatic_caption_languages = normalized.automatic_caption_languages || data.automatic_caption_languages;
  data.metadata_webpage_url = normalized.webpage_url || data.metadata_webpage_url || null;
  data.metadata_original_url = normalized.original_url || data.metadata_original_url || null;
  data.metadata_extractor = normalized.metadata_extractor || data.metadata_extractor || null;
  data.metadata_extractor_key = normalized.metadata_extractor_key || data.metadata_extractor_key || null;
  data.video_duration_seconds = finiteNumber(normalized.duration) ? Number(normalized.duration) : data.video_duration_seconds;
  data.video_duration_minutes = finiteNumber(data.video_duration_seconds) ? roundMinutes(data.video_duration_seconds) : data.video_duration_minutes;
  removeUndefined(data);
  return out;
}

export function normalizeVideoMetadata(raw, fallbackVideoId = null) {
  const metadata = raw || {};
  const out = {
    metadata_schema_version: METADATA_SCHEMA_VERSION,
    metadata_source: metadata.metadata_source || "yt-dlp",
    metadata_fetched_at: metadata.metadata_fetched_at,
    id: metadata.id || fallbackVideoId || null,
    title: metadata.title || null,
    description: metadata.description || null,
    duration: finiteNumber(metadata.duration) ? Number(metadata.duration) : null,
    duration_string: metadata.duration_string || null,
    channel: metadata.channel || null,
    channel_id: metadata.channel_id || null,
    channel_url: metadata.channel_url || null,
    channel_follower_count: numberOrNull(metadata.channel_follower_count),
    uploader: metadata.uploader || null,
    uploader_id: metadata.uploader_id || null,
    uploader_url: metadata.uploader_url || null,
    webpage_url: metadata.webpage_url || canonicalYouTubeUrl(metadata.id || fallbackVideoId),
    original_url: metadata.original_url || null,
    thumbnail: metadata.thumbnail || null,
    thumbnails: compactThumbnails(metadata.thumbnails),
    upload_date: normalizeYtDate(metadata.upload_date),
    upload_timestamp: numberOrNull(metadata.timestamp),
    release_timestamp: numberOrNull(metadata.release_timestamp),
    modified_timestamp: numberOrNull(metadata.modified_timestamp),
    view_count: numberOrNull(metadata.view_count),
    like_count: numberOrNull(metadata.like_count),
    dislike_count: numberOrNull(metadata.dislike_count),
    average_rating: numberOrNull(metadata.average_rating),
    comment_count: numberOrNull(metadata.comment_count),
    age_limit: numberOrNull(metadata.age_limit),
    availability: metadata.availability || null,
    live_status: metadata.live_status || null,
    is_live: booleanOrNull(metadata.is_live),
    was_live: booleanOrNull(metadata.was_live),
    categories: stringArray(metadata.categories),
    tags: stringArray(metadata.tags),
    language: metadata.language || null,
    chapters: compactChapters(metadata.chapters),
    subtitle_languages: stringArray(metadata.subtitle_languages) || objectKeys(metadata.subtitles),
    automatic_caption_languages: stringArray(metadata.automatic_caption_languages) || objectKeys(metadata.automatic_captions),
    metadata_extractor: metadata.metadata_extractor || metadata.extractor || null,
    metadata_extractor_key: metadata.metadata_extractor_key || metadata.extractor_key || null,
  };
  removeEmpty(out);
  return out;
}

export function dedupeEvents(events) {
  const seen = new Set();
  const out = [];
  for (const event of events) {
    const key = event?.data?.sync_key || fallbackEventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(event);
  }
  return out;
}

export function shouldReplaceExistingSession(existing, next) {
  if (!existing?.data || !next?.data) return false;
  if (existing.data.sync_key !== next.data.sync_key) return false;
  if (Number(next.data.watch_seconds || 0) > Number(existing.data.watch_seconds || 0) + 0.5) return true;
  if (Number(next.data.metadata_schema_version || 0) > Number(existing.data.metadata_schema_version || 0)) return true;
  const qualityFields = [
    "url",
    "video_id",
    "description",
    "channel",
    "channel_id",
    "channel_url",
    "uploader",
    "uploader_id",
    "uploader_url",
    "thumbnail",
    "view_count",
    "like_count",
    "comment_count",
    "upload_date",
    "categories",
    "tags",
    "chapters",
    "subtitle_languages",
    "video_duration_seconds",
  ];
  return qualityFields.some((field) => !existing.data[field] && Boolean(next.data[field]));
}

export function filterEventsSince(events, since) {
  const min = since instanceof Date ? since.getTime() : new Date(since).getTime();
  return events.filter((event) => new Date(event.timestamp).getTime() >= min);
}

function validVideoId(value) {
  if (!value || typeof value !== "string") return null;
  return /^[a-zA-Z0-9_-]{6,}$/.test(value) ? value : null;
}

function isYouTubeHost(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./, "");
    return host === "youtu.be" || host.endsWith("youtube.com");
  } catch {
    return false;
  }
}

function sourceAppForBucket(bucketId, data) {
  if (data.app) return String(data.app);
  const lower = String(bucketId || "").toLowerCase();
  if (lower.includes("chrome")) return "chrome";
  if (lower.includes("brave")) return "brave";
  if (lower.includes("comet")) return "comet";
  if (lower.includes("opera")) return "opera";
  return "unknown";
}

function isBrowserApp(app) {
  return /^(Google Chrome|Brave Browser|Brave|Comet|Opera)$/i.test(String(app || ""));
}

function stableSyncKey(parts) {
  return parts.map((part) => (part === null || part === undefined ? "" : String(part))).join("|");
}

function matchMissingVideoDetails(events, matchWindowMs) {
  const markers = events.filter((event) => event?.data?.video_id && event?.data?.title);
  return events.map((event) => {
    if (event?.data?.video_id || !event?.data?.title) return cloneEvent(event);
    const eventTime = new Date(event.timestamp).getTime();
    const titleKey = titleMatchKey(event.data.title);
    let best = null;
    for (const marker of markers) {
      if (titleMatchKey(marker.data.title) !== titleKey) continue;
      const delta = Math.abs(new Date(marker.timestamp).getTime() - eventTime);
      if (delta > matchWindowMs) continue;
      if (!best || delta < best.delta) best = { marker, delta };
    }
    const copy = cloneEvent(event);
    if (best) {
      copy.data.video_id = best.marker.data.video_id;
      copy.data.url = best.marker.data.url || canonicalYouTubeUrl(best.marker.data.video_id);
      copy.data.playback_start_seconds =
        copy.data.playback_start_seconds ?? best.marker.data.playback_start_seconds ?? parseYouTubeStartSeconds(best.marker.data.url);
      copy.data.matched_by = "title_time_proximity";
      copy.data.matched_source = best.marker.data.source;
    }
    return copy;
  });
}

function createSession(event, groupKey, start, end, options = {}) {
  const data = event.data;
  const duration = Math.max(1, Number(event.duration || 0));
  const session = {
    timestamp: start.toISOString(),
    duration,
    data: {
      schema_version: 2,
      source: "activitywatch_youtube_sync",
      title: data.title || null,
      url: data.url || canonicalYouTubeUrl(data.video_id),
      video_id: data.video_id || null,
      description: null,
      channel: data.channel || null,
      playback_start_seconds: data.playback_start_seconds ?? parseYouTubeStartSeconds(data.url) ?? null,
      started_at: start.toISOString(),
      ended_at: end.toISOString(),
      watch_seconds: duration,
      watch_minutes: roundMinutes(duration),
      event_count: 1,
      sources: [data.source],
      source_buckets: data.source_bucket ? [data.source_bucket] : [],
      source_apps: data.source_app ? [data.source_app] : [],
      source_profiles: data.source_profile ? [data.source_profile] : [],
      audible_seconds: data.audible ? duration : 0,
      matched_by: data.matched_by || (data.video_id ? "direct_video_id" : "title_only"),
      marker_only: Boolean(options.markerOnly),
    },
    __groupKey: groupKey,
    __startMs: start.getTime(),
    __endMs: end.getTime(),
  };
  removeUndefined(session.data);
  return session;
}

function canMergeIntoSession(session, event, sessionGapMs) {
  if (sessionGroupingKey(event) !== session.__groupKey) return false;
  const eventMs = new Date(event.timestamp).getTime();
  return eventMs >= session.__startMs - sessionGapMs && eventMs <= session.__endMs + sessionGapMs;
}

function mergeEventIntoSession(session, event, options = {}) {
  const data = event.data;
  const startMs = new Date(event.timestamp).getTime();
  const duration = Math.max(options.markerOnly ? 1 : 0, Number(event.duration || 0));
  const endMs = startMs + duration * 1000;
  session.__startMs = Math.min(session.__startMs, startMs);
  session.__endMs = Math.max(session.__endMs, endMs);
  session.timestamp = new Date(session.__startMs).toISOString();

  if (!options.markerOnly) {
    session.duration += duration;
    session.data.watch_seconds = roundSeconds(session.data.watch_seconds + duration);
    session.data.watch_minutes = roundMinutes(session.data.watch_seconds);
    if (data.audible) session.data.audible_seconds = roundSeconds((session.data.audible_seconds || 0) + duration);
    session.data.marker_only = false;
  }

  session.data.title = bestString(session.data.title, data.title);
  session.data.video_id = session.data.video_id || data.video_id || null;
  session.data.url = bestString(session.data.url, data.url || canonicalYouTubeUrl(data.video_id));
  session.data.channel = bestString(session.data.channel, data.channel);
  session.data.playback_start_seconds = minNonNull(session.data.playback_start_seconds, data.playback_start_seconds);
  session.data.ended_at = new Date(session.__endMs).toISOString();
  session.data.started_at = new Date(session.__startMs).toISOString();
  session.data.event_count += 1;
  pushUnique(session.data.sources, data.source);
  if (data.source_bucket) pushUnique(session.data.source_buckets, data.source_bucket);
  if (data.source_app) pushUnique(session.data.source_apps, data.source_app);
  if (data.source_profile) pushUnique(session.data.source_profiles, data.source_profile);
  if (data.matched_by && session.data.matched_by === "title_only") session.data.matched_by = data.matched_by;
}

function finalizeSession(session) {
  const out = cloneEvent(session);
  delete out.__groupKey;
  delete out.__startMs;
  delete out.__endMs;
  out.duration = roundSeconds(out.duration);
  out.data.watch_seconds = roundSeconds(out.data.watch_seconds);
  out.data.watch_minutes = roundMinutes(out.data.watch_seconds);
  out.data.audible_seconds = roundSeconds(out.data.audible_seconds || 0);
  out.data.url = out.data.url || canonicalYouTubeUrl(out.data.video_id);
  out.data.sync_key = stableSyncKey([
    "youtube_session_v2",
    out.data.video_id || titleMatchKey(out.data.title),
    out.data.started_at,
  ]);
  removeUndefined(out.data);
  return out;
}

function sessionGroupingKey(event) {
  if (event?.data?.video_id) return `id:${event.data.video_id}`;
  return `title:${titleMatchKey(event?.data?.title)}|app:${event?.data?.source_app || ""}`;
}

function titleMatchKey(title) {
  return normalizeYouTubeTitle(title)?.toLowerCase().replace(/\s+/g, " ").trim() || "";
}

function bestString(current, next) {
  if (!next) return current || null;
  if (!current) return next;
  return String(next).length > String(current).length ? next : current;
}

function minNonNull(a, b) {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return Math.min(Number(a), Number(b));
}

function normalizeYtDate(value) {
  if (!value) return null;
  const text = String(value);
  const match = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function numberOrNull(value) {
  return finiteNumber(value) ? Number(value) : null;
}

function booleanOrNull(value) {
  return typeof value === "boolean" ? value : null;
}

function stringArray(value) {
  if (!Array.isArray(value)) return null;
  const out = value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim());
  return out.length ? out : null;
}

function objectKeys(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value).filter(Boolean).sort();
  return keys.length ? keys : null;
}

function compactChapters(value) {
  if (!Array.isArray(value)) return null;
  const chapters = value
    .map((chapter) => ({
      start_time: numberOrNull(chapter?.start_time),
      end_time: numberOrNull(chapter?.end_time),
      title: chapter?.title || null,
    }))
    .filter((chapter) => chapter.title || chapter.start_time !== null || chapter.end_time !== null);
  return chapters.length ? chapters : null;
}

function compactThumbnails(value) {
  if (!Array.isArray(value)) return null;
  const thumbnails = value
    .filter((thumbnail) => thumbnail?.url)
    .map((thumbnail) => {
      const out = {
        url: thumbnail.url,
        width: numberOrNull(thumbnail.width),
        height: numberOrNull(thumbnail.height),
        id: thumbnail.id === undefined || thumbnail.id === null ? null : String(thumbnail.id),
        preference: numberOrNull(thumbnail.preference),
      };
      removeEmpty(out);
      return out;
    });
  return thumbnails.length ? thumbnails : null;
}

function removeEmpty(obj) {
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (value === undefined || value === null) delete obj[key];
    else if (Array.isArray(value) && value.length === 0) delete obj[key];
  }
}

function pushUnique(array, value) {
  if (value && !array.includes(value)) array.push(value);
}

function roundSeconds(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function roundMinutes(seconds) {
  return Math.round((Number(seconds || 0) / 60) * 100) / 100;
}

function finiteNumber(value) {
  return Number.isFinite(Number(value));
}

function cloneEvent(event) {
  return JSON.parse(JSON.stringify(event));
}

function fallbackEventKey(event) {
  return crypto.createHash("sha256").update(JSON.stringify(event)).digest("hex");
}

function removeUndefined(obj) {
  for (const key of Object.keys(obj)) {
    if (obj[key] === undefined) delete obj[key];
  }
}
