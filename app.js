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
  let camera = { x: W/2, y: H/2, zoom: 1, targetX: W/2, targetY: H/2, targetZoom: 1, slowmo: 1 };
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

    // Initial worm flick — direction biased toward center but jittered enough to favor either side
    const flickPower = rrange(0.013, 0.022);
    const flickAngle = rrange(-0.35, 0.35);          // wider angular jitter
    const flickSign = -startSide;                     // toward the opposite side
    modules.flick = { power: flickPower, angle: flickAngle, sign: flickSign, startSide };
    setTimeout(() => {
      if (mode !== 'running' && mode !== 'replaying') return;
      const head = wormSegments[wormSegments.length - 1];
      Body.applyForce(ball, ball.position, {
        x: flickSign * Math.cos(flickAngle) * flickPower,
        y: Math.abs(Math.sin(flickAngle)) * flickPower * 0.3 + 0.005
      });
      Body.applyForce(head, head.position, { x: startSide * 0.002, y: -0.004 });
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
          if (other.label === 'frog') creatureFX.push({ kind: 'frog', t: 0, body: other });
          if (currentStepIndex < 4) currentStepIndex = 4;
        } else if (other.label === 'paddle') {
          A.blip('metal', intensity * 1.2);
          if (currentStepIndex < 5) currentStepIndex = 5;
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
    camera.x = W/2; camera.y = H/2;
    camera.targetX = W/2; camera.targetY = H/2;
    camera.zoom = 1; camera.targetZoom = 1;
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
      verdict.textContent = which.toUpperCase();
      verdict.className = 'verdict ' + which;
      result.classList.remove('hidden');
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
    }, 1500);
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
            realSigns = signs, realModules = modules, realRunEvents = runEvents,
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
        signs = realSigns; modules = realModules; runEvents = realRunEvents;
        currentStepIndex = realStep; currentSeed = realSeed;
        paddleBody = realPaddle;
        rand = origRand;
        resolve(done);
      } catch (e) {
        engine = realEngine; world = realWorld; ball = realBall;
        signs = realSigns; modules = realModules; runEvents = realRunEvents;
        currentStepIndex = realStep; currentSeed = realSeed;
        paddleBody = realPaddle;
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

      // camera follow — gentle bias toward the ball's vertical position
      if (ball) {
        camera.targetX = W/2 + (ball.position.x - W/2) * 0.25;
        camera.targetY = Math.max(H * 0.45, Math.min(H * 0.62, ball.position.y * 0.55 + H * 0.28));
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

  // ───────────────────────────── UI handlers
  flipBtn.addEventListener('click', async () => {
    try { await A.init(); } catch (e) { /* continue silent */ }
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
    camera.x = W/2; camera.y = H/2;
    camera.targetX = W/2; camera.targetY = H/2;
    camera.zoom = 1; camera.targetZoom = 1;
    runStartTime = performance.now();
  });

  lastT = performance.now();
  scheduleNext(loop);
})();
