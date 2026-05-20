# aw-importer-youtube

High-quality local YouTube watch-session importer for ActivityWatch.

It turns noisy local signals into one clean ActivityWatch session per watch:

- ActivityWatch browser/window events
- Chromium-style browser history from Chrome, Brave, Comet, and Opera
- local Google Takeout `youtube-watch-history.json` files, when present
- public YouTube metadata via `yt-dlp` for title, description, channel, thumbnail, and video duration

The importer never modifies the original ActivityWatch buckets. It writes to:

```text
aw-import-youtube-watch-sessions_<hostname>
```

## What Gets Stored

Each synced ActivityWatch event contains a compact, queryable data object:

- `title`, `url`, `video_id`, `description`
- `channel`, `channel_id`, `channel_url`, `uploader`, `uploader_id`, `uploader_url`
- `view_count`, `like_count`, `comment_count`, `average_rating`
- `upload_date`, `upload_timestamp`, `age_limit`, `availability`, `live_status`
- `categories`, `tags`, `language`, `chapters`
- `thumbnail`, `thumbnails`, `subtitle_languages`, `automatic_caption_languages`
- `video_duration_seconds`, `video_duration_minutes`
- `watch_seconds`, `watch_minutes`
- `playback_start_seconds`, when the URL has `t=` or `start=`
- `started_at`, `ended_at`, `event_count`
- `sources`, `source_buckets`, `source_apps`, `source_profiles`
- `matched_by` and `sync_key` for auditability and deduplication

If ActivityWatch only provides a browser window title and no URL, the importer only attaches a URL/video ID when it can match it confidently against local browser history or Takeout data. It does not guess via YouTube search.

## How Matching Works

1. Read local ActivityWatch web/window events for YouTube.
2. Read local browser history and Takeout watch-history markers.
3. Match title-only ActivityWatch events to nearby history/Takeout records by normalized title and timestamp proximity.
4. Merge adjacent events for the same video into one watch session.
5. Enrich known video IDs with public metadata from `yt-dlp`.
6. Insert only sessions whose `sync_key` is not already in the destination bucket.
7. Replace existing sessions when a live watch session grew longer or when better metadata became available.

The `sync_key` is stable for a session and does not include the current watch duration. This matters for live sync: a running video should update the same logical session, not create a duplicate every time ActivityWatch reports more seconds.

## Commands

```bash
npm test
node src/cli.mjs --lookback-days 14 --dry-run --no-metadata
node src/cli.mjs --lookback-days 14 --metadata-limit 20
```

Useful options:

```text
--lookback-days N   Import the last N days
--since ISO         Import from an explicit timestamp
--metadata-limit N  Fetch metadata for up to N uncached videos per run
--no-metadata       Skip yt-dlp enrichment
--dry-run           Build sessions and report counts without ActivityWatch writes
```

## Autostart

An example macOS LaunchAgent template is included at:

```text
launchd/io.activitywatch.aw-importer-youtube.plist.example
```

Copy it to `~/Library/LaunchAgents/io.activitywatch.aw-importer-youtube.plist`, replace `__PROJECT_DIR__`, `__NODE_BIN__`, and `__HOME__`, then load it with `launchctl`.

It runs on login/load and every 60 seconds. Check it with:

```bash
launchctl print gui/$(id -u)/io.activitywatch.aw-importer-youtube
```

Logs:

```text
~/Library/Logs/aw-importer-youtube/launchd.out.log
~/Library/Logs/aw-importer-youtube/launchd.err.log
```

Runtime state and metadata cache:

```text
~/Library/Application Support/aw-importer-youtube/
```

These files can contain private watch-history data and are intentionally not committed.
