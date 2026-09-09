# Trump Card Royal

A real-time multiplayer trick-taking card game for **4, 5 or 6 players**. Runs in the
browser, installs as an app, needs no database, and deploys free.

```bash
npm install
npm start        # http://localhost:3000
npm test         # 41 tests
```

Create a room, share the 4-character code, everyone joins, host starts.

## What's in it

- **Three modes** — 4-player teams or free-for-all, 5-player free-for-all, 6-player teams
- **Server-authoritative rules** — follow suit, trump, secret calls, Joker special cases
- **Reconnect** — drop out and rejoin with your name; hand, call and score all survive
- **Sound** — synthesised in the browser, no audio files
- **Shared music** — paste a YouTube link, everyone hears the same track in sync (desktop)
- **Installable** — works as a phone home-screen app and a desktop app

## Stack

Node.js, Express and Socket.IO on the server. Plain HTML, CSS and JavaScript on the
client — no framework, no build step. Two runtime dependencies.

## Documentation

**[HANDOVER.md](HANDOVER.md)** is the full reference: every rule, the deck for each
mode, the scoring formulas, the architecture, all socket events, deployment, known
limitations, and the traps that will otherwise cost you an afternoon.

## Deploying

Push to `main`. [render.yaml](render.yaml) configures a free Render web service.
Note the free tier sleeps after 15 idle minutes, and since all state is in memory,
a sleep ends any game in progress.

## Licence

Private project — no licence granted.
