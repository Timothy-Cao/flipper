# FLIPPER — agent notes

A neon Rube-Goldberg yes/no oracle. Static site: `index.html`, `styles.css`,
`app.js`, plus a tiny `favicon.svg`. No build step, no backend, no tests —
verification is visual.

## Architecture

Everything lives in `app.js` inside one IIFE. Major regions, in file order:

- **RNG (Mulberry32):** seeded so every flip is reproducible. `rand` is
  reassigned per build.
- **Audio (`A`):** Tone.js synths, lazily initialized on first FLIP click.
  All triggers are best-effort; failures fall through silently.
- **World state globals:** `engine`, `world`, `ball`, `signs`, `modules`.
  `modules` is a per-build bag of references (worm chain, pegs, seesaw, the
  chosen random module, slopes, paddle).
- **`build(seed)`:** constructs the scene. Stages, in vertical order:
  1. Worm + ball at the top (random side)
  2. Plinko peg field (5 rows, ±5° jitter)
  3. Seesaw
  4. One of `dominoes | hammer | frog | magnet`
  5. Funnel slopes → hinged paddle → YES/NO sensor zones spanning the bottom
- **Collision handlers** bump `currentStepIndex` 0→5 according to what the
  ball just hit. `stepLabels[]` maps those indices to display names.
- **`finishRun(which)`:** sets the result, holds in slow-mo for ~1.2s,
  reveals the verdict, then computes the butterfly point.
- **`silentRun(seed, perturbStep, sampleId)`:** rebuilds the same seeded
  scene and steps the engine synchronously to completion with an optional
  tiny impulse at `perturbStep`. Snapshots and restores the world-state
  globals. **Do not run anything that touches `engine`/`ball`/`modules`
  while this is awaited.**
- **Main loop (`loop`)** runs at rAF; `scheduleNext` falls back to
  `setTimeout(24)` when rAF is throttled (hidden tabs, iframe previews).

## Critical conventions

- **Matter constraints with one body and a world anchor** use
  `{pointA: worldPoint, bodyB: theBody, pointB: offset}`. The inverse
  (`bodyA` + `pointA`) makes Matter throw on `Vector.sub` during
  `Constraint.create` — don't reintroduce that.
- **Step transitions:** peg→2, seesaw/ledge/slope→3, module→4, paddle→5.
  Always use `if (currentStepIndex < N) currentStepIndex = N;` so step
  indices never regress.
- **Outcome detection** is sensor-based. YES/NO sensors span the full half
  of the canvas each, so the ball always lands in one. A 9s safety timeout
  is a backstop, not the primary mechanism.

## Local dev

```
python3 -m http.server 8000
# open http://localhost:8000
```

`.claude/launch.json` defines a `flipper` preview server on port 8765 for
agent tooling.

## Deploy

Vercel auto-detects the repo as a static site. No build, no env. The
`vercel.json` sets security headers and short cache on JS/CSS so updates
ship quickly.

## When making changes

- Prefer editing `app.js` over splitting files — the toy is intentionally
  one TU.
- Verify visually in the preview (`mcp__Claude_Preview__preview_start` →
  click FLIP → screenshot). The iframe throttles rAF, so use
  `setInterval(()=>{},50)` keepalives during testing if needed.
- Keep additions primitive-only (circles, rectangles, polygons, lines,
  arcs). No raster art.
