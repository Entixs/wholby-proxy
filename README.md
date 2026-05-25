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

Next, copy the environment template and customize it:

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

Q: Video playback fails.
* The proxy automatically intercepts and redirects stream endpoints directly to Emby to ensure playback is handled natively without bottlenecks. Ensure the device running Wholphin can reach the Emby server's IP address directly on your network.

Q: Is this proxy 100% functional for all media types?
* Core video playback (Movies, TV Shows) works flawlessly. However, music playback is currently experimental and may yield mixed results, while photo libraries remain untested.
* **Client Configuration Tip:** It is highly recommended to remove the "Next Up" row in your Wholphin client, as Emby automatically merges "Next Up" and "Continue Watching" into a single feed. 
  * *To remove the row:* Navigate to the Left Nav Bar > Settings > Customize Home Screen > Settings > select **Reset Settings**. This will unhide the option allowing you to delete the row. You will need to perform this reset step anytime you wish to modify your home screen layout in the future.

Q: Will this proxy require ongoing maintenance?
* Not if I'm maintaining it lmfao. The proxy's stability depends on Emby and Jellyfin's core APIs remaining relatively consistent. A major upstream update to either platform could temporarily break compatibility. This project is provided as-is, and community forks, pull requests, and contributions to patch future breaks are highly encouraged!

---

## Acknowledgements

* Created specifically to bridge Emby backends with the Wholphin client ecosystem.
* Built using Express and http-proxy-middleware.
* Developed with the assistance of AI tools. Or the other way around, really... I basically gave the AI emotional support.
