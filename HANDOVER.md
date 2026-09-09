# Trump Card Royal — Handover, v1.0.0

A real-time multiplayer trick-taking card game for 4, 5 or 6 players. Browser-based,
installable as an app, no database, deployable free.

- **Repository:** https://github.com/siddhantrajnaik/Trump-Royale
- **Version:** 1.0.0 (git tag `v1.0.0`)
- **Stack:** Node.js + Express + Socket.IO on the server; plain HTML/CSS/JavaScript
  on the client. No framework, no build step, no database.
- **Runtime dependencies:** exactly two — `express` and `socket.io`.

---

## 1. Quick start

```bash
npm install
npm start            # http://localhost:3000
```

```bash
npm test             # 41 tests, ~30 seconds
npm run dev          # same as start, restarts on file change
```

Open the URL, enter a name, **Create Room**, and share the 4-character code.
Everyone joins with the code, the host presses **Start Game**.

---

## 2. How the game works

### 2.1 Modes

| Players | Mode | Teams | Deck | Cards each | Tricks |
|---|---|---|---|---|---|
| 4 | 2v2 Teams | 2 (seats 0+2, 1+3) | 52 | 13 | 13 |
| 4 | Free-for-All | none | 52 | 13 | 13 |
| 5 | Free-for-All | none | 50 | 10 | 10 |
| 6 | 3v3 Teams | 3 (seats 0+3, 1+4, 2+5) | 48 | 8 | 8 |

5-player is free-for-all only; 6-player is teams only. The server enforces both.

### 2.2 Deck composition

Every deck contains the Joker, and every deck divides exactly among the players —
that last property matters, see §2.3.

- **4-player (52):** standard 52, remove `2♦`, add Joker.
- **5-player (50):** standard 52, remove `2♠ 2♣ 2♥`, add Joker.
- **6-player (48):** standard 52, remove all four `2`s and `3♦`, add Joker.

### 2.3 Colour (trump) selection

1. Deck is shuffled.
2. The player to the dealer's left — the **colour picker**, seat `dealer + 1` — reveals
   the top card.
3. That card's suit becomes trump for the round. Everyone sees it.
4. The colour card goes to the bottom of the deck.
5. Dealing starts with the colour picker, one card at a time, clockwise.

Because each deck divides exactly, the colour card is dealt last and lands in the
**dealer's hand**. Change the deck size without preserving that and this breaks.

**Known edge case:** if the colour card is itself the Joker, it has no suit, so the
round has no trump at all — roughly 1 round in 33 at 5 players. The game plays fine,
but the trump indicator is blank and players may think it's a bug. Not yet decided
what *should* happen (redraw, or play trumpless). See §9.

### 2.4 Calling

Calls are secret. The count of submissions is shown ("3/5 calls submitted…") but not
the numbers. When the last call is in, all are revealed at once.

- Minimum 1, no maximum, any positive integer.
- Order starts with the colour picker, clockwise.
- In team modes **one call per team**, not per player.
- A call cannot be changed once submitted.

### 2.5 Trick play

- Follow the led suit if you can.
- Void in the led suit? Play anything.
- Highest trump wins; if no trump, highest card of the led suit wins.
- Trick winner leads the next trick.

When the last card lands, **all cards stay on the table** with the winner highlighted
in gold and a **Next Trick** button. Any player can press it. A 20-second server
timeout advances automatically so an idle table can't deadlock.

### 2.6 Joker rules

**The Joker is not a trump card.** It is a suitless special card that beats trump on
its own priority. Cards carry explicit `isJoker` / `isTrump` flags from the server so
this can never be inferred from a suit comparison — important because when there is no
trump suit, `card.suit === trumpSuit` becomes `null === null`.

- **Middle tricks:** Joker beats everything, including the highest trump.
- **First trick and final trick:** Joker may be played but has **zero winning value**.
- Suitless, so exempt from follow-suit — playable even when holding the led suit.
- A player who won the previous trick **cannot lead** the next with the Joker…
- …**unless it is their only card**, otherwise the round deadlocks with no legal move.
  This exception was a real bug: the untouched engine hit it in ~1% of 4-player
  free-for-all rounds.

### 2.7 Scoring

```
tricks >= call   →   score = call + 0.1 × (tricks − call)
tricks <  call   →   score = −call
```

Special doubling on a **successful** call only:

- **4 players:** call 7 taken → `14.0`
- **6 players:** call 5 taken → `10.0`
- **5 players:** no doubling at all. Call 5 taken scores `5.0`.

Examples: call 3 take 3 → `3.0` · call 3 take 5 → `3.2` · call 20 take 10 → `−20.0`.

Scores accumulate across rounds. The game ends when **every connected player** votes
to end it (§3.4).

---

## 3. Architecture

```
Browser  ──socket.io──►  Node process  ──►  in-memory Map of rooms
   │                          │
   │                          └── GameEngine (one per room, all rules)
   └── app.js (render) + sound.js + music.js
```

**The server is authoritative.** Clients render state and send intents; they never
decide a rule. Every broadcast is a personalised full snapshot — each player sees
their own hand and nobody else's.

**All state is in memory.** No database. A server restart loses every game (§8).

### 3.1 Files

| File | Lines | What it is |
|---|---|---|
| `server/index.js` | 283 | HTTP, static files, socket events, room lifecycle |
| `server/game/engine.js` | 574 | **All game rules.** Deck, dealing, calls, tricks, scoring |
| `server/music.js` | 103 | Shared-music state and the playback clock |
| `public/index.html` | 173 | Every screen and overlay |
| `public/app.js` | 799 | Rendering, input, screen flow |
| `public/style.css` | 185 | All styling |
| `public/sound.js` | 152 | Synthesised sound effects |
| `public/music.js` | 325 | YouTube player and drift correction |
| `public/sw.js` | 102 | Service worker |
| `public/manifest.webmanifest` | 34 | PWA manifest |
| `public/icons/*.png` | — | App icons, generated (§7.3) |
| `server/test/*.js` | 1084 | 41 tests |
| `render.yaml` | 10 | Render deployment config |

### 3.2 The entity abstraction

The engine never asks "which player scored" — it asks "which **entity**". In
free-for-all an entity is a player id; in team modes it's a team id. Calls, tricks
won and scores are all keyed by entity. This is why one code path serves both.

`_entityId(seat)` is the whole trick. Understand this function and the engine opens up.

### 3.3 Socket events

Client → server (all take an acknowledgement callback):

| Event | Payload | Notes |
|---|---|---|
| `create-room` | `{playerName, gameMode, playerCount, musicEnabled}` | Returns `{roomCode, playerId}` |
| `join-room` | `{roomCode, playerName}` | Also the reconnect path (§3.5) |
| `start-game` | — | Host only |
| `submit-call` | `{call}` | |
| `play-card` | `{cardId}` | |
| `next-trick` | — | Clears the trick pause |
| `next-round` | — | Host only |
| `request-end-game` / `cancel-end-game` | — | |
| `music-time` | — | Returns `{serverNow}` for clock sync |
| `music-set` | `{url}` | |
| `music-control` | `{action, seconds}` | `play` `pause` `seek` `stop` |

Server → client: **only `game-state`**, a full personalised snapshot. There are no
incremental updates, which keeps the client simple and impossible to desynchronise.

### 3.4 Connection handling

Everything here was broken at one point and is now covered by tests.

- **Disconnect mid-game:** the seat is held. The player is shown as `offline` and a
  banner names them. Play **pauses** on their turn rather than auto-playing their
  cards, which would change the game.
- **Reconnect:** rejoin with the room code and **the exact same name** (case and
  spaces are forgiven). The original player id is kept, so hand, call, tricks and
  score all survive. *Minting a new id silently orphaned all of it — the returning
  player got an empty hand and the round could never finish.*
- **A stranger cannot take a seat.** Rejoin matches by name; a mismatch is refused
  with a message naming the free seats.
- **Host leaves:** the host role passes to a connected player, otherwise nobody could
  deal the next round.
- **Ending the game** needs a vote from every **connected** player, not every seat —
  one dropout used to make it impossible.
- **Everyone drops at once:** the room survives a 2-minute grace period.

### 3.5 Reconnect flow in one line

`join-room` on a room that has started → find a disconnected player whose name matches
→ reuse their id → repoint the socket. That's it.

---

## 4. Client notes

### 4.1 localStorage keys

| Key | Purpose |
|---|---|
| `tcr_name` | Player name, pre-filled on return |
| `tcr_room` | Last room code — powers the one-tap **Rejoin** button |
| `tcr_pid` | Last player id (informational) |
| `tcr_sound` | `on` / `off` — sound effects |
| `tcr_music_room` | `on` / `off` — remembered music choice for new rooms |
| `tcr_music_vol` | 0–100, this player's music volume |

### 4.2 The hand

Overlap is **computed per render** to fit the viewport, never fixed, so 13 cards fit a
320px phone without scrolling. Cards carry a **corner index** (rank over suit, like a
real card) because the centre pip is hidden when cards overlap.

**Interaction differs by device on purpose.** With a mouse, hover already reveals a
card, so a single click plays it. On touch there is no hover, so the **first tap
selects** (the card lifts, the bar reads "Tap again to play") and the second commits.
Tapping a 30%-visible card and having it play immediately is a coin flip you cannot
undo.

### 4.3 Sound

Every effect is **synthesised with the Web Audio API** — no audio files, nothing to
download or license. Nine cues: dealing, trump reveal, calls, cards, trick won/lost,
round end, game over.

Cues fire on **state transitions**, not local clicks, so everyone hears the same thing
regardless of who acted.

Browsers block audio until a gesture. The unlock retries on every gesture until the
context genuinely reports `running` — a single attempt that silently failed used to
leave the whole session mute. Diagnose with `Sound.state()` in the console.

### 4.4 Shared music (desktop only)

Anyone pastes a YouTube link; everyone hears the same track at the same point.

**How the sync works.** The server holds a *logical clock* — which video, whether it's
playing, and the position when that last changed. Each client derives where the track
should be and seeks only when it has drifted more than 1.5s. So a player who buffers,
tabs away or sits through an ad **rejoins the others** instead of dragging the room.
Someone joining two minutes late starts two minutes in.

Clock skew is the trap: a browser three seconds fast would think the track is three
seconds further along. Every broadcast carries the server's time and clients estimate
their offset from the **median of five round trips**. Measured drift between two live
browsers: **~0.5s**.

Turn it off per room on the Create screen. When off, the button is hidden **and** the
server refuses `music-set` / `music-control` — hiding UI alone leaves it reachable from
the console.

Diagnose with `Music.debug()`.

**Limits that cannot be fixed in code:** ads interrupt only the person watching them ·
iOS stops playback when the screen locks · live streams won't embed (the card says so)
· each player must click **Join the music** once, because browsers forbid autoplay.

### 4.5 PWA

Installable to a phone home screen, and via Chrome/Edge as a desktop app with its own
window. The service worker is **network-first everywhere** — a deploy is picked up on
the next load. A cache-first shell would strand players on old code, the exact opposite
of what's wanted.

What it buys is the **cold start**: Render's free tier sleeps and takes ~50s to wake, so
the worker races the network against a 2.5s timer and paints the interface from cache
while the socket waits.

The Socket.IO transport is **never** intercepted — only the client library, which is a
static file. Getting that wrong would break every game, so it's tested.

⚠️ **Never verified on real hardware.** Service worker registration is blocked in the
browser tooling used during development. Manifest, icons, headers and worker logic all
check out and are covered by 7 tests, but the real thing has never registered. **Open
the deployed URL in Chrome once and confirm the install icon appears.**

---

## 5. Testing

```bash
npm test        # 41 tests
```

| Group | Count | Covers |
|---|---|---|
| Joker | 8 | The classification rules in §2.6, across all modes |
| Rules | 8 | Decks, round shape, scoring, 200-round soaks, reconnect, end-game vote |
| Service worker | 7 | Transport never intercepted, network-first, offline fallback, cold start |
| Music | 10 | Link parsing, playback clock, clock-skew, room flag |
| Client | 8 | **The browser code actually starts and can draw itself** |

**Why the client tests exist.** Every other test runs server-side. The suite once
reported 33/33 while the client was throwing on load and half the app never wired up —
the Create button did nothing. They load `index.html` in jsdom, run the three browser
scripts as real script elements, and push genuine engine states through the renderer.

They were validated by **reintroducing the exact bug** (one `querySelectorAll` turned
back into `querySelector`) and confirming six tests fail. A test that cannot fail is
not worth having.

`jsdom` is a **devDependency**; `render.yaml` sets `NODE_ENV=production`, so the deploy
installs `express` and `socket.io` and nothing else. Verified: `npm install --omit=dev`
removes it.

**What tests cannot see:** layout, styling, real clicks, real devices. Check those by
eye.

---

## 6. Deployment

Currently on **Render free tier** via `render.yaml` (Blueprint). Push to `main` and it
redeploys automatically.

**Everyone must hard-refresh (Ctrl+Shift+R) after a deploy**, or they run cached JS.

**Free-tier realities:**

- Sleeps after 15 idle minutes; next visitor waits ~50s. Open the link a minute before
  your friends.
- **A sleep destroys every in-progress game** — all state is in memory. Fine for one
  sitting.
- 750 instance-hours and 100 GB bandwidth per month; nowhere near either.

Alternatives: **Fly.io** keeps a machine warm (no cold start, a few dollars a month).
**Netlify and Vercel cannot host this at all** — they're serverless, so they can't hold
WebSocket connections open or share in-memory state between players.

---

## 7. Things that will confuse the next person

### 7.1 `$$` in a replacement string

`String.replace()` treats `$$` as an escaped `$`. Patching files with a script turned
every `$$('...')` into `$('...')` — `querySelector` instead of `querySelectorAll`, no
`.forEach` — which threw partway through `app.js` and stopped everything after it
registering, including the socket listener. **Use `split().join()` for literal
replacements.** The client tests now catch this.

### 7.2 `align-items: center` on `.screen`

`#screen-game` inherits it, which made the header and status bars content-width instead
of full-width. Explicitly set to `stretch`.

### 7.3 The icons are generated, not drawn

`public/icons/*.png` were produced by a script that rasterises analytic shapes and
encodes PNG with zlib — no image library. The generator is not in the repo. To change
the icon, replace the PNGs by any means; nothing depends on how they were made.

### 7.4 The hand row can stretch the whole layout

A flex row of non-shrinking cards propagates its min-content width up the tree. It once
made the page 642px wide on a 375px screen with the first card at `x = −117`, off
screen and unreachable. `min-width: 0` on `#hand-area` prevents it.

### 7.5 Music state is deliberately outside the engine

`server/music.js`, not `engine.js`. It isn't a game rule, and the engine's tests
shouldn't have to know about it.

---

## 8. Known limitations

| Limitation | Impact |
|---|---|
| **No persistence** | Server restart or Render sleep destroys every game |
| **Not verified on real phones** | Layout tested at 320/375/1200px, but emulated |
| **PWA install never actually run** | See §4.5 — needs one manual check |
| **Music sync only tested on localhost** | Real latency untested; design accounts for it |
| **No bots** | You need exactly 4, 5 or 6 humans to start |
| **Duplicate names break reconnect** | Two players called "Alex" — the wrong one can reclaim the wrong seat. Nothing prevents the duplicate at join time |
| **No trump when the colour card is the Joker** | ~1 round in 33; plays fine but the indicator is blank |
| **No round history** | The scoreboard shows totals, not what happened per round |

---

## 9. Suggested next steps

Roughly in order of value:

1. **Bots to fill empty seats.** The single biggest limitation — it turns "needs five
   friends simultaneously" into "playable whenever". The engine already exposes
   `getLegalCards`, so a simple bot is short.
2. **Decide the no-trump case** (§2.3). Redraw the colour card, or show "No trump this
   round" so it doesn't look broken.
3. **Reject duplicate names** at the lobby — a few lines, closes a real seat-mixup.
4. **Survive a restart.** Writing room state to a file at each round end would let games
   outlive a sleep.
5. **Round history** on the scoreboard.

---

## 10. Development history

Fourteen commits, oldest first:

```
653f1aa  Initial implementation of Trump Card Royal multiplayer card game
bc23e98  Hold completed tricks until players advance them
2ca3045  Add synthesized sound effects
4eb32a9  Add 5-player free-for-all mode
3d9125c  Put the Joker in the 5-player deck; fix Joker-only lead deadlock
e6163de  Fix connection handling: reconnect lost the player's whole game
bf6342d  Offer a one-tap rejoin on the menu
87b18ed  Make Joker-is-not-Trump explicit, and add a test suite
272cf62  Make the hand usable on a phone
50fbc93  Make it installable as a PWA
c2c4025  Stop audio getting stuck off
d442433  Add shared YouTube music, synced across the room
5ba2bc5  Let the host turn shared music off when creating a room
7cabd68  Fail the build when the client will not start
```

Commit messages are written to explain *why*, not what. When something here is unclear,
`git log` is the fuller answer.

### Bugs found and fixed along the way

Worth knowing, because each one was invisible until specifically hunted:

- **Reconnect destroyed the player's game.** A new player id was minted and nothing
  copied across; hands, calls, tricks and scores are all keyed by it. The returning
  player got an empty hand and the round could never finish. Affected every mode.
- **Anyone could take a disconnected seat** by typing any name, and read that player's
  hand.
- **Joker-only lead deadlock.** ~1% of 4-player free-for-all rounds became
  unfinishable. Pre-existing, found by soak-testing the 5-player deck.
- **The hand ran off the left of the screen** on mobile — first card at `x = −117`.
- **A single tap played a 30%-visible card** with no undo.
- **Audio could get stuck off permanently** — one failed unlock attempt and the session
  was mute, plus a 42×33px mute button 8px from the scoreboard button.
- **The client could be completely broken while tests said 33/33** — the gap that §5's
  client tests now close.

---

*Handover written 2026-09-09 for v1.0.0.*
