/* FLIPPER — Rube Goldberg yes/no oracle.
 * Physics: Matter.js  |  Render: Canvas 2D  |  Audio: Tone.js
 * Everything is emergent. Seeded RNG so we can replay & probe for butterfly points.
 */

(() => {
  // ───────────────────────────── DOM
  const canvas   = document.getElementById('world');
  const ctx      = canvas.getContext('2d');
  const menu     = document.getElementById('menu');
  const banner   = document.getElementById('banner');
  const result   = document.getElementById('result');
  const verdict  = document.getElementById('verdict');
  const butterfly= document.getElementById('butterfly');
  const flipBtn  = document.getElementById('flip');
  const againBtn = document.getElementById('again');
  const replayBtn= document.getElementById('replay');
  const qInput   = document.getElementById('question');
  const fatal    = document.getElementById('fatal');
  const muteBtn  = document.getElementById('mute');
  const shareBtn = document.getElementById('share');
  const toast    = document.getElementById('toast');

  if (!window.Matter) {
    if (fatal) {
      fatal.textContent = 'FLIPPER needs Matter.js to run. Check your connection and refresh.';
      fatal.classList.remove('hidden');
    }
    menu?.classList.add('hidden');
    return;
  }

  const { Engine, World, Bodies, Body, Composite, Constraint, Events } = window.Matter;
  const ToneLib = window.Tone;

  const W = canvas.width, H = canvas.height;
  function syncCanvasScale() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const targetW = Math.round(W * dpr);
    const targetH = Math.round(H * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }
  syncCanvasScale();
  window.addEventListener('resize', syncCanvasScale);

  // ───────────────────────────── RNG (Mulberry32) — seeded for replay
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function() {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  let rand = Math.random;
  const rrange = (a, b) => a + (b - a) * rand();
  const choice = (arr) => arr[Math.floor(rand() * arr.length)];

  // ───────────────────────────── Audio
  const A = {
    ready: false,
    metal: null, soft: null, magnet: null,
    yes: null, no: null, hum: null,
    async init() {
      if (this.ready) return;
      if (!ToneLib) return;
      await ToneLib.start();
      this.metal = new ToneLib.MetalSynth({
        frequency: 240, envelope: { attack: 0.001, decay: 0.18, release: 0.1 },
        harmonicity: 4.1, modulationIndex: 18, resonance: 3500, octaves: 1.2,
        volume: -18
      }).toDestination();
      this.soft = new ToneLib.MembraneSynth({
        pitchDecay: 0.04, octaves: 4, envelope: { attack: 0.001, decay: 0.2, sustain: 0 },
        volume: -16
      }).toDestination();
      this.magnet = new ToneLib.FMSynth({
        harmonicity: 2.6, modulationIndex: 6,
        envelope: { attack: 0.002, decay: 0.25, sustain: 0, release: 0.2 },
        volume: -20
      }).toDestination();
      this.lead = new ToneLib.Synth({
        oscillator: { type: 'sawtooth' },
        envelope: { attack: 0.01, decay: 0.2, sustain: 0.1, release: 0.4 },
        volume: -14
      }).toDestination();
      // ambient hum
      this.hum = new ToneLib.Oscillator(55, 'sine').toDestination();
      this.hum.volume.value = -34;
      this.hum.start();
      this.ready = true;
    },
    blip(kind, v = 1) {
      if (!this.ready) return;
      const t = ToneLib.now();
      v = Math.min(1, Math.max(0.05, v));
      try {
        if (kind === 'metal') this.metal.triggerAttackRelease('C2', '16n', t, v * 0.6);
        else if (kind === 'soft') this.soft.triggerAttackRelease(80 + rand() * 40, '8n', t, v * 0.7);
        else if (kind === 'magnet') this.magnet.triggerAttackRelease(220 + rand() * 80, '16n', t, v * 0.5);
        else if (kind === 'sign') this.lead.triggerAttackRelease('G4', '8n', t, v);
      } catch (e) {}
    },
    arpeggio(up) {
      if (!this.ready) return;
      const notes = up ? ['C4', 'E4', 'G4', 'C5', 'E5'] : ['E5', 'C5', 'G4', 'E4', 'C4'];
      const t = ToneLib.now();
      notes.forEach((n, i) => this.lead.triggerAttackRelease(n, '8n', t + i * 0.09, 0.8));
    }
  };

  // ───────────────────────────── World
  let engine, world, ball, signs, paddleBody;
  let particles = [];        // ball trail
  let sparks = [];           // collision sparks
  let modules = {};          // references to module bodies for drawing
  let camera = { x: W/2, y: H/2, zoom: 1, targetX: W/2, targetY: H/2, targetZoom: 1 };
  let runStartTime = 0;
  let currentSeed = 0;
  let outcome = null;        // 'yes' | 'no'
  let mode = 'idle';         // 'idle' | 'running' | 'done' | 'replaying'
  let slowmoFactor = 1;      // engine time scale
  let highlightStep = -1;    // butterfly step to highlight
  let highlightHitAt = 0;    // when, in replay, the butterfly step was first reached
  let resultDim = 0;         // 0..1 — alpha of the dim wash behind the verdict
  const stepLabels = ['flick', 'plinko', 'seesaw', 'module', 'final'];
  let currentStepIndex = 0;
  const reducedMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ───────────────────────────── Build scene
  function clearWorld() {
    if (engine) { World.clear(world, false); Engine.clear(engine); }
    engine = Engine.create();
    world = engine.world;
    engine.gravity.y = 1.2;
    particles = []; sparks = []; modules = {};
    currentStepIndex = 0;
  }

  function build(seed) {
    rand = mulberry32(seed);
    currentSeed = seed;
    clearWorld();

    // walls
    const wallOpt = { isStatic: true, restitution: 0.4, friction: 0.4, label: 'wall' };
    World.add(world, [
      Bodies.rectangle(W/2, H + 20, W, 60, wallOpt),
      Bodies.rectangle(-20, H/2, 40, H * 2, wallOpt),
      Bodies.rectangle(W + 20, H/2, 40, H * 2, wallOpt),
    ]);

    // ──── Step 1: Worm + ball at top — random side, random flick direction
    const startSide = rand() < 0.5 ? -1 : 1;        // worm on left or right
    const startX = W / 2 + startSide * (W * 0.30 + rrange(-12, 12));
    const startY = 90;
    const wormDir = -startSide;                      // worm tail trails away from center
    const wormSegments = [];
    let prev = null;
    const segCount = 6 + Math.floor(rand() * 3);
    for (let i = 0; i < segCount; i++) {
      const seg = Bodies.circle(startX + wormDir * (20 + i * 14), startY + Math.sin(i) * 4, 7, {
        friction: 0.2, restitution: 0.3, density: 0.002, label: 'worm'
      });
      wormSegments.push(seg);
      if (prev) {
        World.add(world, Constraint.create({
          bodyA: prev, bodyB: seg, length: 14, stiffness: 0.6, damping: 0.2
        }));
      }
      prev = seg;
    }
    // anchor first segment loosely
    World.add(world, Constraint.create({
      pointA: { x: startX + wormDir * 20, y: startY },
      bodyB: wormSegments[0], pointB: { x: 0, y: 0 },
      length: 0, stiffness: 0.05, damping: 0.1
    }));
    World.add(world, wormSegments);
    modules.worm = wormSegments;

    // Ball
    ball = Bodies.circle(startX, startY, 11, {
      restitution: 0.55, friction: 0.005, frictionAir: 0.001,
      density: 0.006, label: 'ball'
    });
    World.add(world, ball);

    // ──── Step 2: Plinko field
    const pegs = [];
    const rows = 5;
    const pegY0 = 220;
    const pegSpacingY = 46;
    for (let r = 0; r < rows; r++) {
      const cols = 5 + (r % 2);
      const gap = W / (cols + 1);
      for (let c = 0; c < cols; c++) {
        const px = gap * (c + 1) + ((r % 2) ? -gap / 2 : 0) + rrange(-6, 6);
        const py = pegY0 + r * pegSpacingY + rrange(-3, 3);
        const angle = rrange(-Math.PI / 36, Math.PI / 36); // ±5°
        const peg = Bodies.rectangle(px, py, 28, 6, {
          isStatic: true, angle, restitution: rrange(0.45, 0.65),
          friction: 0.05, label: 'peg'
        });
        pegs.push(peg);
      }
    }
    World.add(world, pegs);
    modules.pegs = pegs;

    // ──── Step 3: Seesaw
    const seesawY = 500;
    const seesawX = W / 2 + rrange(-30, 30);
    const seesaw = Bodies.rectangle(seesawX, seesawY, 220, 8, {
      restitution: rrange(0.4, 0.6), friction: 0.3, density: 0.004, label: 'seesaw'
    });
    Body.setAngle(seesaw, rrange(-0.05, 0.05));
    World.add(world, seesaw);
    World.add(world, Constraint.create({
      pointA: { x: seesawX, y: seesawY },
      bodyB: seesaw, pointB: { x: 0, y: 0 },
      length: 0, stiffness: 0.9, damping: 0.1
    }));
    modules.seesaw = seesaw;

    // ──── Step 4: Random module
    const modY = 620;
    const modKind = choice(['dominoes', 'hammer', 'frog', 'magnet']);
    modules.kind = modKind;
    if (modKind === 'dominoes') {
      const arr = [];
      const baseX = 110 + rrange(-10, 10);
      for (let i = 0; i < 5; i++) {
        const d = Bodies.rectangle(baseX + i * 50, modY, 8, 44, {
          restitution: 0.2, friction: 0.5, density: 0.003, label: 'domino'
        });
        arr.push(d);
      }
      World.add(world, arr);
      modules.dominoes = arr;
      // floor under dominoes
      const ledge = Bodies.rectangle(W/2, modY + 26, W * 0.7, 8, {
        isStatic: true, angle: rrange(-0.02, 0.02), label: 'ledge'
      });
      World.add(world, ledge);
      modules.ledge = ledge;
    } else if (modKind === 'hammer') {
      const px = W/2 + rrange(-30, 30);
      const py = modY - 70;
      const hammer = Bodies.rectangle(px, py + 60, 16, 90, {
        density: 0.01, friction: 0.2, restitution: 0.4, label: 'hammer'
      });
      Body.setAngle(hammer, rrange(-0.6, 0.6));
      World.add(world, hammer);
      World.add(world, Constraint.create({
        pointA: { x: px, y: py },
        bodyB: hammer, pointB: { x: 0, y: -45 },
        length: 0, stiffness: 0.95
      }));
      modules.hammer = hammer;
    } else if (modKind === 'frog') {
      const px = W/2 + rrange(-80, 80);
      const frog = Bodies.polygon(px, modY, 3, 22, {
        restitution: 0.4, friction: 0.3, density: 0.005, label: 'frog'
      });
      World.add(world, frog);
      modules.frog = frog;
      modules.frogTimer = rrange(0.4, 1.4);
      // ledge for frog
      const ledge = Bodies.rectangle(W/2, modY + 28, W * 0.6, 8, {
        isStatic: true, angle: rrange(-0.02, 0.02), label: 'ledge'
      });
      World.add(world, ledge);
      modules.ledge = ledge;
    } else { // magnet
      const px = W/2 + rrange(-60, 60);
      const bumper = Bodies.circle(px, modY, 26, {
        isStatic: true, restitution: 1.0, label: 'magnet'
      });
      World.add(world, bumper);
      modules.magnet = bumper;
      modules.magnetSign = rand() < 0.5 ? -1 : 1;
      modules.magnetStrength = rrange(0.0006, 0.0012);
    }

    // ──── Step 5: Funnel + final paddle + signs
    const floorY = 880;
    const slopeL = Bodies.rectangle(W * 0.22, 780, 220, 8, {
      isStatic: true, angle: rrange(0.22, 0.32), label: 'slope'
    });
    const slopeR = Bodies.rectangle(W * 0.78, 780, 220, 8, {
      isStatic: true, angle: rrange(-0.32, -0.22), label: 'slope'
    });
    World.add(world, [slopeL, slopeR]);
    modules.slopes = [slopeL, slopeR];

    // Spider (decorative creature) tucked above the YES/NO signs.
    // Articulated legs animated in the loop; `alert` ramps up when the ball is close.
    const spiderX = W/2 + rrange(-20, 20);
    const spiderY = 820;
    modules.spider = {
      x: spiderX,
      y: spiderY,
      phase: rand() * Math.PI * 2,
      alert: 0
    };

    // Paddle that the ball strikes — it tips and tells us yes/no
    const paddleY = 850;
    const paddle = Bodies.rectangle(W/2, paddleY, 26, 26, {
      density: 0.003, restitution: 0.3, friction: 0.4, label: 'paddle'
    });
    Body.setAngle(paddle, rrange(-0.1, 0.1));
    World.add(world, paddle);
    World.add(world, Constraint.create({
      pointA: { x: W/2, y: paddleY + 18 },
      bodyB: paddle, pointB: { x: 0, y: 8 },
      length: 0, stiffness: 0.7, damping: 0.05
    }));
    paddleBody = paddle;

    // Signs — sensors covering full bottom width so any ball lands in one of them.
    // Visual signs render at center of each half; the sensor itself spans the full half.
    const yesZone = Bodies.rectangle(W * 0.25, floorY, W * 0.5, 60, {
      isStatic: true, isSensor: true, label: 'yes'
    });
    const noZone = Bodies.rectangle(W * 0.75, floorY, W * 0.5, 60, {
      isStatic: true, isSensor: true, label: 'no'
    });
    World.add(world, [yesZone, noZone]);
    signs = { yes: yesZone, no: noZone, yesGlow: 0, noGlow: 0, decided: null };

    // ground
    const ground = Bodies.rectangle(W/2, floorY + 26, W * 1.5, 10, {
      isStatic: true, label: 'ground'
    });
    World.add(world, ground);

    // Initial worm flick — direction biased toward center but jittered enough to favor either side.
    // Animated as a wind-up: the worm visibly pulls back, then snaps forward into the ball.
    const flickPower = rrange(0.013, 0.022);
    const flickAngle = rrange(-0.35, 0.35);
    const flickSign = -startSide;                     // toward the opposite side
    modules.flick = { power: flickPower, angle: flickAngle, sign: flickSign, startSide };

    // Cache of wind-affected bodies so the gust loop doesn't traverse all bodies.
    modules.windTargets = Composite.allBodies(world).filter(
      b => !b.isStatic && b.mass < 0.05 && b.label !== 'ball'
    );

    modules.windUp = {
      t: 0,
      pullUntil: 320,    // ms of "pull back" before release
      fireAt: 620,       // ms when the impulse actually fires
      fired: false,
      sign: startSide,
      flickSign
    };
  }

  // ───────────────────────────── Collision handling
  function attachCollisionHandlers() {
    Events.on(engine, 'collisionStart', (ev) => {
      for (const p of ev.pairs) {
        const a = p.bodyA, b = p.bodyB;
        const other = a.label === 'ball' ? b : (b.label === 'ball' ? a : null);
        if (!other) continue;
        const v = Math.min(20, Math.hypot(ball.velocity.x, ball.velocity.y));
        const intensity = Math.min(1, v / 12);
        // sparks
        const sp = p.collision.supports[0] || ball.position;
        for (let i = 0; i < 4 + Math.floor(intensity * 6); i++) {
          sparks.push({
            x: sp.x, y: sp.y,
            vx: rrange(-3, 3), vy: rrange(-3, 3),
            life: 1, color: choice(['#29f7ff', '#ff3df0'])
          });
        }
        if (other.label === 'peg') {
          A.blip('metal', intensity);
          if (currentStepIndex < 2) currentStepIndex = 2;
        } else if (other.label === 'seesaw' || other.label === 'ledge' || other.label === 'slope') {
          A.blip('soft', intensity * 0.8);
          if (currentStepIndex < 3) currentStepIndex = 3;
        } else if (other.label === 'magnet') {
          A.blip('magnet', intensity);
          if (currentStepIndex < 4) currentStepIndex = 4;
        } else if (other.label === 'domino' || other.label === 'hammer' || other.label === 'frog') {
          A.blip('metal', intensity * 0.7);
          if (other.label === 'frog' && modules.frog) {
            modules.frogFlinch = 0.001;            // small flinch pulse, decays in loop
          }
          if (currentStepIndex < 4) currentStepIndex = 4;
        } else if (other.label === 'paddle') {
          A.blip('metal', intensity * 1.2);
          if (currentStepIndex < 5) currentStepIndex = 5;
          // brief zoom pulse on the climactic strike
          camera.targetZoom = Math.max(camera.targetZoom, 1.12);
        } else if (other.label === 'worm') {
          A.blip('soft', intensity * 0.5);
        }

        // Outcome detection
        if (other.label === 'yes' && !signs.decided) {
          signs.decided = 'yes';
          finishRun('yes');
        } else if (other.label === 'no' && !signs.decided) {
          signs.decided = 'no';
          finishRun('no');
        }
      }
    });
  }

  // ───────────────────────────── Run lifecycle
  function startFlip(seed) {
    if (mode === 'running' || mode === 'replaying') return;
    mode = 'running';
    slowmoFactor = 1;
    outcome = null;
    highlightStep = -1;
    highlightHitAt = 0;
    resultDim = 0;
    currentSeed = seed >>> 0;
    menu.classList.add('hidden');
    result.classList.add('hidden');
    butterfly.textContent = '';
    butterfly.classList.remove('butterfly-armed');
    const q = qInput.value.trim();
    banner.textContent = q ? `“${q}”` : '';
    banner.classList.toggle('hidden', !q);
    build(currentSeed);
    attachCollisionHandlers();
    camera.x = W/2; camera.y = H/2;
    camera.targetX = W/2; camera.targetY = H/2;
    camera.zoom = 1; camera.targetZoom = 1;
    stuckFrames = 0; lastBallY = ball.position.y;
    runStartTime = performance.now();
    // Safety timeout: if nothing decides within 9s, force decision by ball x
    setTimeout(() => {
      if (!signs?.decided && (mode === 'running' || mode === 'replaying')) {
        finishRun(ball.position.x < W/2 ? 'yes' : 'no');
      }
    }, 9000);
  }

  function finishRun(which) {
    if (outcome) return;
    outcome = which;
    signs.decided = which;
    // climactic slow-mo + zoom (skipped under reduced-motion)
    camera.targetZoom = reducedMotion ? 1 : 1.6;
    slowmoFactor = reducedMotion ? 1 : 0.3;
    A.arpeggio(which === 'yes');
    const dwell = reducedMotion ? 150 : 1300;
    setTimeout(() => {
      mode = 'done';
      slowmoFactor = 1;
      camera.targetZoom = 1;
      verdict.textContent = which.toUpperCase();
      verdict.className = 'verdict ' + which;
      result.classList.remove('hidden');
      writeUrlState();
      // compute butterfly point asynchronously
      computeButterfly(currentSeed, which).then(step => {
        if (step >= 0 && stepLabels[step]) {
          butterfly.textContent =
            `BUTTERFLY POINT · STEP ${step + 1} — ${stepLabels[step].toUpperCase()}`;
          highlightStep = step;
        } else {
          butterfly.textContent = 'NO CLEAR BUTTERFLY POINT — RUN WAS STABLE';
          highlightStep = -1;
        }
      });
    }, dwell);
  }

  // ───────────────────────────── Butterfly point estimator
  // Re-run the exact same seeded scene N times, each time injecting a tiny random
  // impulse at one step boundary. The step with the highest flip rate is the
  // moment where the smallest nudge would have changed the outcome.
  async function computeButterfly(seed, baseOutcome) {
    const steps = 5;
    const samples = 6;
    const flips = new Array(steps).fill(0);
    for (let s = 0; s < steps; s++) {
      for (let k = 0; k < samples; k++) {
        const o = await silentRun(seed, s, k);
        if (o && o !== baseOutcome) flips[s]++;
        if (k % 3 === 0) await new Promise(r => setTimeout(r, 0));
      }
    }
    let bestStep = -1, bestRate = 0;
    for (let s = 0; s < steps; s++) {
      const rate = flips[s] / samples;
      if (rate > bestRate) { bestRate = rate; bestStep = s; }
    }
    return bestRate > 0 ? bestStep : -1;
  }

  // Simulate without rendering. Returns 'yes' | 'no' | null.
  // Builds a fresh scene via build(seed), steps the resulting engine to completion,
  // optionally nudging the ball when the run reaches `perturbStep`.
  function silentRun(seed, perturbStep, sampleId = 0) {
    return new Promise(resolve => {
      const origRand = rand;
      // snapshot real-run globals
      const realEngine = engine, realWorld = world, realBall = ball,
            realSigns = signs, realModules = modules,
            realStep = currentStepIndex, realSeed = currentSeed,
            realPaddle = paddleBody;
      try {
        build(seed);                // creates new engine/world/ball/signs/modules in globals
        const localRand = mulberry32((seed ^ (0xA53F + sampleId * 7919)) >>> 0);
        let done = null;
        // Perturb when stepIndex first reaches perturbStep+1 (i.e., entering that phase).
        // Magnitude is tiny — the whole point is to detect butterfly-sensitive steps.
        const checkStep = () => {
          if (currentStepIndex >= perturbStep + 1 && !modules._perturbed && ball) {
            modules._perturbed = true;
            const theta = localRand() * Math.PI * 2;
            const mag = 0.004;
            Body.applyForce(ball, ball.position, {
              x: Math.cos(theta) * mag, y: Math.sin(theta) * mag
            });
          }
        };
        Events.on(engine, 'collisionStart', (ev) => {
          for (const p of ev.pairs) {
            const other = p.bodyA.label === 'ball' ? p.bodyB :
                          p.bodyB.label === 'ball' ? p.bodyA : null;
            if (!other) continue;
            if (other.label === 'peg') {
              if (currentStepIndex < 2) currentStepIndex = 2;
            } else if (['seesaw','ledge','slope'].includes(other.label)) {
              if (currentStepIndex < 3) currentStepIndex = 3;
            } else if (['magnet','domino','hammer','frog'].includes(other.label)) {
              if (currentStepIndex < 4) currentStepIndex = 4;
            } else if (other.label === 'paddle') {
              if (currentStepIndex < 5) currentStepIndex = 5;
            }
            checkStep();
            if (other.label === 'yes' && !done) done = 'yes';
            if (other.label === 'no' && !done) done = 'no';
          }
        });
        // Trigger the initial flick now (real run uses a 600ms setTimeout)
        const f = modules.flick;
        Body.applyForce(ball, ball.position, {
          x: f.sign * Math.cos(f.angle) * f.power,
          y: Math.abs(Math.sin(f.angle)) * f.power * 0.3 + 0.005
        });
        currentStepIndex = 1;

        const dt = 1000/60;
        for (let i = 0; i < 60 * 14 && !done; i++) {
          if (modules.kind === 'magnet' && modules.magnet) {
            const dx = modules.magnet.position.x - ball.position.x;
            const dy = modules.magnet.position.y - ball.position.y;
            const d2 = dx*dx + dy*dy;
            if (d2 < 200*200 && d2 > 1) {
              const f = modules.magnetStrength * modules.magnetSign / Math.sqrt(d2);
              Body.applyForce(ball, ball.position, { x: dx * f, y: dy * f });
            }
          }
          Engine.update(engine, dt);
          checkStep();
          if (ball.position.y > H - 40 && !done) {
            done = ball.position.x < W/2 ? 'yes' : 'no';
          }
        }
        // Tear down this scene
        World.clear(world, false);
        Engine.clear(engine);
        // restore real-run globals
        engine = realEngine; world = realWorld; ball = realBall;
        signs = realSigns; modules = realModules;
        currentStepIndex = realStep; currentSeed = realSeed;
        paddleBody = realPaddle;
        rand = origRand;
        resolve(done);
      } catch (e) {
        engine = realEngine; world = realWorld; ball = realBall;
        signs = realSigns; modules = realModules;
        currentStepIndex = realStep; currentSeed = realSeed;
        paddleBody = realPaddle;
        rand = origRand;
        resolve(null);
      }
    });
  }

  // ───────────────────────────── Main loop
  let lastT = performance.now();
  let stuckFrames = 0;
  let lastBallY = 0;
  function loop(t) {
    const dt = Math.min(40, t - lastT);
    lastT = t;

    if (mode === 'running' || mode === 'replaying') {
      // Worm wind-up: visibly pull head back, then fire impulse into the ball.
      if (modules.windUp && !modules.windUp.fired && modules.worm) {
        const wu = modules.windUp;
        wu.t += dt * slowmoFactor;
        const head = modules.worm[modules.worm.length - 1];
        if (wu.t < wu.pullUntil) {
          // pull the worm head AWAY from the ball (back toward its anchor side)
          Body.applyForce(head, head.position, {
            x: wu.sign * 0.0018,
            y: -0.0006
          });
        }
        if (wu.t >= wu.fireAt) {
          wu.fired = true;
          const f = modules.flick;
          Body.applyForce(ball, ball.position, {
            x: f.sign * Math.cos(f.angle) * f.power,
            y: Math.abs(Math.sin(f.angle)) * f.power * 0.3 + 0.005
          });
          // worm recoil — head snaps forward then bounces back
          Body.applyForce(head, head.position, { x: -wu.sign * 0.0035, y: -0.004 });
          A.blip('soft', 0.8);
          if (currentStepIndex < 1) currentStepIndex = 1;
        }
      }

      // magnet pull on live engine
      if (modules.kind === 'magnet' && modules.magnet && ball) {
        const dx = modules.magnet.position.x - ball.position.x;
        const dy = modules.magnet.position.y - ball.position.y;
        const d2 = dx*dx + dy*dy;
        if (d2 < 200*200 && d2 > 1) {
          const fmag = modules.magnetStrength * modules.magnetSign / Math.sqrt(d2);
          Body.applyForce(ball, ball.position, { x: dx * fmag, y: dy * fmag });
        }
      }

      // occasional wind gust on light bodies — cached list, not full traversal.
      if (rand() < 0.01 && modules.windTargets) {
        const wind = (rand() - 0.5) * 0.0008;
        for (const b of modules.windTargets) {
          Body.applyForce(b, b.position, { x: wind, y: 0 });
        }
      }

      // frog occasional hop + flinch decay
      if (modules.kind === 'frog' && modules.frog) {
        modules.frogTimer -= dt / 1000;
        if (modules.frogTimer <= 0) {
          Body.applyForce(modules.frog, modules.frog.position, {
            x: (rand() - 0.5) * 0.004,
            y: -0.012
          });
          modules.frogTimer = rrange(0.6, 1.6);
        }
        if (modules.frogFlinch > 0) {
          modules.frogFlinch = Math.max(0, modules.frogFlinch - dt * 0.0035);
        }
      }

      // Spider proximity twitch — accelerate leg phase + offset when ball is close.
      if (modules.spider && ball) {
        const sp = modules.spider;
        const ddx = sp.x - ball.position.x;
        const ddy = sp.y - ball.position.y;
        const dist = Math.hypot(ddx, ddy);
        sp.alert = Math.max(0, sp.alert - dt * 0.003);
        if (dist < 90) sp.alert = Math.min(1, sp.alert + 0.08);
      }

      Engine.update(engine, dt * slowmoFactor);

      // ball trail particle
      if (ball) {
        particles.push({ x: ball.position.x, y: ball.position.y, life: 1 });
        if (particles.length > 40) particles.shift();
      }

      // Anti-stuck: if the ball isn't making downward progress, nudge it.
      // Only kicks in after the wind-up so the ball isn't yanked off the worm.
      if (ball && (!modules.windUp || modules.windUp.fired)) {
        const ddy = ball.position.y - lastBallY;
        if (ddy < 0.5) {
          stuckFrames++;
          if (stuckFrames > 40) {
            Body.applyForce(ball, ball.position, {
              x: (rand() - 0.5) * 0.014, y: 0.006
            });
            stuckFrames = 0;
          }
        } else {
          stuckFrames = 0;
        }
        lastBallY = ball.position.y;
      }

      // Butterfly tracking during replay — stamp the moment we first reach the step.
      if (mode === 'replaying' && highlightStep >= 0 && highlightHitAt === 0 &&
          currentStepIndex >= highlightStep + 1) {
        highlightHitAt = performance.now();
      }

      // camera follow — gentle bias toward the ball's vertical position
      if (ball) {
        camera.targetX = W/2 + (ball.position.x - W/2) * 0.25;
        camera.targetY = Math.max(H * 0.45, Math.min(H * 0.62, ball.position.y * 0.55 + H * 0.28));
      }
    }

    // Result dim — fades up after outcome is set; sits behind the verdict text.
    if (outcome && mode !== 'replaying') {
      resultDim = Math.min(0.55, resultDim + 0.02);
    } else {
      resultDim = Math.max(0, resultDim - 0.04);
    }

    // camera smoothing
    camera.x += (camera.targetX - camera.x) * 0.06;
    camera.y += (camera.targetY - camera.y) * 0.06;
    camera.zoom += (camera.targetZoom - camera.zoom) * 0.04;

    // sign glow pulse on outcome
    if (signs && outcome === 'yes') signs.yesGlow = Math.min(1, signs.yesGlow + 0.04);
    if (signs && outcome === 'no')  signs.noGlow  = Math.min(1, signs.noGlow + 0.04);

    render();
    scheduleNext(loop);
  }

  function scheduleNext(fn) {
    let called = false;
    const guard = (t) => { if (called) return; called = true; fn(t || performance.now()); };
    const id = setTimeout(() => guard(performance.now()), 24);
    requestAnimationFrame((t) => { clearTimeout(id); guard(t); });
  }

  // ───────────────────────────── Rendering
  function applyCamera() {
    ctx.translate(W/2, H/2);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-camera.x, -camera.y);
  }

  function render() {
    // BG — vertical gradient
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0,   '#0a0e22');
    bg.addColorStop(0.5, '#05060d');
    bg.addColorStop(1,   '#000003');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Side neon strips (casino trim)
    const stripPulse = 0.7 + Math.sin(performance.now() / 700) * 0.15;
    const strip = ctx.createLinearGradient(0, 0, 24, 0);
    strip.addColorStop(0, 'rgba(255, 61, 240, ' + (0.55 * stripPulse) + ')');
    strip.addColorStop(1, 'rgba(255, 61, 240, 0)');
    ctx.fillStyle = strip; ctx.fillRect(0, 0, 24, H);
    const stripR = ctx.createLinearGradient(W, 0, W - 24, 0);
    stripR.addColorStop(0, 'rgba(41, 247, 255, ' + (0.55 * stripPulse) + ')');
    stripR.addColorStop(1, 'rgba(41, 247, 255, 0)');
    ctx.fillStyle = stripR; ctx.fillRect(W - 24, 0, 24, H);

    // Perspective grid (tron floor)
    const horizon = H * 0.42;
    ctx.save();
    ctx.lineWidth = 1;
    // horizontal lines — denser/brighter near bottom
    for (let i = 0; i < 18; i++) {
      const t = i / 17;
      const y = horizon + Math.pow(t, 1.8) * (H - horizon);
      ctx.strokeStyle = `rgba(41, 247, 255, ${0.05 + t * 0.32})`;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    // vanishing vertical lines from horizon
    const vp = W / 2;
    for (let i = -12; i <= 12; i++) {
      const xBottom = W / 2 + i * (W / 16);
      ctx.strokeStyle = `rgba(255, 61, 240, ${0.04 + Math.abs(i) * 0.012})`;
      ctx.beginPath();
      ctx.moveTo(vp, horizon);
      ctx.lineTo(xBottom, H);
      ctx.stroke();
    }
    // horizon glow line
    const horizGrad = ctx.createLinearGradient(0, horizon - 6, 0, horizon + 12);
    horizGrad.addColorStop(0, 'rgba(41, 247, 255, 0)');
    horizGrad.addColorStop(0.5, 'rgba(41, 247, 255, 0.55)');
    horizGrad.addColorStop(1, 'rgba(41, 247, 255, 0)');
    ctx.fillStyle = horizGrad;
    ctx.fillRect(0, horizon - 6, W, 18);
    ctx.restore();

    if (!engine || !signs) return;
    ctx.save();
    applyCamera();

    // Sign zones (drawn under everything)
    drawSignZone(signs.yes, 'YES', '#5cff7a', signs.yesGlow, outcome === 'yes');
    drawSignZone(signs.no,  'NO',  '#ff4d68', signs.noGlow,  outcome === 'no');

    // sparks
    ctx.globalCompositeOperation = 'lighter';
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.x += s.vx; s.y += s.vy; s.vy += 0.15; s.life -= 0.04;
      if (s.life <= 0) { sparks.splice(i, 1); continue; }
      ctx.fillStyle = s.color;
      ctx.globalAlpha = s.life;
      ctx.shadowColor = s.color;
      ctx.shadowBlur = 12;
      ctx.beginPath(); ctx.arc(s.x, s.y, 2.2, 0, Math.PI * 2); ctx.fill();
    }
    ctx.shadowBlur = 0; ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    // pegs
    if (modules.pegs) for (const p of modules.pegs) drawRect(p, '#29f7ff', 8);
    // slopes
    if (modules.slopes) for (const s of modules.slopes) drawRect(s, '#ff3df0', 6);
    // ledge / seesaw
    if (modules.ledge) drawRect(modules.ledge, '#ff3df0', 6);
    if (modules.seesaw) drawRect(modules.seesaw, '#29f7ff', 10);
    // dominoes
    if (modules.dominoes) for (const d of modules.dominoes) drawRect(d, '#ff3df0', 8);
    // hammer
    if (modules.hammer) {
      drawRect(modules.hammer, '#ff3df0', 10);
      const p = modules.hammer.position;
      // pivot point indicator
      ctx.fillStyle = '#29f7ff'; ctx.shadowColor = '#29f7ff'; ctx.shadowBlur = 10;
      ctx.beginPath();
      // approximate pivot
      const a = modules.hammer.angle;
      ctx.arc(p.x - Math.sin(a) * 45, p.y - Math.cos(a) * 45, 3, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    }
    // frog — triangle body with eyes that follow rotation; flinch squishes briefly on hit
    if (modules.frog) {
      const f = modules.frog, p = f.position, a = f.angle;
      const flinch = modules.frogFlinch || 0;
      const sx = 1 + flinch * 12;
      const sy = 1 - flinch * 14;
      ctx.save();
      ctx.translate(p.x, p.y); ctx.rotate(a); ctx.scale(sx, sy);
      ctx.shadowColor = '#5cff7a'; ctx.shadowBlur = 18 + flinch * 30;
      ctx.fillStyle = '#5cff7a';
      ctx.beginPath();
      ctx.moveTo(0, -22); ctx.lineTo(20, 16); ctx.lineTo(-20, 16); ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(-6, -6, 3, 0, Math.PI * 2); ctx.arc(6, -6, 3, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.shadowBlur = 0;
    }
    // magnet bumper
    if (modules.magnet) {
      const p = modules.magnet.position;
      const col = modules.magnetSign > 0 ? '#ff3df0' : '#29f7ff';
      ctx.shadowColor = col; ctx.shadowBlur = 24;
      ctx.strokeStyle = col; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(p.x, p.y, 26, 0, Math.PI * 2); ctx.stroke();
      // ring pulse
      const pulse = (performance.now() / 200) % 1;
      ctx.globalAlpha = 1 - pulse;
      ctx.beginPath(); ctx.arc(p.x, p.y, 26 + pulse * 18, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    }

    // worm
    if (modules.worm) {
      ctx.shadowColor = '#ff3df0'; ctx.shadowBlur = 14;
      ctx.strokeStyle = '#ff3df0'; ctx.lineWidth = 5; ctx.lineCap = 'round';
      ctx.beginPath();
      modules.worm.forEach((s, i) => {
        if (i === 0) ctx.moveTo(s.position.x, s.position.y);
        else ctx.lineTo(s.position.x, s.position.y);
      });
      ctx.stroke();
      for (const s of modules.worm) {
        ctx.fillStyle = '#ff3df0';
        ctx.beginPath(); ctx.arc(s.position.x, s.position.y, 5, 0, Math.PI * 2); ctx.fill();
      }
      ctx.shadowBlur = 0;
    }

    // Spider — 8 articulated legs splayed below the body, each with a knee bend.
    // Calm idle wiggle; legs spasm when the ball is nearby (alert ramps in the loop).
    if (modules.spider) {
      const sp = modules.spider;
      sp.phase += 0.05 + sp.alert * 0.16;
      ctx.shadowColor = '#29f7ff'; ctx.shadowBlur = 14 + sp.alert * 16;
      ctx.strokeStyle = '#29f7ff'; ctx.lineWidth = 2.2; ctx.lineCap = 'round';

      const legCount = 8;
      const upperLen = 11, lowerLen = 14;
      for (let i = 0; i < legCount; i++) {
        // Distribute base angles across the lower hemisphere (π/4 .. 3π/4).
        // In canvas coords, π/4 = down-right, π/2 = straight down, 3π/4 = down-left.
        const t = i / (legCount - 1);
        const baseAng = Math.PI / 4 + t * (Math.PI / 2);
        const isLeft = baseAng > Math.PI / 2;
        // upper segment wiggles in idle, spasms on alert
        const wiggle = Math.sin(sp.phase + i * 0.7) * (0.04 + sp.alert * 0.18);
        const upperAng = baseAng + wiggle;
        // knee bend kicks lower segment outward (further from body's vertical axis)
        const bend = 0.55 + sp.alert * 0.5 + Math.sin(sp.phase * 1.4 + i) * 0.12;
        const lowerAng = upperAng + (isLeft ? bend : -bend);
        const kneeX = sp.x + Math.cos(upperAng) * upperLen;
        const kneeY = sp.y + Math.sin(upperAng) * upperLen;
        const footX = kneeX + Math.cos(lowerAng) * lowerLen;
        const footY = kneeY + Math.sin(lowerAng) * lowerLen;
        ctx.beginPath();
        ctx.moveTo(sp.x, sp.y);
        ctx.lineTo(kneeX, kneeY);
        ctx.lineTo(footX, footY);
        ctx.stroke();
      }

      // round body
      ctx.fillStyle = '#29f7ff';
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 7 + sp.alert * 1.4, 0, Math.PI * 2);
      ctx.fill();
      // tiny inset eyes
      ctx.fillStyle = '#03040a';
      ctx.beginPath();
      ctx.arc(sp.x - 2.3, sp.y - 1.6, 1.2, 0, Math.PI * 2);
      ctx.arc(sp.x + 2.3, sp.y - 1.6, 1.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // paddle
    if (paddleBody) drawRect(paddleBody, '#29f7ff', 10);

    // ball trail
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      p.life -= 0.025;
      if (p.life <= 0) continue;
      ctx.fillStyle = '#29f7ff';
      ctx.globalAlpha = p.life * 0.5;
      ctx.shadowColor = '#29f7ff'; ctx.shadowBlur = 12;
      ctx.beginPath(); ctx.arc(p.x, p.y, 4 * p.life, 0, Math.PI * 2); ctx.fill();
    }
    ctx.shadowBlur = 0; ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    // ball — cyan halo with white core
    if (ball) {
      const bx = ball.position.x, by = ball.position.y;
      ctx.shadowColor = '#29f7ff'; ctx.shadowBlur = 40;
      ctx.fillStyle = '#29f7ff';
      ctx.beginPath(); ctx.arc(bx, by, 12, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 24;
      ctx.fillStyle = '#bff9ff';
      ctx.beginPath(); ctx.arc(bx, by, 8, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(bx - 2, by - 2, 4, 0, Math.PI * 2); ctx.fill();
    }

    // butterfly highlight ring — sustained for ~900ms after the step is first reached.
    if (highlightStep >= 0 && mode === 'replaying' && highlightHitAt && ball) {
      const age = performance.now() - highlightHitAt;
      if (age < 900) {
        const decay = 1 - (age / 900);
        const pulse = 0.6 + Math.sin(performance.now() / 100) * 0.4;
        ctx.globalAlpha = 0.5 + decay * 0.5;
        ctx.strokeStyle = '#ffd84a';
        ctx.shadowColor = '#ffd84a'; ctx.shadowBlur = 30;
        ctx.lineWidth = 2 + decay * 2;
        ctx.beginPath();
        ctx.arc(ball.position.x, ball.position.y, 24 + pulse * 10 + (1 - decay) * 18, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 0;
      }
    }

    ctx.restore();

    // Dim wash behind the verdict (drawn over the canvas, under DOM overlays).
    if (resultDim > 0) {
      ctx.fillStyle = `rgba(2, 3, 10, ${resultDim})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  function drawRect(body, color, blur = 8) {
    ctx.save();
    ctx.translate(body.position.x, body.position.y);
    ctx.rotate(body.angle);
    const v = body.vertices;
    // compute width/height from vertices
    let minX=1e9,minY=1e9,maxX=-1e9,maxY=-1e9;
    for (const p of v) {
      const dx = p.x - body.position.x, dy = p.y - body.position.y;
      const lx = Math.cos(-body.angle)*dx - Math.sin(-body.angle)*dy;
      const ly = Math.sin(-body.angle)*dx + Math.cos(-body.angle)*dy;
      if (lx<minX)minX=lx; if (ly<minY)minY=ly;
      if (lx>maxX)maxX=lx; if (ly>maxY)maxY=ly;
    }
    const w = maxX - minX, h = maxY - minY;
    ctx.shadowColor = color; ctx.shadowBlur = blur;
    ctx.strokeStyle = color; ctx.lineWidth = 2;
    ctx.fillStyle = color + '22';
    ctx.beginPath();
    ctx.rect(-w/2, -h/2, w, h);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    ctx.shadowBlur = 0;
  }

  function drawSignZone(zone, label, color, glow, win) {
    if (!zone) return;
    // Visual sign is narrower than the sensor zone for cleaner look.
    const p = zone.position;
    const w = W * 0.34, h = 60;
    const pulse = win ? (0.7 + Math.sin(performance.now() / 90) * 0.3) : 1;
    ctx.save();
    ctx.translate(p.x, p.y);
    // outer halo box
    ctx.shadowColor = color;
    ctx.shadowBlur = 20 + glow * 80 * pulse;
    ctx.strokeStyle = color;
    ctx.fillStyle = color + (win ? '44' : '0c');
    ctx.lineWidth = 2 + glow * 4 * pulse;
    ctx.beginPath();
    roundRect(ctx, -w/2, -h/2, w, h, 10);
    ctx.fill(); ctx.stroke();
    // inner inset line
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 0.55 + glow * 0.45;
    ctx.lineWidth = 1;
    ctx.beginPath();
    roundRect(ctx, -w/2 + 6, -h/2 + 6, w - 12, h - 12, 6);
    ctx.stroke();
    ctx.globalAlpha = 1;
    // label
    ctx.shadowColor = color;
    ctx.shadowBlur = 14 + glow * 30;
    ctx.fillStyle = win ? '#ffffff' : color;
    ctx.font = 'bold 42px Courier New';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, 0, 2);
    // corner brackets
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    const br = 12, bw = 14;
    [[-1,-1],[1,-1],[-1,1],[1,1]].forEach(([sx, sy]) => {
      const x = sx * (w/2 - br), y = sy * (h/2 - br);
      ctx.beginPath();
      ctx.moveTo(x, y + sy * bw); ctx.lineTo(x, y);
      ctx.lineTo(x + sx * bw, y); ctx.stroke();
    });
    ctx.restore();
    ctx.shadowBlur = 0;
  }

  function roundRect(c, x, y, w, h, r) {
    c.moveTo(x + r, y);
    c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r); c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r);
    c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y);
  }

  // ───────────────────────────── URL state, share, mute
  function parseUrlState() {
    const u = new URL(window.location.href);
    const seedRaw = u.searchParams.get('seed');
    const qRaw = u.searchParams.get('q');
    let seed = null;
    if (seedRaw) {
      const n = parseInt(seedRaw, 16);
      if (Number.isFinite(n)) seed = n >>> 0;
    }
    return { seed, q: qRaw || '' };
  }
  function writeUrlState() {
    try {
      const u = new URL(window.location.href);
      u.searchParams.set('seed', currentSeed.toString(16));
      const q = (qInput.value || '').trim();
      if (q) u.searchParams.set('q', q); else u.searchParams.delete('q');
      window.history.replaceState({}, '', u.toString());
    } catch (e) { /* file:// has no URL */ }
  }
  function shareUrl() {
    try {
      const u = new URL(window.location.href);
      u.searchParams.set('seed', currentSeed.toString(16));
      const q = (qInput.value || '').trim();
      if (q) u.searchParams.set('q', q); else u.searchParams.delete('q');
      return u.toString();
    } catch (e) { return window.location.href; }
  }
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.remove('hidden');
    requestAnimationFrame(() => toast.classList.add('show'));
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.classList.add('hidden'), 220);
    }, 1700);
  }

  // Mute toggle — persisted in localStorage so the preference sticks.
  const MUTE_KEY = 'flipper.muted';
  let muted = false;
  try { muted = localStorage.getItem(MUTE_KEY) === '1'; } catch (e) {}
  function applyMute() {
    muteBtn.setAttribute('aria-pressed', muted ? 'true' : 'false');
    muteBtn.setAttribute('aria-label', muted ? 'Unmute audio' : 'Mute audio');
    const x  = muteBtn.querySelector('#muteX');
    const wv = muteBtn.querySelector('#muteWv');
    if (x)  x.style.display  = muted ? '' : 'none';
    if (wv) wv.style.display = muted ? 'none' : '';
    try {
      if (window.Tone && window.Tone.getDestination) {
        window.Tone.getDestination().mute = muted;
      }
    } catch (e) {}
  }
  applyMute();
  muteBtn.addEventListener('click', () => {
    muted = !muted;
    try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch (e) {}
    applyMute();
  });

  // ───────────────────────────── Click / keyboard handlers
  async function bestEffortAudio() {
    try {
      await Promise.race([
        A.init(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('audio timeout')), 800))
      ]);
    } catch (e) { /* continue silent */ }
    applyMute();
  }

  let flipInFlight = false;
  flipBtn.addEventListener('click', async () => {
    if (flipInFlight || mode === 'running' || mode === 'replaying') return;
    flipInFlight = true;
    flipBtn.disabled = true;
    try {
      await bestEffortAudio();
      const fromUrl = pendingSeed;
      pendingSeed = null;
      const seed = (fromUrl != null) ? fromUrl : ((Math.random() * 0xffffffff) >>> 0);
      startFlip(seed);
    } finally {
      flipBtn.disabled = false;
      flipInFlight = false;
    }
  });

  qInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); flipBtn.click(); }
  });

  againBtn.addEventListener('click', () => {
    result.classList.add('hidden');
    menu.classList.remove('hidden');
    banner.classList.add('hidden');
    mode = 'idle';
    outcome = null;
    signs = null;
    if (engine) { World.clear(world, false); Engine.clear(engine); }
    engine = null; world = null; ball = null; paddleBody = null;
    particles = []; sparks = []; modules = {};
    resultDim = 0;
    qInput.focus();
  });

  replayBtn.addEventListener('click', async () => {
    if (mode === 'replaying' || currentSeed == null) return;
    await bestEffortAudio();
    mode = 'replaying';
    slowmoFactor = 0.4;
    result.classList.add('hidden');
    banner.classList.toggle('hidden', !banner.textContent);
    outcome = null;
    signs = null;
    highlightHitAt = 0;
    resultDim = 0;
    build(currentSeed);
    attachCollisionHandlers();
    camera.x = W/2; camera.y = H/2;
    camera.targetX = W/2; camera.targetY = H/2;
    camera.zoom = 1; camera.targetZoom = 1;
    runStartTime = performance.now();
  });

  shareBtn.addEventListener('click', async () => {
    const url = shareUrl();
    try {
      await navigator.clipboard.writeText(url);
      showToast('Link copied');
    } catch (e) {
      // Fallback: open a tiny prompt
      window.prompt('Copy this link', url);
    }
  });

  // Global keyboard: Space/F to flip from the menu or after a result.
  window.addEventListener('keydown', (e) => {
    const inField = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
    if (inField) return;
    if (e.key === ' ' || e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      if (mode === 'idle') flipBtn.click();
      else if (mode === 'done') { againBtn.click(); setTimeout(() => flipBtn.click(), 60); }
    } else if (e.key === 'r' || e.key === 'R') {
      if (mode === 'done') replayBtn.click();
    } else if (e.key === 'm' || e.key === 'M') {
      muteBtn.click();
    }
  });

  // ───────────────────────────── Seed-from-URL bootstrap
  let pendingSeed = null;
  (() => {
    const { seed, q } = parseUrlState();
    if (q && !qInput.value) qInput.value = q;
    if (seed != null) pendingSeed = seed;
  })();

  lastT = performance.now();
  scheduleNext(loop);
})();
