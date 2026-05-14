# FLIPPER

A neon-tinted, fully-emergent yes/no oracle. Ask the universe a question, hit
**FLIP**, and a short Rube-Goldberg machine plays out under live physics —
worm flick → Plinko field → seesaw → one of (dominoes / hammer / frog /
magnetic bumper) → final paddle → **YES** or **NO**.

Nothing is rigged. Every component injects randomness (jittered angles,
varied restitution, occasional wind gusts, creature reaction-time rolls),
so the same setup can plausibly end either way.

After the result, **Replay in slow-mo** highlights the *butterfly point* —
the step at which the smallest perturbation would have flipped the outcome,
computed by re-simulating with tiny variations.

## Stack

- **Physics:** [matter-js](https://brm.io/matter-js/)
- **Render:** plain Canvas 2D with `shadowBlur` glow + lighter-composited
  particle trails. Zero raster art — everything is circles, rectangles,
  polygons, lines, arcs.
- **Audio:** [Tone.js](https://tonejs.github.io/) — synthesized only. Each
  material has its own timbre (metal pegs, soft pads, magnetic bumpers);
  ascending arpeggio on YES, descending on NO.

No backend. No accounts. No saves. Single static site — `index.html`,
`styles.css`, `app.js`. Drop it anywhere static (GitHub Pages works).

## Run locally

```
python3 -m http.server 8000
# open http://localhost:8000
```

Or just double-click `index.html`.

## Deploy to GitHub Pages

1. Push this folder to a GitHub repo.
2. Repo → Settings → Pages → Source: `main` branch, `/ (root)`.
3. Visit `https://<you>.github.io/<repo>/`.
