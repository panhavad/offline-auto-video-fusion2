# Offline Auto Video Fusion

Merge every video in a local folder into one file — entirely in the browser.
Nothing is uploaded, nothing is installed, and once the page has been loaded it keeps working
even when the server is gone.

![Offline Auto Video Fusion — main screen](docs/screenshots/01-app-overview.png)

## Contents

- [Quick start with Docker](#quick-start-with-docker)
- [Quick start without Docker](#quick-start-without-docker)
- [Using the app](#using-the-app)
- [Deployment](#deployment)
- [What it does](#what-it-does)
- [How it stays fast and light on memory](#how-it-stays-fast-and-light-on-memory)
- [Offline](#offline)
- [Browser support](#browser-support)
- [Project layout](#project-layout)

## Quick start with Docker

The app is a static bundle: the image builds it with Node and serves it with nginx. There is no
backend and no database — the container only hands out HTML, CSS, JS and the service worker.

```bash
docker compose up -d --build      # build the bundle and serve it
# open http://localhost:8080
docker compose logs -f app        # follow nginx logs
docker compose down               # stop and remove the container
```

Change the published port with `APP_PORT` (a `.env` file next to `docker-compose.yml` works too):

```bash
APP_PORT=3000 docker compose up -d --build     # http://localhost:3000
```

### Development container (hot reload)

```bash
docker compose --profile dev up dev            # Vite dev server on http://localhost:5173
```

The `dev` service bind-mounts the repository into the container, so edits on the host reload
instantly. `node_modules` stays inside the container (an anonymous volume shadows the host copy),
so a Windows/macOS host never leaks incompatible native binaries into the Linux image. Override the
port with `DEV_PORT`.

### What is in the image

| Stage | Base | Purpose |
| --- | --- | --- |
| `deps` | `node:22-alpine` | `npm ci` once, reused by the other stages |
| `dev` | `node:22-alpine` | Vite dev server, port 5173 |
| `build` | `node:22-alpine` | `npm run build` → `dist/` incl. the generated service worker |
| `runtime` | `nginx:1.27-alpine` | serves `dist/` on port 80, has a `HEALTHCHECK` |

The nginx config lives in [`docker/nginx.conf`](docker/nginx.conf). It caches `/assets/*` (content
hashed by Vite) for a year, forbids caching of `sw.js` and `index.html` so a new deploy is picked up
on the next reload, serves `manifest.webmanifest` with the right MIME type and gzips text assets.

Build or run the image without Compose:

```bash
docker build -t auto-video-fusion .
docker run --rm -p 8080:80 auto-video-fusion
```

## Quick start without Docker

```
npm install
npm run build     # bundles the app + generates the offline service worker
npm run preview   # serve dist/ at http://localhost:4173
```

For development: `npm run dev` (http://localhost:5173) and `npm run typecheck`.

## Using the app

Open the page in Chrome or Edge. The badge in the header tells you whether the offline cache is
ready; a second badge appears if the browser is missing a required capability.

**1 · Pick the source folder.** *Choose folder* opens the native directory picker; tick *Include
subfolders* to scan recursively. The files are read straight from disk — they are never uploaded,
copied or duplicated. Browsers without the File System Access API fall back to a multi-file picker
instead.

**2 · Configure the merge.** Every control applies to all clips and is remembered between sessions:

| Setting | Meaning |
| --- | --- |
| Orientation | Only clips matching *landscape* / *portrait* are merged (*any* disables the filter). Skipped clips still show up in the list. |
| Max length per clip | Longer clips are trimmed to this many seconds; `0` keeps the full length. |
| Title text / position / color / size / shadow | Text burned into every frame, at one of 9 positions. `\n` starts a second line. |
| Output resolution | *Auto* follows the first clip (capped at 1080p), or force 480p…2160p. |
| Frame rate | Upper limit — source frames are never duplicated to reach it. |
| Quality | Bitrate preset (high / medium / low). |
| Scaling | *Contain* letterboxes, *Cover* fills and crops the edges. |
| Keep audio | Re-encodes audio to AAC/Opus 48 kHz stereo, or drops it entirely. |
| Prefer GPU encoding | Requests a hardware encoder; falls back to software automatically. |

**3 · Review the clips.** Each clip is probed in a worker: resolution, orientation, duration, dates
and a decoded thumbnail. Sort by name, modified or created date (ascending/descending) — **the list
order is exactly the order in which clips are concatenated** — and untick anything you do not want.

![Clip list with thumbnails and metadata](docs/screenshots/02-clip-list.png)

**4 · Merge.** *Start merge* writes the result directly into the selected folder as
`merged-<date>-<time>.mp4` (or offers a download when the folder cannot be written to). The progress
panel shows percentage, current clip, ETA, elapsed time, encode speed, output size and a log;
*Cancel* stops and discards the partial file.

![Merge in progress with live ETA and encode speed](docs/screenshots/03-merge-progress.png)

When it is done, every merged clip is marked and *Open output* / *Download result* appear next to
the summary.

![Finished merge with the result ready to open or download](docs/screenshots/04-merge-complete.png)

The header toggle switches between the dark and the light theme; the choice is persisted along with
the other settings.

![Light theme](docs/screenshots/05-light-theme.png)

## Deployment

The build output in `dist/` is fully static — any web server or object storage works. The container
above is only a convenient, reproducible way to do it.

**Serve it from a secure context.** WebCodecs and the File System Access API are only available on
`https://` or on `http://localhost`. Testing on `http://localhost:8080` is fine; exposing the
container on a LAN IP over plain HTTP is not — put a TLS-terminating reverse proxy in front of it:

```nginx
server {
    listen 443 ssl;
    server_name fusion.example.com;
    ssl_certificate     /etc/letsencrypt/live/fusion.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/fusion.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Other notes:

- **Subfolders work.** Vite is configured with `base: './'`, so the bundle can be served from
  `https://example.com/tools/fusion/` without a rebuild.
- **Deploying a new version** only requires replacing the container or the files. `sw.js` and
  `index.html` are served with `no-cache`, so the next reload installs the new precache and drops
  the old one.
- **The container is stateless.** No volumes, no user data, nothing to back up — videos never leave
  the machine that runs the browser. It also runs read-only if you want:
  `docker run --read-only --tmpfs /var/cache/nginx --tmpfs /var/run -p 8080:80 auto-video-fusion`.
- **Static hosting** (GitHub Pages, S3, Netlify, …): upload `dist/` and make sure `sw.js` is not
  cached aggressively.

## What it does

- **Pick a local folder** with the File System Access API. The files are read straight from disk —
  they are never uploaded, copied or duplicated.
- **Merge all videos in that folder** into a single MP4, in the order you choose.
- **Orientation filter** (default *landscape*): clips that don't match are listed but ignored.
- **Per-clip length limit** (default *20 s*): longer clips are trimmed, `0` keeps the full length.
- **Title text burned into every frame**, with 9 positions (default *bottom right*) and a free
  colour (default *white*), an adjustable size and an optional shadow for legibility.
- **Sorting by name, modified date or created date**, ascending or descending. The list order is
  exactly the order in which the clips are concatenated.
- **Thumbnail preview per clip**: while a clip's metadata is read, one early frame is decoded in the
  worker and shown next to it in the list (rotation metadata applied, so portrait clips stand
  upright). Clips whose first frames cannot be decoded simply show a placeholder.
- **Progress bar with ETA**, live encode speed, output size, clip counter, and a cancel button.
- **The result is written directly into the selected folder** as `merged-<date>-<time>.mp4`
  (previous outputs are automatically ignored when the folder is scanned again).

## How it stays fast and light on memory

| Concern | Approach |
| --- | --- |
| GPU usage | Decoding and encoding run through **WebCodecs**, which uses the platform's hardware video engine. The encoder is configured with `prefer-hardware` when the browser reports that this configuration is supported, and falls back automatically otherwise. |
| Compositing | Frames are scaled, letterboxed/cropped and stamped with the title on a GPU-backed `OffscreenCanvas` inside a worker, so the UI thread never blocks. The title is rasterised **once** into a bitmap and then blitted per frame. |
| Memory | One clip is processed at a time, each frame is closed immediately after use, and every `add()` call is awaited so backpressure from the encoder and from the disk writer propagates all the way back into the read loop. The muxed file is streamed to disk in 8 MiB chunks through a `FileSystemWritableFileStream`, so a 2-hour output uses no more memory than a 2-second one. Browsers without the File System Access API stream into private browser storage instead, so the result never has to be assembled in RAM either. |
| Wasted work | Frames arriving faster than the target frame rate are dropped before they reach the compositor, and frames are never duplicated when a source runs slower. |

Codec selection tries AVC → HEVC → AV1 → VP9 and picks the first one the browser can encode at the
chosen resolution; audio is re-encoded to AAC (or Opus) at 48 kHz stereo. Clips without a usable
audio track — or with an audio track the browser refuses to decode — are padded with silence so the
merged timeline stays in sync.

### Mixed audio formats

You do not have to care about the channel layout or sample rate of the source clips. An encoder is
configured once from the first sample it receives and then rejects anything shaped differently
(*"Audio parameters must remain constant. Expected 1 channels at 48000 Hz, got 2 channels at
48000 Hz"*), which otherwise breaks as soon as a mono clip is followed by a stereo one.

[`src/lib/audio.ts`](src/lib/audio.ts) therefore converts **every** sample — decoded audio and
generated silence alike — to one canonical layout (48 kHz stereo) *before* it reaches the encoder:

* mono is duplicated to both channels, multi-channel layouts are folded down to the front pair;
* differing sample rates are resampled with interpolation that carries its phase and a small tail
  across buffer boundaries, so consecutive chunks join without clicks or drift;
* samples that already match are passed straight through, so the common case costs nothing.

Should anything about the audio still fail at runtime, the audio track is dropped and the merge
continues — a bad audio track never costs you the video.

## Offline

`npm run build` runs `scripts/build-sw.mjs`, which hashes every file in `dist/` and writes a
service worker that precaches all of them. Load the page once over HTTP(S); afterwards the shell,
the worker bundle and the codec logic are served from the cache. Verified by shutting the server
down completely and merging clips with the page still open (and after a reload).

The offline badge in the header shows whether the service worker is active.

## Browser support

| Feature | Requirement |
| --- | --- |
| Folder picking + writing the result into that folder | File System Access API — Chrome/Edge (Chromium) 86+ |
| Decoding/encoding | WebCodecs — Chrome/Edge 94+ |
| Fallback | Browsers without the File System Access API get a `webkitdirectory` file input; the merged file is streamed into private browser storage and then offered as a download. Browsers without WebCodecs cannot run the merge at all. |

The app must be served from a secure context (`https://` or `http://localhost`).

## Project layout

```
index.html                     UI markup
src/styles.css                 black & white theme
src/main.ts                    folder scanning, clip list, settings, progress UI
src/worker/pipeline.worker.ts  probing + the decode → composite → encode → mux pipeline
src/lib/audio.ts               normalizes any channel layout / sample rate to 48 kHz stereo
src/lib/                       formatting helpers and persisted settings
src/dev/test-media.ts          dev-only fixture generator (not part of the bundle)
scripts/build-sw.mjs           generates dist/sw.js with the precache manifest
Dockerfile                     deps → dev / build → nginx runtime
docker-compose.yml             `app` (nginx, :8080) and `dev` (Vite, :5173) services
docker/nginx.conf              static serving, caching and gzip rules
docs/screenshots/              images used by this README
```

`window.autoVideoFusion` exposes `addFiles`, `applySettings`, `start` and `state` so the pipeline
can be driven from the console or from an automated browser test without touching the native
folder picker.
