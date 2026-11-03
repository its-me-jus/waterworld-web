# Diver rig

The diver now has four continuous skinned limb meshes and a fitted torso (`src/anatomy.ts`). Each limb has three bones: shoulder/elbow/wrist or hip/knee/ankle. `src/swimmer.ts` blends crawl, breaststroke, rest and walk. Arm roots follow the torso while shoulder rotations compensate for torso pitch. World → Track diver shows the same rig from a tracking camera. A hood, mask and snorkel appear in that view.

Neoprene panels are integral vertex colours. Swimming darkens the cloth and adds a wet sheen. Ashore, the hood and suit gradually dry and their knit becomes more visible. Owned Blender gloves have an organic palm, gently curved fingers, authored smooth normals and a cupping morph. Source: `tools/blender/create_swimmer_hand.py`. Regenerate with `npm run hands`; the Blender script accepts `--no-preview` for export without a rendered image. Each glove is limited to 6,000 triangles.

On grounded walking frames, the rig samples actual terrain at each ankle and solves hip/knee flexion for upward foot clearance. Swing clearance is preserved, soles stay level and free fall bypasses the correction. This does not implement full planted-foot locomotion or foot locking.

The loaded character uses 35,188 triangles, 21,604 vertices and four skinned meshes. No new third-party assets or dependencies.

With the dev server running, set SHOT_BASE to its URL and run `node scripts/check-character.mjs`. The check covers 75 poses, skin weights, wrist attachment, walk-to-swim recovery, foot clearance on a slope and browser errors. Studio and beach screenshots are saved under `review/character/`. `/tools/character-studio.html` is a development inspection page and is not an entry point of the production build.

Real-device performance, subjective animation feel and extreme terrain contacts still need playtesting.
