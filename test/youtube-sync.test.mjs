import assert from "node:assert/strict";
import test from "node:test";

import {
  applyVideoMetadata,
  buildWatchSessions,
  chromeTimeToIso,
  dedupeEvents,
  shouldReplaceExistingSession,
  eventFromActivityWatch,
  eventFromChromeHistoryRow,
  eventFromTakeoutEntry,
  extractYouTubeVideoId,
  normalizeVideoMetadata,
  normalizeYouTubeTitle,
  parseYouTubeStartSeconds,
} from "../src/youtube-sync.mjs";

test("extractYouTubeVideoId handles common YouTube URL shapes", () => {
  assert.equal(extractYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=12s"), "dQw4w9WgXcQ");
  assert.equal(extractYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ?si=abc"), "dQw4w9WgXcQ");
  assert.equal(extractYouTubeVideoId("https://www.youtube.com/shorts/abcDEF12345"), "abcDEF12345");
  assert.equal(extractYouTubeVideoId("https://music.youtube.com/watch?v=xyz98765432"), "xyz98765432");
  assert.equal(extractYouTubeVideoId("https://www.youtube.com/feed/history"), null);
});

test("parseYouTubeStartSeconds reads YouTube t/start parameters", () => {
  assert.equal(parseYouTubeStartSeconds("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1h2m3s"), 3723);
  assert.equal(parseYouTubeStartSeconds("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90"), 90);
  assert.equal(parseYouTubeStartSeconds("https://youtu.be/dQw4w9WgXcQ?start=45"), 45);
  assert.equal(parseYouTubeStartSeconds("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), null);
});

test("normalizeYouTubeTitle strips browser suffixes without losing the watched title", () => {
  assert.equal(normalizeYouTubeTitle("Tiny Desk Concert - YouTube"), "Tiny Desk Concert");
  assert.equal(normalizeYouTubeTitle("YouTube"), null);
  assert.equal(normalizeYouTubeTitle("YouTube - Google Chrome"), null);
  assert.equal(normalizeYouTubeTitle("lofi beats - YouTube - Google Chrome"), "lofi beats");
});

test("eventFromActivityWatch converts browser YouTube watch events into media events", () => {
  const event = eventFromActivityWatch("aw-watcher-web-chrome_host", {
    timestamp: "2026-05-20T12:00:00.000000+00:00",
    duration: 42.4,
    data: {
      title: "A Useful Video - YouTube",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      audible: true,
    },
  });

  assert.deepEqual(event, {
    timestamp: "2026-05-20T12:00:00.000000+00:00",
    duration: 42.4,
    data: {
      source: "activitywatch",
      source_bucket: "aw-watcher-web-chrome_host",
      source_app: "chrome",
      title: "A Useful Video",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      video_id: "dQw4w9WgXcQ",
      audible: true,
      sync_key: "activitywatch|aw-watcher-web-chrome_host|2026-05-20T12:00:00.000000+00:00|42.4|dQw4w9WgXcQ|A Useful Video",
    },
  });
});

test("eventFromActivityWatch also captures YouTube app/window title events", () => {
  const event = eventFromActivityWatch("aw-watcher-window_host", {
    timestamp: "2026-05-20T12:05:00+00:00",
    duration: 12,
    data: {
      app: "YouTube",
      title: "Standalone App Video - YouTube",
    },
  });

  assert.equal(event.data.title, "Standalone App Video");
  assert.equal(event.data.source_app, "YouTube");
  assert.equal(event.data.video_id, null);
});

test("eventFromActivityWatch captures browser window YouTube titles when web watcher is paused", () => {
  const event = eventFromActivityWatch("aw-watcher-window_host", {
    timestamp: "2026-05-20T14:10:17.369000+00:00",
    duration: 21.37,
    data: {
      app: "Google Chrome",
      url: "",
      title: "Me at the zoo - YouTube - Google Chrome",
    },
  });

  assert.equal(event.data.title, "Me at the zoo");
  assert.equal(event.data.source_app, "Google Chrome");
  assert.equal(event.data.video_id, null);
});

test("chromeTimeToIso converts Chrome's WebKit timestamp", () => {
  assert.equal(chromeTimeToIso(0), "1601-01-01T00:00:00.000Z");
  assert.equal(chromeTimeToIso(13217453900000000), "2019-11-05T18:58:20.000Z");
});

test("eventFromChromeHistoryRow imports recent YouTube history as a marker event", () => {
  const event = eventFromChromeHistoryRow({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    title: "History Video - YouTube",
    last_visit_time: "13217453900000000",
    profile: "Chrome/Profile 2",
  });

  assert.equal(event.timestamp, "2019-11-05T18:58:20.000Z");
  assert.equal(event.duration, 1);
  assert.equal(event.data.source, "chrome_history");
  assert.equal(event.data.source_app, "Google Chrome");
  assert.equal(event.data.title, "History Video");
});

test("eventFromChromeHistoryRow keeps Comet history separate from Chrome", () => {
  const event = eventFromChromeHistoryRow({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    title: "Comet Video - YouTube",
    last_visit_time: "13217453900000000",
    profile: "Comet/Default",
  });

  assert.equal(event.data.source_app, "Comet");
  assert.equal(event.data.source_profile, "Comet/Default");
});

test("eventFromTakeoutEntry converts Google Takeout watch history entries", () => {
  const event = eventFromTakeoutEntry({
    title: "Watched Takeout Video",
    titleUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    time: "2026-05-10T17:29:29.000Z",
    subtitles: [{ name: "Example Channel" }],
  });

  assert.equal(event.timestamp, "2026-05-10T17:29:29.000Z");
  assert.equal(event.duration, 1);
  assert.equal(event.data.source, "google_takeout");
  assert.equal(event.data.channel, "Example Channel");
});

test("dedupeEvents removes events with the same sync key", () => {
  const events = [
    { data: { sync_key: "a" }, timestamp: "1" },
    { data: { sync_key: "a" }, timestamp: "2" },
    { data: { sync_key: "b" }, timestamp: "3" },
  ];

  assert.deepEqual(dedupeEvents(events), [events[0], events[2]]);
});

test("buildWatchSessions retrospectively matches window title events to browser history metadata", () => {
  const windowOne = eventFromActivityWatch("aw-watcher-window_host", {
    timestamp: "2026-05-20T14:10:08.000Z",
    duration: 2.5,
    data: { app: "Google Chrome", url: "", title: "Me at the zoo - YouTube - Google Chrome" },
  });
  const windowTwo = eventFromActivityWatch("aw-watcher-window_host", {
    timestamp: "2026-05-20T14:10:17.000Z",
    duration: 21.5,
    data: { app: "Google Chrome", url: "", title: "Me at the zoo - YouTube - Google Chrome" },
  });
  const history = {
    timestamp: "2026-05-20T14:10:35.000Z",
    duration: 1,
    data: {
      source: "chrome_history",
      source_profile: "Google/Chrome/Profile 2",
      title: "Me at the zoo",
      url: "https://www.youtube.com/watch?v=jNQXAC9IVRw&t=12s",
      video_id: "jNQXAC9IVRw",
      sync_key: "history",
    },
  };

  const sessions = buildWatchSessions([windowTwo, history, windowOne]);

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].timestamp, "2026-05-20T14:10:08.000Z");
  assert.equal(sessions[0].duration, 24);
  assert.equal(sessions[0].data.video_id, "jNQXAC9IVRw");
  assert.equal(sessions[0].data.url, "https://www.youtube.com/watch?v=jNQXAC9IVRw&t=12s");
  assert.equal(sessions[0].data.title, "Me at the zoo");
  assert.equal(sessions[0].data.watch_seconds, 24);
  assert.equal(sessions[0].data.watch_minutes, 0.4);
  assert.equal(sessions[0].data.playback_start_seconds, 12);
  assert.deepEqual(sessions[0].data.sources.sort(), ["activitywatch", "chrome_history"]);
});

test("normalizeVideoMetadata keeps rich yt-dlp fields in a compact stable shape", () => {
  const metadata = normalizeVideoMetadata({
    id: "jNQXAC9IVRw",
    title: "Me at the zoo",
    description: "The first video on YouTube.",
    duration: 19,
    channel: "jawed",
    channel_id: "UC4QobU6STFB0P71PMvOGN5A",
    channel_url: "https://www.youtube.com/channel/UC4QobU6STFB0P71PMvOGN5A",
    uploader: "jawed",
    uploader_id: "@jawed",
    uploader_url: "https://www.youtube.com/@jawed",
    webpage_url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    original_url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    thumbnail: "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg",
    thumbnails: [
      { url: "https://i.ytimg.com/vi/jNQXAC9IVRw/1.jpg", width: 120, height: 90, id: "1" },
      { url: null },
    ],
    upload_date: "20050424",
    timestamp: 1114313512,
    view_count: 391829115,
    like_count: 18870286,
    comment_count: 10000000,
    age_limit: 0,
    availability: "public",
    live_status: "not_live",
    was_live: false,
    is_live: false,
    categories: ["Film & Animation"],
    tags: ["me at the zoo", "jawed karim"],
    language: "en",
    chapters: [
      { start_time: 0, end_time: 5, title: "Intro" },
      { start_time: 5, end_time: 19, title: "The cool thing" },
    ],
    subtitles: { en: [{}], de: [{}] },
    automatic_captions: { en: [{}], fr: [{}] },
    extractor: "youtube",
    extractor_key: "Youtube",
  });

  assert.equal(metadata.metadata_schema_version, 2);
  assert.equal(metadata.view_count, 391829115);
  assert.equal(metadata.like_count, 18870286);
  assert.equal(metadata.comment_count, 10000000);
  assert.equal(metadata.upload_date, "2005-04-24");
  assert.equal(metadata.upload_timestamp, 1114313512);
  assert.equal(metadata.channel_id, "UC4QobU6STFB0P71PMvOGN5A");
  assert.equal(metadata.uploader_id, "@jawed");
  assert.deepEqual(metadata.categories, ["Film & Animation"]);
  assert.deepEqual(metadata.tags, ["me at the zoo", "jawed karim"]);
  assert.deepEqual(metadata.subtitle_languages, ["de", "en"]);
  assert.deepEqual(metadata.automatic_caption_languages, ["en", "fr"]);
  assert.deepEqual(metadata.chapters[0], { start_time: 0, end_time: 5, title: "Intro" });
  assert.deepEqual(metadata.thumbnails, [
    { url: "https://i.ytimg.com/vi/jNQXAC9IVRw/1.jpg", width: 120, height: 90, id: "1" },
  ]);
});

test("applyVideoMetadata attaches rich video, channel, stats, captions, and duration fields", () => {
  const session = {
    timestamp: "2026-05-20T14:10:08.000Z",
    duration: 24,
    data: {
      title: "Me at the zoo",
      video_id: "jNQXAC9IVRw",
      url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
      sync_key: "session",
    },
  };

  const enriched = applyVideoMetadata(session, {
    id: "jNQXAC9IVRw",
    title: "Me at the zoo",
    description: "The first video on YouTube.",
    duration: 19,
    channel: "jawed",
    channel_id: "UC4QobU6STFB0P71PMvOGN5A",
    channel_url: "https://www.youtube.com/channel/UC4QobU6STFB0P71PMvOGN5A",
    uploader: "jawed",
    uploader_id: "@jawed",
    uploader_url: "https://www.youtube.com/@jawed",
    webpage_url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    original_url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    thumbnail: "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg",
    view_count: 391829115,
    like_count: 18870286,
    comment_count: 10000000,
    upload_date: "2005-04-24",
    upload_timestamp: 1114313512,
    age_limit: 0,
    availability: "public",
    live_status: "not_live",
    was_live: false,
    is_live: false,
    categories: ["Film & Animation"],
    tags: ["me at the zoo", "jawed karim"],
    language: "en",
    chapters: [{ start_time: 0, end_time: 5, title: "Intro" }],
    subtitle_languages: ["en", "de"],
    automatic_caption_languages: ["en"],
    metadata_extractor: "youtube",
    metadata_extractor_key: "Youtube",
  });

  assert.equal(enriched.data.description, "The first video on YouTube.");
  assert.equal(enriched.data.channel, "jawed");
  assert.equal(enriched.data.channel_id, "UC4QobU6STFB0P71PMvOGN5A");
  assert.equal(enriched.data.uploader_id, "@jawed");
  assert.equal(enriched.data.view_count, 391829115);
  assert.equal(enriched.data.like_count, 18870286);
  assert.equal(enriched.data.comment_count, 10000000);
  assert.equal(enriched.data.upload_date, "2005-04-24");
  assert.deepEqual(enriched.data.categories, ["Film & Animation"]);
  assert.deepEqual(enriched.data.tags, ["me at the zoo", "jawed karim"]);
  assert.deepEqual(enriched.data.subtitle_languages, ["en", "de"]);
  assert.deepEqual(enriched.data.chapters, [{ start_time: 0, end_time: 5, title: "Intro" }]);
  assert.equal(enriched.data.video_duration_seconds, 19);
  assert.equal(enriched.data.video_duration_minutes, 0.32);
});

test("buildWatchSessions keeps point-only watch records as one-second marker sessions", () => {
  const point = eventFromActivityWatch("aw-watcher-web-chrome_host", {
    timestamp: "2026-05-20T14:00:00.000Z",
    duration: 0,
    data: {
      title: "Point Event - YouTube",
      url: "https://www.youtube.com/watch?v=abcDEF12345",
    },
  });

  const [session] = buildWatchSessions([point]);

  assert.equal(session.duration, 1);
  assert.equal(session.data.watch_seconds, 1);
  assert.equal(session.data.watch_minutes, 0.02);
});

test("buildWatchSessions keeps sync keys stable as watch duration grows", () => {
  const short = buildWatchSessions([
    eventFromActivityWatch("aw-watcher-window_host", {
      timestamp: "2026-05-20T14:00:00.000Z",
      duration: 10,
      data: { app: "Google Chrome", url: "", title: "Growing Session - YouTube - Google Chrome" },
    }),
  ])[0];
  const longer = buildWatchSessions([
    eventFromActivityWatch("aw-watcher-window_host", {
      timestamp: "2026-05-20T14:00:00.000Z",
      duration: 35,
      data: { app: "Google Chrome", url: "", title: "Growing Session - YouTube - Google Chrome" },
    }),
  ])[0];

  assert.equal(short.data.sync_key, longer.data.sync_key);
  assert.equal(shouldReplaceExistingSession(short, longer), true);
});

test("shouldReplaceExistingSession upgrades missing metadata", () => {
  const existing = {
    data: { sync_key: "same", watch_seconds: 12, title: "Video", url: null, description: null },
  };
  const next = {
    data: { sync_key: "same", watch_seconds: 12, title: "Video", url: "https://www.youtube.com/watch?v=abcDEF12345", description: "Details" },
  };

  assert.equal(shouldReplaceExistingSession(existing, next), true);
});
