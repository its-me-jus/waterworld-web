# WaterWorld (web)

First-person ocean seed — Gerstner waves, swim controls, underwater murk. Built with Vite + Three.js.

## Live

- **Phone / share:** https://waterworld-web.vercel.app
- **Repo:** https://github.com/its-me-jus/waterworld-web

## Local

```powershell
npm install
npm run dev
```

## The run

An open-ocean survival sandbox. There is no objective, no quest marker and no
save — you last as long as you can keep breath, warmth, water and food off the
floor, and when you drown you start again in the same water.

Nothing is signposted. The wreck, the drifting salvage and the island on the
horizon are all found by looking. Actions only announce themselves once
whatever they act on is already within reach.

Wade far enough up the island's beach and you climb out of the swim into a
walk — slope-aware, with real gravity off the ledges. Cliffs past ~50° refuse
you; a storm face that closes over your head knocks you back into the sea.

The day turns (~8 real minutes). Night drains warmth faster and the jellies
glow. Storms roll through every few minutes — swell climbs, the sky closes,
swimming costs more. Shelter on the wreck or the island matters.

## Controls

- **Touch / on-screen:** left stick move · right stick look · ▲▼ depth · action
  button appears when something is in reach
- **Desktop:** WASD · click for mouse-look · Space/E up · Shift/Q dive · **F**
  to take, eat, drink or open

## Dev

- `npm run shot` — headless vantage points into `shots/`, fails loudly on
  console or shader errors. Needs `npm run dev` running.
  `SHOT_BASE=http://localhost:5174` follows the dev server if it moved port;
  `SHOT_ONLY=storm,night` re-shoots matching views (comma-separated).
- `?x=&z=&yaw=&pitch=&depth=` spawns anywhere.
- `?hour=22` starts at night, `?storm=1` locks a full squall — for tuning.
- In dev, `window.ww` exposes player, vitals, salvage, climate and the
  interaction registry.

Brain notes: `../agenticiallyjus/projects/waterworld.md`
