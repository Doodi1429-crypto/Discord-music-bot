# Discord Music Bot

## Render deployment

This repository has no Render blueprint or separate provider service. Keep the bot in
its existing single Render Node service; the PO-token provider runs as a managed local
child process inside that service.

In the existing service's **Settings → Build & Deploy**, use:

- **Build Command:** `npm install`
- **Start Command:** `npm start`

The checked-in `.node-version` selects Node.js 26.10.0. Keep the service's existing
Discord environment variables (`DISCORD_TOKEN`, `CLIENT_ID`, and optional `GUILD_ID`).
No second Render service, public provider port, personal YouTube account, cookies, or
manually copied PO token is required.

The `npm install` postinstall downloads standalone yt-dlp and the pinned upstream
bgutil-ytdlp-pot-provider 2.0.0 source/plugin. It installs the provider's locked Node
dependencies and pins the Axios override to 1.20.0, the first version reported as
patched by the GitHub Advisory Database. The normal `npm start` command starts the
provider before connecting the bot to Discord. The provider listens only on loopback
(`127.0.0.1`, port 4416 by default); its unauthenticated HTTP endpoint must not be
exposed through Render networking or a proxy.

## YouTube extraction

youtubei.js remains the primary resolver. When its resolution fails, the yt-dlp fallback
loads the upstream provider plugin explicitly and uses the local provider to generate
PO tokens automatically for the configured YouTube player/context. The default fallback
client is `mweb`; `YOUTUBE_DL_PLAYER_CLIENT` remains available to override it. The
existing `YOUTUBE_DL_PATH`, `YOUTUBE_DL_JS_RUNTIMES`, extractor/config options, and
`YOUTUBE_DL_DEBUG` diagnostics remain supported. The provider URL can only be configured
to a localhost/loopback HTTP address.

Supported provider settings:

- `YOUTUBE_DL_POT_PROVIDER_ENABLED`: defaults to `true`; set to `false` to disable the
  local provider and its default player-client selection.
- `YOUTUBE_DL_POT_PROVIDER_URL`: defaults to `http://127.0.0.1:4416`; accepts only a
  localhost/loopback HTTP URL and may be used to select another local port.
- `YOUTUBE_DL_PLAYER_CLIENT`: defaults to `mweb` while the provider is enabled; set to
  `none` to omit explicit client selection or set another yt-dlp client.

If provider startup fails, the bot still connects and logs a sanitized diagnostic; a
later yt-dlp extraction reports a sanitized provider error. The diagnostic includes a
capped, control-character-stripped tail of the provider child process's own stderr
(e.g. a bind failure or a crash during startup) so the underlying cause is visible
instead of only a generic "did not become ready" timeout. Check the Render build logs
for dependency-download/install failures and service logs for provider readiness.

PO tokens can help with YouTube bot checks, but YouTube may still reject requests due to
IP reputation, rate limits, or other restrictions. Playback is not guaranteed.

## Development

```sh
npm install
npm test
npm start
```

## AI assistant

AI chat is disabled by default. Set `AI_ENABLED=true` and provide `AI_API_KEY` to enable
the OpenAI-compatible provider. Users can explicitly trigger it with `/ai message` (or
mention the bot); `AI_TRIGGER` changes the prefix. `/ai reset` clears only that user's
temporary conversation in the current guild/channel. Context is bounded by
`AI_MAX_CONTEXT_MESSAGES` and is cleared when the process restarts.

Available AI settings are `AI_ENABLED`, `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`,
`AI_API_URL`, `AI_MAX_CONTEXT_MESSAGES`, `AI_MAX_RESPONSE_LENGTH`, `AI_SYSTEM_PROMPT`,
`AI_TIMEOUT_MS`, and `AI_TRIGGER`. See `.env.example`; credentials and conversations
are not logged.
