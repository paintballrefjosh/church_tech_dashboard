# Livestream checks

Is the church's stream live when it should be, and does it carry a moving picture and sound? The `/livestreams` page (Church
Apps menu) shows every stream as a tile, like a multiviewer: the latest still, a red tally while it is live, its loudness, and
any problem. A stream's page has the big picture, the sound meters (loudness, peak, left and right), the picture's size, frozen
and black time, its history, and "Check now".

Decided with Josh on 2026-10-25: the stream is read with **yt-dlp plus the platforms' APIs** (the APIs are optional), Resi takes
**a link plus the Go Live API**, and alerts go to **a group chosen per stream**. The church uses Resi and an ATEM switcher, so
the ATEM got its own monitor kind (below).

## How a stream is read

| Platform | Public | Private / unlisted | API (optional, Livestreams settings) |
|---|---|---|---|
| YouTube | the channel's `/live` page or a watch link, read by yt-dlp | an unlisted watch link (sign-in-only streams cannot be read) | Data API key: viewers and start time |
| Facebook | the page's live videos, by yt-dlp | no link exists: only "is it live" from the Graph API (page ID + page token) | page token: live and viewers |
| Resi | its HLS link (`.m3u8`): Resi's player has no page yt-dlp reads | the HLS link | client ID + secret: lists encoders to link a stream to one (read only) |
| BoxCast, Vimeo, Subsplash | the page, by yt-dlp, or an HLS link | the private link / HLS link | none |
| Twitch | the channel link, by yt-dlp | (Twitch streams are public) | client ID + secret: viewers |
| Other | any HLS (`.m3u8`) or DASH (`.mpd`) link: Dacast, StreamSpot, a website's player, an encoder's own output | the same with its token | none |

A **private link** is stored encrypted (`stream_url_enc`, `enc:v1:`), never returned (`hasStreamUrl`), and redacted from the
audit snapshot. The form sends `[saved]` (or nothing) to keep it and `null` to remove it.

## Two clocks per stream

- **Is it live** every `status_interval_sec` (30 s to 1 h, default 1 min): yt-dlp `-J` on the page (about 3 to 10 s for
  YouTube), or a GET of the playlist (live = it lists segments and has no `#EXT-X-ENDLIST`; DASH `type="dynamic"`; a 404/410 is
  "off", not an error).
- **Sound and picture** every `sample_interval_sec` (1 min to 1 h, default 5 min) while it is live: ffmpeg reads
  `sample_seconds` (5 to 30, default 10) of the 480p picture (or the nearest) and the best sound, through `freezedetect`,
  `blackdetect`, `ebur128` (integrated loudness, true peak), `silencedetect` and `astats` (per-channel RMS), and writes one still
  from the middle as a JPEG (about 15 KB, kept in `livestream_snapshots`, one row per stream). Reading a live playlist's backlog
  takes 1 to 2 seconds, not real time.
- **A bad sample is sampled again 30 s later** (`LIVESTREAM_LIMITS.confirmAfterSec`), and only a problem BOTH show is
  reported. A pause between songs is not "no sound": silence, freeze and black must cover 80% of the sample.

## Problems and alerts

`confirmedProblems` (pure, in `packages/shared/src/schemas/livestream.ts`) decides:

- `not_live`: only with a schedule (`Sun 10:15-12:15; Wed 19:00-20:30`, the monitor schedule format, site time zone), inside a
  window, past `grace_min` minutes, on two checks in a row. With no schedule a stream is never "should be live".
- `no_video`, `no_audio`, `silent` (loudness at or below `silence_db` + 3 with a quiet peak, or silent 80% of the time),
  `frozen`, `black` (when `check_video` is on): two samples in a row.
- `unreachable`: three failed reads in a row.
- `one_channel` (one side silent, the other not) is shown on the page but never alerted: a panned mono feed is common.

Outside its hours nothing is read and nothing is wrong; an alert still open is closed without a "back" notice (like monitors).

**Alerts** (kind `livestream.problem`, an outage alert kind, urgent: it gets through quiet hours and to alert channels) go to the
members of the stream's `alert_group_id`, else to Monitoring's usual recipients. The marker of what was announced is
`alerted_problem` (`alertMarker`: the alert problems, sorted); a change is CLAIMED by one conditional UPDATE on it before
sending, so two nodes never both announce. A new set of problems is announced again; their end is announced as
"<name> is back". Maintenance mode silences the notices (the marker still moves).

## Where it runs

In the **API**, not the probe worker: the worker has no `AUTH_SECRET` (it cannot read a private link) and no
NotificationsService. The `livestream-checks` cluster job ticks every 10 s on the job's leader, starts every due stream
(at most 6 reads at once, `livestreams.max_concurrent_samples` ffmpeg samples, 1 to 4, default 2), and CLAIMS each stream with
`claimed_until` (240 s, database clock) first, so "Check now" on another node or a new leader never reads it twice at once.
`livestream-prune` removes history older than 30 days.

**The programs** (`livestream-reader.ts`): yt-dlp and ffmpeg run as child processes with an argument array (never a shell), an
empty environment (`PATH`, `HOME=/tmp`), a time limit (yt-dlp 90 s, ffmpeg 4 x the sample + 45 s) and a cap on what they print.
ffmpeg may only use `http,https,tls,tcp,crypto` (never `file:`), and its error line has addresses replaced before it is shown
(a token can be in them). The image carries `ffmpeg` and `python3` from Alpine and yt-dlp **pinned by hash** in a venv at
`/opt/ytdlp` (`apps/api/livestream-tools.txt`: yt-dlp 2026.8.19, yt-dlp-ejs 0.8.0; yt-dlp needs `--js-runtimes node` for YouTube).
That adds about 200 MB to the API image. **YouTube changes its pages often**: when the checks start saying the page cannot be
read, update the pin (two-week rule).

**Addresses** (`streamUrlProblem`, `assertFetchableHost`): http(s) only, no user name or password, never loopback, link-local
(cloud metadata) or "any", after DNS too and on every redirect (at most 3), and never a one-word host name (`api`,
`meilisearch`: the stack's own containers). Private LAN ranges ARE allowed, because an encoder's own HLS output lives there.
What remains: a moderator can make the server GET an address on the LAN and learn whether it answers like a playlist (no body is
ever shown), and segment URLs inside a playlist are fetched by ffmpeg without the DNS check. Both need the Livestreams moderator
tier.

## The ATEM switcher (a monitor kind)

`atem` in `MONITOR_KINDS`, `probeAtem` in `services/monitor/src/av-probes.ts`: UDP 9910, the protocol from Sofie's
atem-connection (MIT; the library itself was too heavy: native freetype and threadedclass). The probe says hello, acknowledges
each packet in order (the switcher stops sending otherwise), reads the state dump until `InCm`, and leaves. It reads `_pin`
(model), `InPr` (input names), `PrgI` (program input per M/E), `StRS`/`SRSS`/`SRSU` (streaming status, bitrate, service name),
`RTMS` (recording status, disk problems, time left). **The stream key arrives in `SRSU` and is never read.** Nothing is ever
sent that changes the switcher. Options: `expectStreaming`, `expectRecording`. A switcher has only a few client slots
(Companion, ATEM Software Control and this each take one; ours lasts a second and the switcher drops it), so check once a
minute or less often. A stream's page shows the linked monitor (`encoder_monitor_id`: an ATEM, OBS, HyperDeck or HLS monitor).

## Access

Module `livestreams`: user = `livestreams:read:any` (see the wall, a stream's page, its picture and history), moderator =
`livestreams:write:any` (add, edit, check now, the group and monitor pickers, Resi's encoder list), admin = `livestreams:admin`
(delete, the `livestreams` settings category with the API keys and the key tests). Migration 0084 grants by the tiers groups
already hold: the `user` group gets user; any other group that moderates Monitoring or Checklists gets moderator; any other
group with Monitoring gets user.

## Tables and the rest

- `livestreams` (settings + the checker's readings, all volatile in the backup registry, `stream_url_enc` sensitive),
  `livestream_snapshots` and `livestream_checks` (`skip`: a picture and history are remade). Backup section "Livestreams".
- MCP: `livestreams_list`, `livestreams_get`, `livestreams_get_history` (read only); create/edit/delete, check now, the
  picture, the pickers and the key tests are excluded (`route-rules.ts`).
- Tests: `apps/api/test/livestreams.test.ts` (the rules against ffmpeg output captured from a real YouTube stream and from
  generated frozen/silent, no-sound and left-only streams in `test/fixtures/livestreams/`; the ATEM readers and the probe
  against a fake switcher), `livestreams.integration.test.ts` (claims, confirmation, alerts once, outside hours, encryption,
  prune; CockroachDB and YugabyteDB), smoke `tests/smoke/livestreams.mjs` (never reads a stream), e2e `livestreams.spec.ts`.

## Not verified / not built

- **Resi**: the token and encoder-list calls follow Bitfocus Companion's Resi module; what an encoder's status fields are
  called is not known, so the page shows whatever status-like fields come back. Needs a run against the church's account.
- Facebook and Twitch calls follow their documentation and were not run against a real account; YouTube through yt-dlp was run
  against a real live stream.
- A private Facebook stream gets "is it live" only (Facebook gives no link to read).
- ATEM was tested against a fake switcher, not a real one. ATEM over the internet (no UDP), vMix, Sennheiser: not built.
- Starting, stopping or changing a stream anywhere: never (read only by design).
