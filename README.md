# Wholby Proxy

Use the **Wholphin** app with an **Emby** server.

Wholphin is a great Android TV app, but it only speaks Jellyfin. Emby speaks almost the same language, but not quite, so Wholphin cannot connect to Emby by itself. Wholby Proxy sits in the middle and translates, so Wholphin works with your Emby server.

```
Wholphin app  <---->  Wholby Proxy  <---->  Your Emby server
 (Android TV)        (this project)
```

Users log in with their normal Emby username and password. Nothing changes on your Emby server.

> Forked from [burntslurm/wholby-proxy](https://github.com/burntslurm/wholby-proxy), who built the first version.

---

## What You Need

* An Emby server that the proxy can reach (for example `http://192.168.1.100:8096`).
* A computer or server to run the proxy. A small Linux machine, a Raspberry Pi, or the same machine as Emby all work.
* **Either** Docker **or** Node.js 18 or newer. Docker is easier.
* Wholphin on your Android TV (tested with version 1.0.8).

Is the proxy going to be on the same machine as Emby? Emby already uses port 8096, so the proxy will use **8097** instead. The steps below point this out where it matters.

---

## Install With Docker (Easiest)

**1. Download the project**

```
git clone https://github.com/Entixs/wholby-proxy.git
cd wholby-proxy
```

**2. Create your settings file**

```
cp .env.example .env
```

**3. Edit the settings file**

Open `.env` in any text editor and change these two lines:

```
EMBY_URL=http://192.168.1.100:8096
PROXY_SERVER_ID=00000000-0000-4000-8000-000000000000
```

* `EMBY_URL` is the address of your Emby server. No slash at the end.
* `PROXY_SERVER_ID` is just a random ID. Make one with the command `uuidgen`, or paste any UUID from a site like uuidgenerator.net. Pick it once and never change it.

**4. Same machine as Emby?** Open `docker-compose.yml` and change `"8096:8096"` to `"8097:8096"`. If the proxy is on its own machine, skip this step.

**5. Start it**

```
docker compose up -d
```

(On older systems the command is `docker-compose up -d`.)

**6. Check that it works**

```
curl http://localhost:8096/System/Info/Public
```

(Use port 8097 if you changed it in step 4.) You should see a short line of text containing your Emby server's name. If you do, jump to [Connect Wholphin](#connect-wholphin).

Useful Docker commands:

| What | Command |
|---|---|
| See the logs | `docker compose logs -f` |
| Stop it | `docker compose down` |
| Restart it | `docker compose restart` |

---

## Install Without Docker

**1. Install Node.js 18 or newer** from [nodejs.org](https://nodejs.org) or your package manager. Check with `node -v`.

**2. Download the project**

```
git clone https://github.com/Entixs/wholby-proxy.git
cd wholby-proxy
npm ci --omit=dev
```

**3. Create and edit your settings file** exactly like steps 2 and 3 of the Docker install above. If the proxy is on the same machine as Emby, also add the line `PORT=8097`.

**4. Try it**

```
node server.js
```

You should see `Wholby Proxy listening on ...`. Check it with `curl http://localhost:8096/System/Info/Public` (use 8097 if you set `PORT=8097`). Press `Ctrl+C` to stop.

**5. Keep it running (Linux)**

So the proxy starts on boot and restarts if it crashes, run this once. It creates a service for your current user and folder:

```
sudo tee /etc/systemd/system/wholby-proxy.service >/dev/null <<EOF
[Unit]
Description=Wholby Proxy
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
WorkingDirectory=$PWD
EnvironmentFile=$PWD/.env
ExecStart=$(which node) $PWD/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$PWD/data

[Install]
WantedBy=multi-user.target
EOF
mkdir -p data
sudo systemctl daemon-reload
sudo systemctl enable --now wholby-proxy
```

| What | Command |
|---|---|
| Is it running? | `systemctl status wholby-proxy` |
| See the logs | `journalctl -u wholby-proxy -f` |
| Restart it | `sudo systemctl restart wholby-proxy` |

---

## Connect Wholphin

1. Open Wholphin on your Android TV.
2. Choose **Add Server**, then **Enter server address**.
3. Type the address of the **proxy** (not Emby):
   * Same network: `http://PROXY-IP:8096`, for example `http://192.168.1.60:8096`. Use `8097` if you changed the port.
   * Over the internet: `https://your-domain.com` (see the next section).
4. Log in with your **Emby** username and password.

That's it. Your Continue Watching, libraries, search, favorites and watched marks all work.

---

## Put It On The Internet (Optional)

Only do this if you want to use the proxy away from home, or share it with other people. If everyone is on your home network, skip it.

You will need a **domain name** (for example `emby.example.com`) pointing at the proxy machine, and **ports 80 and 443** open to it. The steps below use nginx and a free Let's Encrypt certificate on a Debian or Ubuntu machine.

**1. Make the proxy private.** Add this line to your `.env` so only nginx can talk to it, then restart the proxy:

```
HOST=127.0.0.1
```

**2. Install nginx and certbot**

```
sudo apt install nginx certbot python3-certbot-nginx
```

**3. Add the settings that go in nginx's main configuration.** This limits login attempts (protection against password guessing) and keeps login tokens, which appear in some web addresses, out of your logs:

```
sudo tee /etc/nginx/conf.d/wholby-proxy.conf >/dev/null <<'EOF'
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

limit_req_zone $binary_remote_addr zone=wholby_login:10m rate=10r/m;

log_format wholby_notokens "$remote_addr [$time_local] \"$request_method $uri\" $status $body_bytes_sent";
EOF
```

If nginx later complains that `connection_upgrade` is already defined, delete the `map` block above. Another site on your server already has it.

**4. Add your site.** Replace `emby.example.com` with your domain:

```
sudo tee /etc/nginx/sites-available/emby.example.com >/dev/null <<'EOF'
server {
    listen 80;
    server_name emby.example.com;

    access_log /var/log/nginx/wholby.access.log wholby_notokens;
    client_max_body_size 10m;

    location = /Users/AuthenticateByName {
        limit_req zone=wholby_login burst=5 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:8096;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $remote_addr;
    }

    location /socket {
        proxy_pass http://127.0.0.1:8096;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 1h;
    }

    location / {
        proxy_pass http://127.0.0.1:8096;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_read_timeout 120s;
        proxy_buffering off;
    }
}
EOF
sudo ln -s /etc/nginx/sites-available/emby.example.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

(If the proxy runs on port 8097, change `8096` to `8097` in all three places.)

**5. Turn on HTTPS.** This gets a free certificate and sets up the redirect for you:

```
sudo certbot --nginx -d emby.example.com
```

**6. Test it.** Open `https://emby.example.com/System/Info/Public` in a browser. You should see a line of text with your server's name. Then add `https://emby.example.com` in Wholphin.

### Using Cloudflare?

It works well, with two rules:

* If your server uses a **Cloudflare Origin certificate**, the DNS record **must be proxied (orange cloud)**. Only Cloudflare trusts that certificate. A gray cloud makes TVs refuse to connect. With a normal Let's Encrypt certificate, either color works.
* Set `STREAM_MODE=redirect` in `.env`. This makes sure video never flows through Cloudflare (see [How video is delivered](#how-video-is-delivered)).

In Cloudflare's SSL/TLS settings, choose **Full** or **Full (strict)**.

---

## How Video Is Delivered

By default the proxy only allows **direct play**: your TV plays the original file and Emby never transcodes for Wholphin. That keeps your Emby server's CPU free.

When someone presses play, the proxy answers with a short redirect and the TV downloads the video **straight from Emby**. The proxy and Cloudflare only handle the small stuff (logins, lists, pictures, subtitles), not the video itself. So the proxy machine needs very little bandwidth.

Two things follow from this:

* The TV must be able to reach your Emby server's address (`EMBY_URL`) directly. If Emby is only reachable from the proxy machine, set `STREAM_MODE=proxy` and the video will flow through the proxy instead.
* A file your TV cannot decode will fail to play instead of being transcoded. Wholphin on a modern Android TV plays almost everything. If you do want transcoding, set `DIRECT_PLAY_ONLY=false`.

---

## Admin Dashboard (Optional)

A small password-protected web page for the person running the proxy. It shows whether Emby is reachable, how busy the proxy is, recent problems, and lets you change the main settings without editing files or restarting.

It is **off until you turn it on**, and it is **never part of the customer address**: it runs on its own port and only listens on the machine itself.

**1. Set an admin password** (at least 12 characters; you type it, nothing is shown):

```
npm run admin-password
```

With Docker: `docker compose exec wholby-proxy npm run admin-password`

The password is stored only as a salted hash in `data/admin.json`. Running the command again changes it and signs everyone out.

**2. Turn it on.** Add this to your `.env` and restart the proxy:

```
ADMIN_PORT=8098
```

**3. Open it.** From the same machine, go to `http://localhost:8098`. From another computer, the safest way is an SSH tunnel, which needs no extra setup on the server:

```
ssh -L 8098:127.0.0.1:8098 you@your-server
```

and then open `http://localhost:8098` on your own computer. (With Docker, also publish the port to the host only: add `"127.0.0.1:8098:8098"` under `ports:` and set `ADMIN_HOST=0.0.0.0` in `.env`, because the container's own network is separate.)

**What you can do there**

* See how long the proxy has been running, how many requests it handled, and a small chart of the last hour.
* Check that Emby answers, with a response time.
* Change the **Emby server address**. Type the new address and press **Test** to see whether an Emby server answers there. It is only saved if one does. Changing it signs everyone out of Wholphin (their saved logins belong to the old server), so they log in again with their account on the new server. The address you save overrides `EMBY_URL` in `.env`.
* Change: how video is delivered, direct play only, the Jellyfin version shown to apps, the Continue Watching depth, and request logging. Changes apply immediately and are kept after restarts (saved in `data/settings.json`, which overrides `.env` for these settings).
* See the most recent problems (failed requests to Emby, etc.). Tokens and passwords are never shown.

**How it is protected:** the password is hashed; logins are limited to 5 wrong tries per 15 minutes per address (and 30 overall); sessions expire after 12 hours; the page uses strict security headers and no inline scripts; and changes can only be made from the dashboard page itself.

To put it on a real domain instead of using a tunnel, publish it through nginx on its own hostname, use HTTPS, and ideally restrict it to your own IP address. Never publish it on the same address customers use.

---

## Update To A New Version

Docker:

```
cd wholby-proxy
git pull
docker compose up -d --build
```

Without Docker:

```
cd wholby-proxy
git pull
npm ci --omit=dev
sudo systemctl restart wholby-proxy
```

Your settings (`.env`) and saved logins (`data/`) are kept.

---

## All Settings

Everything goes in your `.env` file. Only the first two are required.

| Setting | Default | What it does |
|---|---|---|
| `EMBY_URL` | none (required at first start) | Address of your Emby server, for example `http://192.168.1.100:8096`. Can be changed later from the admin dashboard |
| `PROXY_SERVER_ID` | none (required) | A fixed random UUID that identifies this proxy to apps |
| `PORT` | `8096` | Port the proxy listens on |
| `HOST` | `0.0.0.0` | Address to listen on. Use `127.0.0.1` when nginx sits in front |
| `STREAM_MODE` | `auto` | `auto`: send the TV straight to Emby when possible. `redirect`: always do that. `proxy`: pass video through the proxy |
| `DIRECT_PLAY_ONLY` | `true` | Never transcode for Wholphin. Set to `false` to allow it |
| `REPORTED_VERSION` | `10.10.7` | Jellyfin version shown to apps. Raise it if Wholphin says the server version is not supported |
| `RESUME_FETCH_LIMIT` | `100` | How many in-progress and next-up items to read. Raise it for users with very large watch lists |
| `TOKEN_FILE` | `data/tokens.json` | Where saved logins are kept so people stay logged in after a restart |
| `DISPLAY_PREFS_FILE` | `data/displayprefs.json` | Where each user's Wholphin home-screen layout is kept |
| `DEBUG` | off | Set to `true` to log every request (passwords and tokens are hidden) |
| `ADMIN_PORT` | off | Turns on the [admin dashboard](#admin-dashboard-optional) on this port |
| `ADMIN_HOST` | `127.0.0.1` | Address the dashboard listens on |
| `SETTINGS_FILE` | `data/settings.json` | Where settings saved from the dashboard are kept |

After changing `.env`, restart the proxy.

---

## Troubleshooting

**First, look at the logs.** Docker: `docker compose logs -f`. Systemd: `journalctl -u wholby-proxy -f`. Add `DEBUG=true` to `.env` for more detail.

| Problem | What to do |
|---|---|
| The proxy won't start and says `EMBY_URL is missing or invalid` or `PROXY_SERVER_ID must be a UUID` | Fix those two lines in `.env`. The ID must look like `123e4567-e89b-42d3-a456-426614174000` |
| The proxy won't start: port already in use | Something else uses that port (often Emby on 8096). Use port `8097` as described above |
| Wholphin says **Server version not supported** | Try a newer `REPORTED_VERSION`, for example `REPORTED_VERSION=10.11.0`, in `.env` and restart |
| Wholphin shows a **certificate error** or can't connect over the internet | With a Cloudflare Origin certificate the DNS record must be orange (proxied). Check that the domain opens in a browser |
| Login fails with "too many requests" | The login limit (10 a minute per address) was hit. Wait a minute |
| Pictures are missing | Check `EMBY_URL`: it must be correct with no slash at the end |
| Video won't play | The TV may not be able to reach Emby directly: set `STREAM_MODE=proxy`. Or the file's format isn't supported by the TV (direct-play-only mode never transcodes) |
| You get logged out after every restart | Make sure the `data` folder is kept. With Docker, the `./data:/app/data` line in `docker-compose.yml` must stay |
| The Continue Watching row is empty | It shows what the user has started or what comes next in shows they watch. Watch something first |

---

## What Works

Tested with Wholphin 1.0.8 on Android TV and an Emby 4.9 server: logging in, the home screen with Continue Watching, all libraries, genres, studios, filters (played, favorites, genre, studio, rating, year, decade), sorting, A-Z jump, search, item pages, favorites, watched marks, direct play, subtitles, audio track selection, seeking, and saving your place.

**Not tested:** music and photo libraries, Live TV (reported as off), creating playlists, and many different users at once.

This project depends on how Emby and Jellyfin behave today. A big update to either one could break something. Fixes and pull requests are very welcome.

---

## How It Works

Wholby Proxy uses Express and `http-proxy-middleware` and changes requests and answers on the fly so each side understands the other. The main jobs:

* **IDs:** converts Emby's short IDs into the long dashed format Jellyfin apps need, and back again.
* **Answers:** adds the fields and shapes Jellyfin apps expect, and fixes values Wholphin's strict parser rejects.
* **Requests:** removes options Emby rejects, maps Jellyfin 10.9+ routes onto Emby's, and resizes pictures on the Emby side.
* **Continue Watching:** Emby mixes "next up" into its continue list. The proxy splits them into the two lists Wholphin expects.
* **Logins and playback:** keeps track of who is who so streams that carry no password still work.

Credit to the original author for the first version of this idea.

---

## Development

* `npm test` runs the unit tests.
* `node tools/contract-check.js` logs in through a running proxy and checks every answer against Jellyfin's official API definition. A problem it reports usually means a crash or blank screen in Wholphin.

  ```
  PROXY_URL=http://localhost:8096 EMBY_USER=name EMBY_PASS=password node tools/contract-check.js
  ```

  Add `STRICT=1` to also list every optional field Emby leaves out.

### Differences between Emby and Jellyfin that the proxy handles

* Sort keys `AiredEpisodeOrder`, `Default` and `VideoBitRate` (Emby answers 500).
* `fillWidth` / `fillHeight` image sizes (Emby ignores them and sends full-size pictures), mapped to `maxWidth` / `maxHeight`.
* `/Years`, `/Items/Filters` and `/Search/Hints` shapes, and name-only lists that lack `Id` and `Type`.
* Favorite and watched answers without `Key` and `ItemId`; the `DatePlayed` format; the `streamOptions` parameter.
* Emby `Attachment` streams, `MediaSourceId` values like `mediasource_123`, and un-dashed folder ids.
* Jellyfin 10.9+ routes (`/UserItems`, `/UserPlayedItems`, `/UserFavoriteItems`, `/UserViews`) and `/MediaSegments`.
* The websocket `/socket` is passed on to Emby's `/embywebsocket`.
* Music and theme songs (`/Audio/<id>/universal`) are served as the original file.

The files in the `deploy/` folder are a working example of the service and nginx setup.

---

## Acknowledgements

* Created to bridge Emby backends with the Wholphin client.
* Built with Express and http-proxy-middleware.
* Developed with the assistance of AI tools.
