/* FLIPPER — Rube Goldberg yes/no oracle.
 * Physics: Matter.js  |  Render: Canvas 2D  |  Audio: Tone.js
 * Everything is emergent. Seeded RNG so we can replay & probe for butterfly points.
 */

(() => {
  const { Engine, World, Bodies, Body, Composite, Constraint, Events, Vector } = Matter;

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

  const W = canvas.width, H = canvas.height;

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
      await Tone.start();
      this.metal = new Tone.MetalSynth({
        frequency: 240, envelope: { attack: 0.001, decay: 0.18, release: 0.1 },
        harmonicity: 4.1, modulationIndex: 18, resonance: 3500, octaves: 1.2,
        volume: -18
      }).toDestination();
      this.soft = new Tone.MembraneSynth({
        pitchDecay: 0.04, octaves: 4, envelope: { attack: 0.001, decay: 0.2, sustain: 0 },
        volume: -16
      }).toDestination();
      this.magnet = new Tone.FMSynth({
        harmonicity: 2.6, modulationIndex: 6,
        envelope: { attack: 0.002, decay: 0.25, sustain: 0, release: 0.2 },
        volume: -20
      }).toDestination();
      this.lead = new Tone.Synth({
        oscillator: { type: 'sawtooth' },
        envelope: { attack: 0.01, decay: 0.2, sustain: 0.1, release: 0.4 },
        volume: -14
      }).toDestination();
      // ambient hum
      this.hum = new Tone.Oscillator(55, 'sine').toDestination();
      this.hum.volume.value = -34;
      this.hum.start();
      this.ready = true;
    },
    blip(kind, v = 1) {
      if (!this.ready) return;
      const t = Tone.now();
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
      const t = Tone.now();
      notes.forEach((n, i) => this.lead.triggerAttackRelease(n, '8n', t + i * 0.09, 0.8));
    }
  };

  // ───────────────────────────── World
  let engine, world, ball, signs, paddleHinge, paddleBody;
  let particles = [];        // ball trail
  let sparks = [];           // collision sparks
  let creatureFX = [];       // canned animations on creature hits
  let modules = {};          // references to module bodies for drawing
  let staticDraw = [];       // (extra draw hints)
  let camera = { x: 0, y: 0, zoom: 1, targetX: 0, targetY: 0, targetZoom: 1, slowmo: 1 };
  let runEvents = [];        // recorded events for replay/butterfly
  let runStartTime = 0;
  let currentSeed = 0;
  let outcome = null;        // 'yes' | 'no'
  let mode = 'idle';         // 'idle' | 'running' | 'done' | 'replaying'
  let slowmoFactor = 1;      // for replay
  let highlightStep = -1;    // butterfly step to highlight
  let stepLabels = ['flick', 'plinko', 'seesaw', 'module', 'final'];
  let currentStepIndex = 0;

  // ───────────────────────────── Build scene
  function clearWorld() {
    if (engine) { World.clear(world, false); Engine.clear(engine); }
    engine = Engine.create();
    world = engine.world;
    engine.gravity.y = 1.0;
    particles = []; sparks = []; creatureFX = []; modules = {}; staticDraw = [];
    runEvents = [];
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

    // ──── Step 1: Worm + ball at top
    const startX = W * 0.18 + rrange(-12, 12);
    const startY = 90;
    const wormSegments = [];
    let prev = null;
    const segCount = 6 + Math.floor(rand() * 3);
    for (let i = 0; i < segCount; i++) {
      const seg = Bodies.circle(startX - 20 - i * 14, startY + Math.sin(i) * 4, 7, {
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
      pointA: { x: startX - 20, y: startY }, bodyA: wormSegments[0],
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
          isStatic: true, angle, restitution: rrange(0.65, 0.85),
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
      pointA: { x: seesawX, y: seesawY }, bodyA: seesaw,
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
        pointA: { x: px, y: py }, bodyA: hammer, pointB: { x: 0, y: -45 },
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
        isStatic: true, restitution: 1.2, label: 'magnet'
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

    // Spider (decorative creature) in middle of funnel
    const spiderX = W/2 + rrange(-20, 20);
    const spiderY = 820;
    modules.spider = { x: spiderX, y: spiderY, twitch: 0, phase: rand() * Math.PI * 2 };

    // Paddle that the ball strikes — it tips and tells us yes/no
    const paddleY = 850;
    const paddle = Bodies.rectangle(W/2, paddleY, 26, 26, {
      density: 0.003, restitution: 0.3, friction: 0.4, label: 'paddle'
    });
    Body.setAngle(paddle, rrange(-0.1, 0.1));
    World.add(world, paddle);
    World.add(world, Constraint.create({
      pointA: { x: W/2, y: paddleY + 18 }, bodyA: paddle, pointB: { x: 0, y: 8 },
      length: 0, stiffness: 0.7, damping: 0.05
    }));
    paddleBody = paddle;

    // Signs — sensors. Whichever the ball enters first decides outcome.
    const yesZone = Bodies.rectangle(W * 0.22, floorY, W * 0.34, 60, {
      isStatic: true, isSensor: true, label: 'yes'
    });
    const noZone = Bodies.rectangle(W * 0.78, floorY, W * 0.34, 60, {
      isStatic: true, isSensor: true, label: 'no'
    });
    World.add(world, [yesZone, noZone]);
    signs = { yes: yesZone, no: noZone, yesGlow: 0, noGlow: 0, decided: null };

    // ground
    const ground = Bodies.rectangle(W/2, floorY + 26, W * 1.5, 10, {
      isStatic: true, label: 'ground'
    });
    World.add(world, ground);

    // Initial worm flick: pull then release impulse on first segment
    const flickPower = rrange(0.012, 0.022);
    const flickAngle = rrange(-0.15, 0.15);
    setTimeout(() => {
      if (mode !== 'running' && mode !== 'replaying') return;
      const head = wormSegments[wormSegments.length - 1];
      // hit ball with impulse
      Body.applyForce(ball, ball.position, {
        x: Math.cos(flickAngle) * flickPower,
        y: Math.sin(flickAngle) * flickPower * 0.3 + 0.005
      });
      // worm flinch
      Body.applyForce(head, head.position, { x: -0.002, y: -0.004 });
      A.blip('soft', 0.8);
      runEvents.push({ t: performance.now() - runStartTime, kind: 'flick', step: 0 });
      currentStepIndex = 1;
    }, 600 / slowmoFactor);
  }

  // ───────────────────────────── Collision handling
  function attachCollisionHandlers() {
    Events.on(engine, 'collisionStart', (ev) => {
      for (const p of ev.pairs) {
        const a = p.bodyA, b = p.bodyB;
        const labels = [a.label, b.label];
        const other = a.label === 'ball' ? b : (b.label === 'ball' ? a : null);
        if (!other) continue;
        const v = Math.min(20, Math.hypot(ball.velocity.x, ball.velocity.y));
        const intensity = Math.min(1, v / 12);
        // sparks
        for (let i = 0; i < 4 + Math.floor(intensity * 6); i++) {
          sparks.push({
            x: p.collision.supports[0].x, y: p.collision.supports[0].y,
            vx: rrange(-3, 3), vy: rrange(-3, 3),
            life: 1, color: choice(['#29f7ff', '#ff3df0'])
          });
        }
        if (other.label === 'peg' || other.label === 'paddle') {
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
          if (other.label === 'frog') creatureFX.push({ kind: 'frog', t: 0, body: other });
          if (currentStepIndex < 4) currentStepIndex = 4;
        } else if (other.label === 'worm') {
          A.blip('soft', intensity * 0.5);
        }
        runEvents.push({
          t: performance.now() - runStartTime,
          kind: 'hit-' + other.label,
          step: currentStepIndex,
          vx: ball.velocity.x, vy: ball.velocity.y,
          x: ball.position.x, y: ball.position.y
        });

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
    outcome = null; highlightStep = -1;
    menu.classList.add('hidden');
    result.classList.add('hidden');
    butterfly.textContent = '';
    const q = qInput.value.trim();
    banner.textContent = q ? `“${q}”` : '';
    banner.classList.toggle('hidden', !q);
    build(seed);
    attachCollisionHandlers();
    camera.targetZoom = 1;
    runStartTime = performance.now();
    // Safety timeout: if nothing decides within 18s, force decision by ball x
    setTimeout(() => {
      if (!signs?.decided && (mode === 'running' || mode === 'replaying')) {
        finishRun(ball.position.x < W/2 ? 'yes' : 'no');
      }
    }, 18000 / slowmoFactor);
  }

  function finishRun(which) {
    if (outcome) return;
    outcome = which;
    signs.decided = which;
    // climactic slow-mo + zoom
    camera.targetZoom = 1.6;
    slowmoFactor = 0.35;
    A.arpeggio(which === 'yes');
    setTimeout(() => {
      mode = 'done';
      slowmoFactor = 1;
      camera.targetZoom = 1;
      banner.classList.add('hidden');
      verdict.textContent = which.toUpperCase();
      verdict.className = 'verdict ' + which;
      result.classList.remove('hidden');
      // compute butterfly point asynchronously
      computeButterfly(currentSeed, which).then(step => {
        if (step != null) {
          butterfly.textContent =
            `BUTTERFLY POINT: STEP ${step + 1} — ${stepLabels[step]?.toUpperCase()}`;
          highlightStep = step;
        }
      });
    }, 1500);
  }

  // ───────────────────────────── Butterfly point estimator
  // Run silent re-sims with the same seed but perturb the RNG at start of each step.
  // The step where smallest perturbation flips the outcome ≈ butterfly point.
  async function computeButterfly(seed, baseOutcome) {
    const steps = 5;
    const samplesPerStep = 5;
    let bestFlipRate = -1, bestStep = -1;
    for (let s = 0; s < steps; s++) {
      let flips = 0;
      for (let k = 0; k < samplesPerStep; k++) {
        // perturb seed by mixing step+k into low bits
        const perturbed = (seed ^ (1 << (s * 3 + k))) >>> 0;
        const o = await silentRun(perturbed, s);
        if (o && o !== baseOutcome) flips++;
        // yield
        if ((s * samplesPerStep + k) % 4 === 0) await new Promise(r => setTimeout(r, 0));
      }
      const rate = flips / samplesPerStep;
      // earliest step with non-zero flips and highest rate wins
      if (rate > bestFlipRate || (rate === bestFlipRate && rate > 0 && s < bestStep)) {
        bestFlipRate = rate; bestStep = s;
      }
    }
    return bestFlipRate > 0 ? bestStep : -1;
  }

  // Simulate without rendering. Returns 'yes' | 'no' | null.
  function silentRun(seed, perturbStep) {
    return new Promise(resolve => {
      const localRand = mulberry32(seed);
      const origRand = rand;
      rand = localRand;
      const eng = Engine.create();
      eng.gravity.y = 1.0;
      const w = eng.world;
      // Build a minimal duplicate of scene using the same construction logic — simplest:
      // we just re-call build() into a fresh engine. To avoid complexity, we'll use
      // a parallel quick simulation that's *similar enough*: same RNG sequence drives
      // same params, same gravity. Trade-off: we accept some approximation.
      try {
        // We'll piggyback on the real build by snapshotting/restoring globals
        const realEngine = engine, realWorld = world, realBall = ball,
              realSigns = signs, realModules = modules, realRunEvents = runEvents,
              realStep = currentStepIndex;
        // Detach engine refs
        engine = eng; world = w;
        build(seed);
        // Apply perturbation: add tiny impulse to ball when step changes to perturbStep
        let done = null;
        const checkStep = () => {
          if (currentStepIndex === perturbStep && !modules._perturbed) {
            modules._perturbed = true;
            Body.applyForce(ball, ball.position, {
              x: (localRand() - 0.5) * 0.001,
              y: (localRand() - 0.5) * 0.001
            });
          }
        };
        Events.on(eng, 'collisionStart', (ev) => {
          for (const p of ev.pairs) {
            const other = p.bodyA.label === 'ball' ? p.bodyB :
                          p.bodyB.label === 'ball' ? p.bodyA : null;
            if (!other) continue;
            if (other.label === 'peg' || other.label === 'paddle') {
              if (currentStepIndex < 2) currentStepIndex = 2;
            } else if (['seesaw','ledge','slope'].includes(other.label)) {
              if (currentStepIndex < 3) currentStepIndex = 3;
            } else if (['magnet','domino','hammer','frog'].includes(other.label)) {
              if (currentStepIndex < 4) currentStepIndex = 4;
            }
            checkStep();
            if (other.label === 'yes' && !done) done = 'yes';
            if (other.label === 'no' && !done) done = 'no';
          }
        });
        // Manually trigger initial flick (the setTimeout in build won't help in fast sim)
        // We'll just apply the impulse immediately on the real ball after step state.
        Body.applyForce(ball, ball.position, {
          x: 0.018 * (1 + (localRand() - 0.5) * 0.2),
          y: 0.006
        });
        currentStepIndex = 1;
        // step engine for up to ~20s simulated
        const dt = 1000/60;
        for (let i = 0; i < 60 * 18 && !done; i++) {
          // magnet force module
          if (modules.kind === 'magnet' && modules.magnet) {
            const dx = modules.magnet.position.x - ball.position.x;
            const dy = modules.magnet.position.y - ball.position.y;
            const d2 = dx*dx + dy*dy;
            if (d2 < 200*200 && d2 > 1) {
              const f = modules.magnetStrength * modules.magnetSign / Math.sqrt(d2);
              Body.applyForce(ball, ball.position, { x: dx * f, y: dy * f });
            }
          }
          Engine.update(eng, dt);
          checkStep();
          if (ball.position.y > H - 20) {
            if (!done) done = ball.position.x < W/2 ? 'yes' : 'no';
          }
        }
        // restore
        engine = realEngine; world = realWorld; ball = realBall;
        signs = realSigns; modules = realModules; runEvents = realRunEvents;
        currentStepIndex = realStep;
        rand = origRand;
        Engine.clear(eng);
        resolve(done);
      } catch (e) {
        rand = origRand;
        resolve(null);
      }
    });
  }

  // ───────────────────────────── Main loop
  let lastT = performance.now();
  function loop(t) {
    const dt = Math.min(40, t - lastT);
    lastT = t;

    if (mode === 'running' || mode === 'replaying') {
      // magnet pull on live engine
      if (modules.kind === 'magnet' && modules.magnet && ball) {
        const dx = modules.magnet.position.x - ball.position.x;
        const dy = modules.magnet.position.y - ball.position.y;
        const d2 = dx*dx + dy*dy;
        if (d2 < 200*200 && d2 > 1) {
          const f = modules.magnetStrength * modules.magnetSign / Math.sqrt(d2);
          Body.applyForce(ball, ball.position, { x: dx * f, y: dy * f });
        }
      }
      // occasional wind gust on light bodies
      if (rand() < 0.01) {
        const wind = (rand() - 0.5) * 0.0008;
        World.allBodies(world).forEach(b => {
          if (!b.isStatic && b.mass < 0.05) {
            Body.applyForce(b, b.position, { x: wind, y: 0 });
          }
        });
      }
      // frog occasional hop
      if (modules.kind === 'frog' && modules.frog) {
        modules.frogTimer -= dt / 1000;
        if (modules.frogTimer <= 0) {
          Body.applyForce(modules.frog, modules.frog.position, {
            x: (rand() - 0.5) * 0.004,
            y: -0.012
          });
          modules.frogTimer = rrange(0.6, 1.6);
        }
      }
      Engine.update(engine, dt * slowmoFactor);

      // ball trail particle
      if (ball) {
        particles.push({ x: ball.position.x, y: ball.position.y, life: 1 });
        if (particles.length > 40) particles.shift();
      }

      // camera follow
      if (ball) {
        camera.targetX = ball.position.x;
        camera.targetY = Math.max(H * 0.4, Math.min(H * 0.7, ball.position.y));
      }
    }

    // camera smoothing
    camera.x += (camera.targetX - camera.x) * 0.06;
    camera.y += (camera.targetY - camera.y) * 0.06;
    camera.zoom += (camera.targetZoom - camera.zoom) * 0.04;

    // sign glow pulse on outcome
    if (outcome === 'yes') signs.yesGlow = Math.min(1, signs.yesGlow + 0.04);
    if (outcome === 'no')  signs.noGlow  = Math.min(1, signs.noGlow + 0.04);

    render();
    requestAnimationFrame(loop);
  }

  // ───────────────────────────── Rendering
  function applyCamera() {
    ctx.translate(W/2, H/2);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-camera.x, -camera.y);
  }

  function render() {
    // BG
    ctx.fillStyle = '#03040a';
    ctx.fillRect(0, 0, W, H);
    // floor grid
    ctx.save();
    ctx.translate(0, 0);
    ctx.strokeStyle = 'rgba(41, 247, 255, 0.10)';
    ctx.lineWidth = 1;
    const horizon = H * 0.55;
    for (let y = horizon; y < H; y += 18) {
      ctx.beginPath();
      const t = (y - horizon) / (H - horizon);
      ctx.globalAlpha = 0.1 + t * 0.18;
      ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    for (let i = -10; i <= 10; i++) {
      const vx = W/2 + i * 60;
      ctx.beginPath();
      ctx.moveTo(W/2 + (vx - W/2) * 0.4, horizon);
      ctx.lineTo(vx, H);
      ctx.globalAlpha = 0.10;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    if (!engine) return;
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
    // frog
    if (modules.frog) {
      const f = modules.frog, p = f.position, a = f.angle;
      ctx.save();
      ctx.translate(p.x, p.y); ctx.rotate(a);
      ctx.shadowColor = '#5cff7a'; ctx.shadowBlur = 18;
      ctx.fillStyle = '#5cff7a';
      ctx.beginPath();
      ctx.moveTo(0, -22); ctx.lineTo(20, 16); ctx.lineTo(-20, 16); ctx.closePath();
      ctx.fill();
      // eyes
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

    // spider (decorative)
    if (modules.spider) {
      const sp = modules.spider;
      sp.phase += 0.06;
      const tw = Math.sin(sp.phase) * 4;
      ctx.shadowColor = '#29f7ff'; ctx.shadowBlur = 12;
      ctx.strokeStyle = '#29f7ff'; ctx.lineWidth = 2;
      for (let i = 0; i < 4; i++) {
        const ang = (i / 4) * Math.PI * 2 + sp.phase * 0.2;
        ctx.beginPath();
        ctx.moveTo(sp.x, sp.y);
        ctx.lineTo(sp.x + Math.cos(ang) * (14 + tw), sp.y + Math.sin(ang) * (14 + tw));
        ctx.stroke();
      }
      ctx.fillStyle = '#29f7ff';
      ctx.beginPath(); ctx.arc(sp.x, sp.y, 5, 0, Math.PI * 2); ctx.fill();
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

    // ball
    if (ball) {
      ctx.shadowColor = '#ffffff'; ctx.shadowBlur = 24;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(ball.position.x, ball.position.y, 11, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      // inner cyan
      ctx.fillStyle = '#29f7ff';
      ctx.beginPath(); ctx.arc(ball.position.x, ball.position.y, 6, 0, Math.PI * 2); ctx.fill();
    }

    // butterfly highlight ring
    if (highlightStep >= 0 && mode === 'replaying' && currentStepIndex === highlightStep && ball) {
      const pulse = 0.6 + Math.sin(performance.now() / 100) * 0.4;
      ctx.strokeStyle = '#ffd84a';
      ctx.shadowColor = '#ffd84a'; ctx.shadowBlur = 30;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(ball.position.x, ball.position.y, 24 + pulse * 8, 0, Math.PI * 2); ctx.stroke();
      ctx.shadowBlur = 0;
    }

    ctx.restore();
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
    const p = zone.position;
    const w = W * 0.34, h = 60;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.shadowColor = color;
    ctx.shadowBlur = 16 + glow * 50;
    ctx.strokeStyle = color;
    ctx.fillStyle = color + (win ? '55' : '14');
    ctx.lineWidth = 2 + glow * 3;
    ctx.beginPath();
    ctx.rect(-w/2, -h/2, w, h);
    ctx.fill(); ctx.stroke();
    // label
    ctx.fillStyle = color;
    ctx.font = 'bold 36px Courier New';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, 0, 0);
    ctx.restore();
    ctx.shadowBlur = 0;
  }

  // ───────────────────────────── UI handlers
  flipBtn.addEventListener('click', async () => {
    await A.init();
    startFlip((Math.random() * 0xffffffff) >>> 0);
  });
  qInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') flipBtn.click();
  });
  againBtn.addEventListener('click', () => {
    result.classList.add('hidden');
    menu.classList.remove('hidden');
    mode = 'idle';
    outcome = null;
    signs = null;
    if (engine) { World.clear(world, false); Engine.clear(engine); }
    particles = []; sparks = []; modules = {};
  });
  replayBtn.addEventListener('click', async () => {
    if (currentSeed == null) return;
    await A.init();
    mode = 'replaying';
    slowmoFactor = 0.4;
    result.classList.add('hidden');
    banner.classList.toggle('hidden', !banner.textContent);
    outcome = null;
    signs = null;
    build(currentSeed);
    attachCollisionHandlers();
    runStartTime = performance.now();
  });

  requestAnimationFrame((t) => { lastT = t; loop(t); });
})();
