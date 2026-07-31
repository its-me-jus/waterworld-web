# WaterWorld (web)

First-person ocean survival seed — Gerstner waves, swim controls, underwater murk,
and a body that keeps score. Built with Vite + Three.js.

## The loop (Phase A)

Grounded castaway, permadeath, infinite thrive. Breath, hunger and fatigue are
read through the body — a closing vignette, a heartbeat, slower arms — not meters.
Pry the provision crate by the wreck for a first meal; after that, hang still
underwater and grab fish by hand. The sea itself runs on slow seasons with
sudden glass-off calm spells (the best dive windows), and every few minutes
something large takes one circle through your water and leaves.

## Live

- **Phone / share:** https://waterworld-web.vercel.app
- **Repo:** https://github.com/its-me-jus/waterworld-web

## Local

```powershell
npm install
npm run dev
```

## Controls

- **Touch / on-screen:** left stick move · drag anywhere to look · ▲▼ depth · ✋ grab when offered
- **Desktop:** WASD · click for mouse-look · Space/E up · Shift/Q dive · F grab/pry
- **Debug params:** `?calm=1` pins a glass-off · `?breath=0.3` / `?hunger=0.2` pre-set vitals

## Assets

Everything in the scene — hands, swimmer, ocean, wreck, skin textures — is generated
in code. No third-party models or textures, so there are no licence restrictions on
commercial use.

Brain notes: `../agenticiallyjus/projects/waterworld.md`
