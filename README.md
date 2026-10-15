# Wholby Proxy

A lightweight, intercepting translation proxy layer designed to bridge the compatibility gap between Emby backends and the Wholphin client (or other strict Jellyfin clients).

## Why Does This Exist?

Emby and Jellyfin shared the same codebase years ago, but their APIs have drifted significantly. Today, if you try to connect a strict Jellyfin client like Wholphin directly to an Emby server, the connection will fail. This happens for several reasons:

1. UUID Formatting: Jellyfin strictly enforces standard 32-character dashed UUIDs. Emby often uses shortened, deflated, or integer-based IDs.
2. API Endpoint Drift: Endpoints for images, user profiles, and session data have diverged.
3. Enum Mismatches: Jellyfin clients frequently request data using specific query Enums (like `BasicSyncInfo` or `SeasonUserData`) that cause Emby's backend to throw 500 Internal Server Errors.
4. Missing Configuration Flags: Jellyfin expects user profile payloads to contain specific Policy and Configuration objects that Emby no longer provides in the same format.

Wholby Proxy solves this. It sits invisibly between your client and your server, translating requests and responses in real-time so both sides understand each other perfectly.

---

## How It Works (Under the Hood)

Wholby Proxy utilizes `http-proxy-middleware` to intercept traffic and apply several translation layers:

* Bijective UUID Generation: Seamlessly inflates Emby's shortened IDs into valid UUIDv4 strings on the way to the client, and deflates them back into Emby's native format on the way to the server.
* Deep JSON Patching: Intercepts JSON responses from Emby and injects Jellyfin-specific configurations, boolean flags, and mocked endpoints (like LiveTV metadata) to prevent the client from crashing.
* Query Parameter Cleanup: Catches incoming client requests and strips out Jellyfin-exclusive API query fields, consolidates array parameters into comma-separated strings, and removes unsupported sort logic.
* Auth & Header Translation: Rewrites `X-Emby-Authorization` headers and passively tracks session tokens to map incoming image/stream requests to the correct Emby User ID.
* Deep Image Routing: Catches legacy or Jellyfin-formatted user image requests and redirects them to Emby's modern `/Images/Primary` endpoints with the correct authentication keys attached.

---

## Getting Started

### Prerequisites

**Important Note on Deployment:** Because this proxy listens on port 8096 (the exact same default port as Emby), it is highly recommended to run this proxy on a *separate* physical machine or virtual machine on your network to avoid port collisions. *(If you must run it on the same machine as your Emby server, see the Docker deployment instructions below for how to map a different port).*

To run this proxy, you will need one of the following environments:
* Docker and Docker Compose (Highly Recommended)
* Node.js (v18+) (For bare-metal installations)

### 1. Clone & Configure

First, clone the repository to your local machine or server:

git clone https://github.com/YOUR_USERNAME/wholby-proxy.git

cd wholby-proxy

Next, copy the environment template and customize it (all options are documented in `.env.example`):

cp .env.example .env

Open `.env` in a text editor and fill out the configuration:

* EMBY_URL: The full URL and port of your actual Emby server (e.g., http://192.168.1.100:8096). Do not include a trailing slash.
* PROXY_SERVER_ID: A unique identifier for this proxy instance. You can generate a random UUID at uuidgenerator.net. Keep this consistent so your client doesn't think it's connecting to a new server every time you restart the proxy.

---

### 2. Deployment

#### Option A: Docker Compose (Recommended)
Docker is the cleanest way to run Wholby Proxy. It ensures all dependencies are isolated and allows the proxy to restart automatically if your server reboots.

*(Note: If you are running this proxy on the exact same machine as your Emby server, you must edit your `docker-compose.yml` file and change the port mapping from `"8096:8096"` to `"8097:8096"` to avoid a crash, then connect your client to port 8097).*

Run the following command from the project root:

docker-compose up -d

(To view the real-time translation logs, use: docker-compose logs -f)

#### Option B: Bare-Metal Node.js
If you prefer not to use Docker, you can run the app directly via Node.js. 

npm install
npm start

(We recommend using a process manager like PM2 if you plan to run this permanently on bare metal.)

---

## Connecting Your Client

Once the proxy is running, it will listen on port 8096 by default. 

Open your Wholphin client (or other Jellyfin client) and point it to the Proxy's IP Address, not your Emby server's IP address.

* Example: If your Emby server is on 192.168.1.50:8096, and you are running Wholby Proxy on a Raspberry Pi at 192.168.1.60:8096, you will type http://192.168.1.60:8096 into your client.

Log in using your normal Emby username and password. The proxy will handle the rest!

---

## Troubleshooting & FAQ

Q: The client connects, but images aren't loading.
* Double-check your EMBY_URL in the .env file. Ensure there is no trailing slash (e.g., http://192.168.1.100:8096 is correct, http://192.168.1.100:8096/ is wrong).

Q: Can Emby transcode for Wholphin users?
* No, by default. `DIRECT_PLAY_ONLY=true` forces every file to direct play: the proxy tells the client each source is directly playable, removes transcode URLs, and answers HLS and non-static stream requests with 403. A file the TV cannot decode will fail to play instead of being transcoded. Music and theme songs (which Wholphin requests through `/Audio/<id>/universal`) are served as the raw file the same way; if a client sends no credentials, the proxy uses the token last seen for its `DeviceId`. Set `DIRECT_PLAY_ONLY=false` to allow transcoding (those streams then pass through the proxy).

Q: Video playback fails.
* Direct-play streams are redirected straight to Emby when the client reaches the proxy over the same protocol as `EMBY_URL` (both https, or both http). Otherwise they are streamed through the proxy (`STREAM_MODE=auto`). Wholphin's player refuses an http -> https redirect, so a plain-HTTP proxy in front of an HTTPS Emby always streams through the proxy.
* Wholphin fetches direct-play streams without credentials. The proxy remembers which user owns each play session and attaches that user's token, so no extra setup is needed.
* If the device cannot reach Emby directly, set `STREAM_MODE=proxy`.

Q: Is this proxy 100% functional?
* Verified against Wholphin 1.0.8 on Android TV with an Emby 4.9 server: login, home screen (Continue Watching with Next Up), libraries, genres, studios, filters (played, favorites, genre, studio, rating, year, decade), sorting, A-Z jump, search, item pages, favorites, watched state, direct play, HLS transcoding, subtitles, audio track selection, seeking and playback progress.
* Not verified: music, photos, Live TV (reported as disabled), playlist creation (see below), multi-user and multi-server setups.
* Playlist creation is translated from Jellyfin's JSON body to Emby's query parameters, but could not be confirmed because the Emby server used for testing hung on every playlist request.

Q: What do the extra files do?
* `data/tokens.json` keeps saved sessions so users stay logged in across proxy restarts. `data/displayprefs.json` stores Wholphin's home-screen layout. Mount `./data` as a volume in Docker (the compose file does).

Q: Will this proxy require ongoing maintenance?
* The proxy's stability depends on Emby and Jellyfin's core APIs remaining relatively consistent. A major upstream update to either platform could temporarily break compatibility. This project is provided as-is, and community forks, pull requests, and contributions to patch future breaks are highly encouraged!

---

## Acknowledgements

* Created specifically to bridge Emby backends with the Wholphin client ecosystem.
* Built using Express and http-proxy-middleware.
* Developed with the assistance of AI tools. Or the other way around, really... I basically gave the AI emotional support.


---

## Development

* `npm test` runs the unit tests (path translation, query cleanup, Resume and Next Up splitting, display preferences, and more).
* `node tools/contract-check.js` logs in through a running proxy, calls the endpoints Jellyfin clients use, and validates every JSON response against Jellyfin's published OpenAPI schema. A violation here is a crash or a blank screen in strict clients such as Wholphin.

  ```
  PROXY_URL=http://localhost:8096 EMBY_USER=name EMBY_PASS=password node tools/contract-check.js
  ```
  Use `STRICT=1` to also list every non-nullable property that Emby omits.

### Known Emby / Jellyfin differences the proxy handles

* `AiredEpisodeOrder`, `Default` and `VideoBitRate` sort keys (Emby answers 500).
* `fillWidth` / `fillHeight` image parameters (Emby ignores them and sends full-size images), mapped to `maxWidth` / `maxHeight`.
* `/Years`, `/Items/Filters`, `/Search/Hints` shapes, and name-only lists lacking `Id` and `Type`.
* Favorite / watched responses lacking `Key` and `ItemId`; `DatePlayed` format; `streamOptions` parameter.
* Emby `Attachment` streams, `MediaSourceId` strings such as `mediasource_123`, un-dashed policy folder ids.
* Jellyfin 10.9+ routes (`/UserItems`, `/UserPlayedItems`, `/UserFavoriteItems`, `/UserViews`) and `/MediaSegments`.
* Websocket `/socket` is forwarded to Emby's `/embywebsocket`.
