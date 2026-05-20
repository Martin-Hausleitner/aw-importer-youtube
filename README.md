# aw-importer-youtube

High-quality local YouTube watch-session importer for ActivityWatch.

It turns noisy local signals into one clean ActivityWatch session per watch:

- ActivityWatch browser/window events
- Chromium-style browser history from Chrome, Brave, Comet, and Opera
- local Google Takeout `youtube-watch-history.json` files, when present
- public YouTube metadata via `yt-dlp` for title, description, channel, thumbnail, and video duration

The importer never modifies the original ActivityWatch watcher buckets. It writes merged sessions to:

```text
aw-import-youtube-watch-sessions_<hostname>
```

## Quickstart

```bash
git clone https://github.com/<owner>/aw-importer-youtube.git
cd aw-importer-youtube
npm test
cp config.example.json aw-importer-youtube.config.json
node src/cli.mjs doctor --config aw-importer-youtube.config.json
node src/cli.mjs sync --config aw-importer-youtube.config.json --dry-run
node src/cli.mjs sync --config aw-importer-youtube.config.json
```

`aw-importer-youtube.config.json` is ignored by git because it may contain private local paths.

## Configuration

Start from `config.example.json`:

```json
{
  "baseUrl": "http://127.0.0.1:5600/api/0",
  "lookbackDays": 14,
  "metadata": true,
  "metadataLimit": 20,
  "privacy": {
    "description": true,
    "tags": true,
    "stats": true,
    "thumbnails": true
  }
}
```

Useful privacy switches:

```bash
node src/cli.mjs sync --minimal-metadata
node src/cli.mjs sync --no-description --no-tags --no-stats --no-thumbnails
```

## Commands

```bash
npm test
npm run doctor -- --config aw-importer-youtube.config.json
npm run sync -- --config aw-importer-youtube.config.json --dry-run
npm run sync -- --config aw-importer-youtube.config.json
npm run backfill -- --config aw-importer-youtube.config.json --days 365 --dry-run
npm run backfill -- --config aw-importer-youtube.config.json --days 365 --confirm
npm run install-service -- --config aw-importer-youtube.config.json --dry-run
npm run install-service -- --config aw-importer-youtube.config.json
```

Useful CLI options:

```text
--config PATH      Read JSON config
--lookback-days N  Import the last N days
--days N           Alias for --lookback-days, useful with backfill
--since ISO        Import from an explicit timestamp
--metadata-limit N Fetch metadata for up to N uncached videos per run
--minimal-metadata Store only core identity and timing fields
--dry-run          Build sessions and report counts without ActivityWatch writes
--confirm          Required for writing backfills
```

## Health Check

`doctor` checks that ActivityWatch is reachable, required local tools exist, and readable browser/Takeout sources can be found:

```bash
node src/cli.mjs doctor --config aw-importer-youtube.config.json
```

The command exits non-zero if an essential check fails.

## Backfill

Use `backfill` for historical imports. It requires `--dry-run` or `--confirm` so a large write cannot happen by accident.

```bash
node src/cli.mjs backfill --config aw-importer-youtube.config.json --days 365 --dry-run
node src/cli.mjs backfill --config aw-importer-youtube.config.json --days 365 --confirm
```

Every run writes a JSON report to:

```text
~/Library/Application Support/aw-importer-youtube/state.json
```

The report includes source counts, inserted/replaced counts, metadata settings, and quality metrics such as sessions with URL, video ID, channel, description, and total watch minutes.

## Autostart

Install or update the macOS LaunchAgent:

```bash
node src/cli.mjs install-service --config aw-importer-youtube.config.json
```

It runs on login/load and every 60 seconds by default. Check it with:

```bash
launchctl print gui/$(id -u)/io.activitywatch.aw-importer-youtube
```

Logs:

```text
~/Library/Logs/aw-importer-youtube/launchd.out.log
~/Library/Logs/aw-importer-youtube/launchd.err.log
```

A plist template is also included at `launchd/io.activitywatch.aw-importer-youtube.plist.example` for manual installs.

## Agent Skill

This repo includes a Codex/Hermes-compatible skill at:

```text
skills/aw-importer-youtube/SKILL.md
```

Install it for an agent by copying or symlinking the folder into the agent skills directory:

```bash
mkdir -p ~/.codex/skills
ln -s "$PWD/skills/aw-importer-youtube" ~/.codex/skills/aw-importer-youtube
```

Restart the agent so it discovers the skill. After that, prompts like “install aw-importer-youtube”, “run a YouTube backfill”, or “debug the ActivityWatch YouTube importer” should trigger the skill.

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

## Private Data

Do not commit local config, logs, state files, metadata cache, ActivityWatch exports, browser history databases, or Google Takeout files. These can contain private watch-history data.
