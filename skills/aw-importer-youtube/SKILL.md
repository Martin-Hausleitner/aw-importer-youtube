---
name: aw-importer-youtube
description: Use when installing, configuring, testing, backfilling, or troubleshooting aw-importer-youtube, the ActivityWatch importer for local YouTube watch sessions.
---

# aw-importer-youtube

Use this skill when the user wants an agent to set up or operate `aw-importer-youtube`.

## Workflow

1. Check out the repo and run `npm test`.
2. Copy `config.example.json` to `aw-importer-youtube.config.json` and adjust only user-specific paths or privacy settings.
3. Run `node src/cli.mjs doctor --config aw-importer-youtube.config.json`.
4. Run a dry sync: `node src/cli.mjs sync --config aw-importer-youtube.config.json --dry-run`.
5. For historical import, run `node src/cli.mjs backfill --config aw-importer-youtube.config.json --days 365 --dry-run` first, then repeat with `--confirm`.
6. For autostart on macOS, run `node src/cli.mjs install-service --config aw-importer-youtube.config.json`.

## Guardrails

- Do not commit `aw-importer-youtube.config.json`, logs, state, metadata cache, ActivityWatch exports, browser history databases, or Google Takeout data.
- Keep `config.example.json` generic. Use `~` placeholders instead of absolute personal paths.
- Prefer `doctor` and `--dry-run` before writing ActivityWatch events.
- If tests or privacy scans fail, fix them before pushing.

## Useful Commands

```bash
npm test
node src/cli.mjs doctor --config aw-importer-youtube.config.json
node src/cli.mjs sync --config aw-importer-youtube.config.json --dry-run
node src/cli.mjs sync --config aw-importer-youtube.config.json
node src/cli.mjs backfill --config aw-importer-youtube.config.json --days 365 --dry-run
node src/cli.mjs backfill --config aw-importer-youtube.config.json --days 365 --confirm
node src/cli.mjs install-service --config aw-importer-youtube.config.json
```
