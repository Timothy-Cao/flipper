# FLIPPER

A neon-tinted, fully-emergent yes/no oracle. Ask the universe a question, hit
**FLIP**, and a short Rube-Goldberg machine plays out under live physics:

> worm flick → Plinko field → seesaw → one of (dominoes / hammer / frog /
> magnetic bumper) → final paddle → **YES** or **NO**

Nothing is rigged. Every component injects randomness — jittered angles,
varied restitution, occasional wind gusts, creature reaction-time rolls —
so the same setup can plausibly end either way. Run it twice and the result
might flip.

After it lands, **Replay in slow-mo** highlights the *butterfly point*: the
step at which the smallest nudge would have flipped the outcome. It's
computed by silently re-simulating the same scene with tiny perturbations
injected at each stage and counting how often the answer changes.

## Try it

[**flipper.vercel.app**](https://flipper.vercel.app) *(or wherever you've
hosted it)*

Keyboard:
- <kbd>Space</kbd> / <kbd>F</kbd> — flip
- <kbd>R</kbd> — replay in slow-mo
- <kbd>M</kbd> — mute / unmute

## Stack

- **Physics:** [matter-js](https://brm.io/matter-js/) — rigid bodies, springs,
  sensor zones, seeded RNG so every flip is reproducible.
- **Render:** plain Canvas 2D with `shadowBlur` glow + additive (`lighter`)
  particle trails. Zero raster art — everything is circles, rectangles,
  polygons, lines, arcs.
- **Audio:** [Tone.js](https://tonejs.github.io/) — synthesized only. Each
  material has its own timbre (MetalSynth pegs, MembraneSynth soft surfaces,
  FM magnet bumpers, sawtooth lead for the result arpeggios), under a low
  ambient hum.

No backend. No accounts. No saves. Single static site — `index.html`,
`styles.css`, `app.js`, plus `favicon.svg`.

## How "butterfly point" works

1. The live flip is seeded with a random 32-bit integer. That seed feeds a
   deterministic RNG, so the entire scene (peg angles, module choice,
   flick power, slope tilt) is reproducible.
2. When the result lands, the engine snapshots the seed and runs a few dozen
   silent re-simulations of the *same* seed.
3. Each silent re-sim applies a tiny random impulse to the ball at one
   specific stage (flick → plinko → seesaw → module → final).
4. For each stage, count how often that nudge flipped the outcome. The
   highest flip-rate stage is the butterfly point — the moment the run was
   most sensitive to a small perturbation.
5. On replay, a gold ring traces the ball through that stage.

If no stage's perturbations flipped the result, the run is reported as
**stable** — the answer was robust.

## Run locally

```
python3 -m http.server 8000
# open http://localhost:8000
```

Or open `index.html` directly in any modern browser.

## Deploy to Vercel

1. Push the repo to GitHub.
2. In Vercel, "Add New… → Project" → import the GitHub repo.
3. Leave the build settings empty — it's a static site. Hit Deploy.

`vercel.json` sets security headers (`X-Content-Type-Options`,
`Referrer-Policy`, `Permissions-Policy`) and short cache on JS/CSS so updates
ship quickly.

CDN scripts are subresource-integrity-pinned for tamper resistance.

## Sharing a specific flip

The seed is reflected into the URL as `?seed=<hex>&q=<question>` after each
flip. The **Share** button copies that link to the clipboard. Open the link
and hit FLIP — you get the same machine, byte-for-byte (the result can still
diverge from the original because runtime physics is not bit-exact across
machines; this is a feature, not a bug).

## Not yet (stretch goals from the original spec)

- Hidden escape module (~1/200 flips where the ball leaves the frame)
- Question-tone biasing creature reaction speed
- Daily shared flip

## Credits

- Matter.js — MIT, © Liam Brummitt
- Tone.js — MIT, © Yotam Mann

This project is MIT — see `LICENSE`.
