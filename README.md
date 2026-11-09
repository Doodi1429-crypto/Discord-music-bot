# Discord Music Bot

## Hosting (read this first)

A Discord bot keeps an **outbound** WebSocket open to Discord. Render's free tier only supports
*web services*, which are spun down after ~15 minutes without **inbound** HTTP traffic, and
outbound connections or "messages to itself" do not count. So **free Render cannot run this bot
24/7**, and no code can change that. HTTP self-pings are deliberately not used.

The correct setup is a **Background Worker** (no port, never spun down for idleness). Render
Background Workers are paid-only (cheapest: **Starter**). `render.yaml` defines exactly that.
Alternatives with the same requirement: any always-on VPS/container host.

### Deploy (manual; nothing deploys automatically)

1. Render Dashboard → **New → Blueprint** → select this repository (or **New → Background Worker**
   with Build `npm ci`, Start `npm start`). If you already have a *Web Service* for the bot,
   create the worker and delete/suspend the web service so two bots never run at once.
2. Set the secret environment variables (`DISCORD_TOKEN`, `CLIENT_ID`, optional `GUILD_ID`).
3. Deploy. Slash commands register automatically on startup (`REGISTER_COMMANDS=false` disables
   this; `npm run deploy-commands` registers manually). Using `GUILD_ID` makes them appear instantly;
   global commands can take up to an hour.
4. In the Discord Developer Portal enable the **Message Content** intent only if you use the AI
   chat feature; music needs just Guilds + Voice States. Invite with the `bot` and
   `applications.commands` scopes and Connect/Speak/Send Messages/Embed Links permissions.

The `.node-version` file selects the Node.js version. `npm install` downloads standalone yt-dlp and
the pinned bgutil PO-token provider, which runs as a loopback-only child process (port 4416; never
expose it publicly).

### Keep-alive, health and recovery

- A heartbeat runs every 10 minutes (`HEARTBEAT_INTERVAL_MS`) and logs gateway status, ping, uptime,
  guild count, voice connections and memory. If the gateway is not READY for 2 consecutive beats
  the process exits non-zero so Render restarts the worker.
- `/health` (needs *Manage Server*) shows the same snapshot inside Discord.
- Voice: duplicate connections are prevented, failed joins log the exact cause (Signalling stuck,
  WSS blocked, UDP handshake blocked, DAVE 4017, kicked 4014...), network drops are rejoined with
  backoff (5 attempts), and a bot that is moved is followed. The bot leaves an empty channel after
  `IDLE_LEAVE_MINUTES`.
- SIGTERM/SIGINT shut down gracefully; unhandled rejections are logged, uncaught exceptions restart
  the process. A PID lock file stops a second copy on the same machine (it cannot see other hosts).

## Music

Commands: `/play /pause /resume /skip /stop /queue /nowplaying /leave /volume /remove /clear
/shuffle /loop /help` (plus `/join` and `/health`). `/play` accepts YouTube/SoundCloud URLs,
YouTube/SoundCloud playlists (first 25 tracks), direct audio URLs, or a search; the optional
`source` choice picks YouTube or SoundCloud (default: YouTube, then SoundCloud if YouTube fails).
URLs are checked so loopback/private/link-local addresses are refused. ffmpeg only accepts
http(s) inputs.

Voice requires `@discordjs/voice` >= 0.19 and `@snazzah/davey` (Discord's mandatory DAVE end-to-end
encryption; older versions are rejected with close code 4017).

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
the Gemini provider. It uses Google's OpenAI-compatible chat-completions endpoint
(`https://generativelanguage.googleapis.com/v1beta/openai/`) and defaults to
`gemini-3.6-flash`. The model is available through the Gemini API free tier according to
Google's pricing documentation. To use OpenAI instead, set `AI_PROVIDER=openai`; its
existing defaults remain `gpt-4o-mini` and
`https://api.openai.com/v1/chat/completions`.

Users can trigger AI with `!ai message` (the legacy `/ai message` prefix also works) or
mention the bot; `AI_TRIGGER` changes the configured prefix. `!ai reset` or `/ai reset`
clears only that user's temporary conversation in the current guild/channel. Context is
bounded by `AI_MAX_CONTEXT_MESSAGES` and is cleared when the process restarts. Every
message, including follow-ups, must use a trigger; `/ai` is a text prefix, not a slash
command. Direct messages also require a trigger.

Requests in the same conversation are processed in order, and failed or undelivered
responses are not saved to history. `AI_MAX_CONTEXT_BYTES` (default 64000) limits the
UTF-8 size of the system prompt, history and current question; older complete turns are
removed first. This is a conservative size guard, not a model-specific token count.
The provider can still reject requests that exceed its model's token limits. The default
request timeout is 60 seconds; `AI_TIMEOUT_MS` can be adjusted for slower models.
Provider errors are logged with status and structured error codes, while Discord delivery
errors include the processing stage and error code. Check the configured model and API
key, provider quota, Message Content intent, and channel permissions if requests fail.

Available AI settings are `AI_ENABLED`, `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`,
`AI_API_URL`, `AI_MAX_CONTEXT_MESSAGES`, `AI_MAX_CONTEXT_BYTES`, `AI_MAX_RESPONSE_LENGTH`, `AI_SYSTEM_PROMPT`,
`AI_TIMEOUT_MS`, and `AI_TRIGGER`. `AI_MODEL` and `AI_API_URL` override the defaults for
the selected provider. See `.env.example`; credentials and conversations are not logged.
