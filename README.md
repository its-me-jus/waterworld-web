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

## The wreck's depth (Phase B)

The Wanderer gives up her past in dives. A galley knife lies on the bow deck at
~13 m — it cuts rope. The mate's chest sits roped shut on the sand by the torn
stern at ~24 m, where the light gives up. Inside: an oilskin pouch that gives
back the first memory of who you were, and the mate's spear. Once armed, the
shark's slow circle tightens, and about two passes in three it commits to a run
at you — jab it with the spear (F) inside ~4 m and it turns; let the run connect
and it takes a piece of you. One wound clots. A second bite, while it hasn't,
is the one the ocean keeps.

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
- **Desktop:** WASD · click for mouse-look · Space/E up · Shift/Q dive · F grab/pry/jab
- **Debug params:** `?calm=1` pins a glass-off · `?breath=0.3` / `?hunger=0.2` / `?wound=1` pre-set vitals · `?shark=8` summons a pass · `?knife=1` / `?spear=1` start armed · `?commit=1` every armed pass runs at you

## Assets

Everything in the scene — hands, swimmer, ocean, wreck, skin textures — is generated
in code. No third-party models or textures, so there are no licence restrictions on
commercial use.

Brain notes: `../agenticiallyjus/projects/waterworld.md`
