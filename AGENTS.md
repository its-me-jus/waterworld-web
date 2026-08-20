# AGENTS.md

## Cursor Cloud specific instructions

WaterWorld is a **pure client-side game** — Vite + Three.js + TypeScript, no
backend, no database. Everything in the scene is generated at runtime. All the
run/build/test commands live in `package.json` (`scripts`) and are documented in
`README.md` (`## Local` and `## Dev`); prefer those sources over duplicating
commands here. The notes below are the non-obvious gotchas.

### Running it
- `npm run dev` serves the game on **http://localhost:5173** (Vite's default).
  Note `README.md` mentions port 5174 in a couple of places and `scripts/smoke.mjs`
  defaults `SHOT_BASE` to 5174 — the actual dev port here is 5173, so pass
  `SHOT_BASE=http://localhost:5173` to any script.
- There is no separate "lint" tool. The lint gate is TypeScript's strict flags
  (`noUnusedLocals`/`noUnusedParameters`/etc. under `tsconfig.json` "Linting").
  Use `npx tsc --noEmit` (fast typecheck/lint) or `npm run build` (`tsc && vite build`).

### Headless tests / screenshot scripts (`npm run smoke|test:base|test:camp|test:save|shot*`)
- They drive Chrome through `playwright-core`, which does **not** bundle a
  browser. A system Chrome is present at `/usr/local/bin/google-chrome`. Always
  export `CHROME_PATH=/usr/local/bin/google-chrome` — several scripts otherwise
  default to a Windows path (`C:\...\chrome.exe`) and fail.
- All of these scripts require `npm run dev` to already be running. Run them as:
  `CHROME_PATH=/usr/local/bin/google-chrome SHOT_BASE=http://localhost:5173 npm run <script>`
- The headless (SwiftShader) renderer is **slow**: expect ~2–5 min per suite.
  `scripts/test-base.mjs` / `test-camp` / `test-save` wait on runtime conditions
  and are reliable (test:base is fully green here). `scripts/smoke.mjs` mixes in
  fixed `waitForTimeout` clocks, so its shark-arming / spear-whisper / swim→walk
  checks can spuriously FAIL purely on timing even when the game is fine — prefer
  the condition-based suites when you need a trustworthy pass/fail signal.

### Debugging / driving the game
- In dev, `window.ww` exposes live state (player, vitals, salvage, climate,
  shark, improvise, interaction registry) and `window.__spots` marks loot spots.
- URL query params spawn scenarios: `?x=&z=&yaw=&pitch=&depth=` (spawn anywhere),
  `?knife=1 ?spear=1 ?suit=1 ?lantern=1` (start with gear), `?shark=N`, `?storm=1`,
  `?calm=1`, `?hour=22`, `?breath= ?food= ?energy= ?wound=1`. Full list in `README.md`.

### Not needed to run/play
- The audio (`npm run audio`/`audio:lyria`) and asset generators read API keys
  from `.env` (`ELEVENLABS_API_KEY`, `GEMINI_API_KEY`); the committed audio/assets
  already cover normal dev, so these are optional and keys are never shipped to
  the client.
