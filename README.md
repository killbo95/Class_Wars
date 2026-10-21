# CLASS WARS

A top-down browser arena game about capturing territory, controlling the center, using class abilities, collecting power-ups, and competing for the highest score.

## Gameplay
- **Runner** — faster movement; use **Q** to dash.
- **Guardian** — slower movement; use **Q** for a short shield.
- **Engineer** — balanced movement; use **Q** for a score overcharge.
- **Trickster** — balanced movement; use **Q** to blink.
- Move with **WASD** or the **arrow keys**. You can also tap the map to move.
- Press **Space** or the **BONK** button near a rival.
- Capture tiles, contest the central control point, and collect glowing power-ups.
- Matches last **3 minutes**. Highest score wins.
- The solo demo uses local simulated rivals. Multiplayer rooms share state through the Cloudflare Worker.

## Files
- `index.html` — game UI, rendering, controls, and local solo demo.
- `worker.js` — room server and multiplayer game rules.
- `wrangler.toml` — Cloudflare Worker and Durable Object configuration.

## Test locally first
Open `index.html` in a modern browser and click **Try solo demo**. This only runs on that device and does not need a server.

## Multiplayer deployment (not done yet)
1. Install Wrangler and authenticate with Cloudflare.
2. From this repository directory, run `npx wrangler deploy`.
3. Check the deployed Worker’s `/health` URL returns JSON with `ok: true`.
4. In Class Wars, set **Multiplayer server** to the Worker’s WebSocket base URL, for example `wss://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev`.
5. Create a room and share the room code. Other players enter the same Worker URL and room code.

The Worker needs the Durable Object binding and migration in `wrangler.toml`. Multiplayer has not been deployed or load-tested. The configured room limit is a code-level cap, **not a verified capacity guarantee**. Before a class-wide launch, test with a small group and add reconnection, moderation/reporting, persistence, and load testing.
