/* FLIPPER — neon marble race oracle.
 *
 * Two marbles (YES cyan, NO magenta) drop down a long vertical course
 * stuffed with pegs, spinners, hammers, gears, and funnels. The camera
 * follows whichever marble is in the lead. First to cross the finish
 * line answers the question.
 *
 * Architecture, deliberately tiny:
 *   - Hand-rolled physics: gravity + per-frame integration + closed-form
 *     collision against circles and segments. No Matter.js.
 *   - Static obstacles are baked into one offscreen canvas at race start.
 *     Each frame, one `drawImage` blits the visible slice. Kinematic
 *     obstacles (spinning arms, hammers, gears) are redrawn per frame.
 *   - Spatial bucketing: obstacles are bucketed into vertical slabs so
 *     each ball only collides against the few it could touch.
 *
 * No build step. Open index.html.
 */

(() => {
  // ───────────────────────────── DOM
  const canvas    = document.getElementById('world');
  const ctx       = canvas.getContext('2d', { alpha: false });
  const menu      = document.getElementById('menu');
  const hud       = document.getElementById('hud');
  const banner    = document.getElementById('banner');
  const scoreYes  = document.querySelector('.chip-yes');
  const scoreNo   = document.querySelector('.chip-no');
  const result    = document.getElementById('result');
  const verdict   = document.getElementById('verdict');
  const resultMeta= document.getElementById('resultMeta');
  const flipBtn   = document.getElementById('flip');
  const againBtn  = document.getElementById('again');
  const muteBtn   = document.getElementById('mute');
  const qInput    = document.getElementById('question');
  const fatal     = document.getElementById('fatal');

  const W = canvas.width, H_VIEW = canvas.height;     // logical dimensions
  function syncDpr() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const physW = Math.round(W * dpr), physH = Math.round(H_VIEW * dpr);
    if (canvas.width !== physW || canvas.height !== physH) {
      canvas.width = physW; canvas.height = physH;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }
  syncDpr();
  window.addEventListener('resize', syncDpr);

  // ───────────────────────────── RNG (Mulberry32)
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function() {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  let rand = Math.random;
  const rrange = (a, b) => a + rand() * (b - a);
  const choice = (arr) => arr[Math.floor(rand() * arr.length)];

  // ───────────────────────────── World constants
  const SECTION_H        = 700;     // px tall per generated section
  const SECTION_COUNT    = 8;       // ≈ 5600 px course
  const START_PAD        = 220;     // free-fall pad above first section
  const FINISH_PAD       = 360;     // funnel + finish band below last section
  const WORLD_H          = START_PAD + SECTION_H * SECTION_COUNT + FINISH_PAD;
  const FINISH_Y         = START_PAD + SECTION_H * SECTION_COUNT + 60;

  // Tuned for a 15s–90s race with lots of variance. Free rolling on ramps,
  // restitution absorbs collision energy; no per-contact velocity drain.
  const GRAVITY          = 0.50;    // px / frame² (60fps reference)
  const AIR_DRAG_X       = 0.997;
  const AIR_DRAG_Y       = 0.9994;
  const TERMINAL_VY      = 11.5;
  const RESTITUTION      = 0.42;
  const BALL_R           = 14;
  const SUBSTEPS         = 3;       // physics sub-steps per render frame

  const COLORS = {
    bg:        '#03040a',
    bg_far:    '#08091a',
    cyan:      '#29f7ff',
    magenta:   '#ff3df0',
    wallCyan:  'rgba(41, 247, 255, 0.55)',
    wallMag:   'rgba(255, 61, 240, 0.55)',
    finish:    '#ffd84a'
  };

  // ───────────────────────────── State
  let staticObs    = [];     // baked into staticCanvas; still referenced for collision
  let kinObs       = [];     // redrawn each frame
  let bucketsH     = 100;    // height of one spatial bucket in px
  let buckets      = [];     // array indexed by floor(y / bucketsH) → list of obstacle refs
  let balls        = [];
  let particles    = [];     // tiny spark pool for collision pops
  let cameraY      = 0;
  let cameraTargetY= 0;
  let mode         = 'idle'; // 'idle' | 'racing' | 'finishing' | 'done'
  let winner       = null;
  let winnerMarginPx = 0;
  let raceStart    = 0;
  let raceElapsed  = 0;
  let finishDelay  = 0;      // counted down while finishing
  let currentSeed  = 0;
  let pendingSeed  = null;

  // ───────────────────────────── Offscreen prerender
  const staticCanvas = document.createElement('canvas');
  staticCanvas.width = W;
  staticCanvas.height = WORLD_H;
  const sctx = staticCanvas.getContext('2d', { alpha: false });

  // ───────────────────────────── Audio (lazy, tiny Web Audio setup)
  let audioCtx = null, masterGain = null, muted = false;
  try { muted = localStorage.getItem('flipper.muted') === '1'; } catch (e) {}

  function ensureAudio() {
    if (audioCtx) return;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      masterGain = audioCtx.createGain();
      masterGain.gain.value = muted ? 0 : 0.45;
      masterGain.connect(audioCtx.destination);
    } catch (e) { /* no audio */ }
  }
  function applyMuteUI() {
    muteBtn.setAttribute('aria-pressed', muted ? 'true' : 'false');
    muteBtn.setAttribute('aria-label', muted ? 'Unmute audio' : 'Mute audio');
    const x  = muteBtn.querySelector('#muteX');
    const wv = muteBtn.querySelector('#muteWv');
    if (x)  x.style.display  = muted ? '' : 'none';
    if (wv) wv.style.display = muted ? 'none' : '';
    if (masterGain) masterGain.gain.value = muted ? 0 : 0.45;
  }
  applyMuteUI();

  function blip(freq, durMs, type = 'square', vol = 0.18) {
    if (muted || !audioCtx) return;
    const t0 = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.5, t0 + durMs / 1000);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
    osc.connect(g).connect(masterGain);
    osc.start(t0);
    osc.stop(t0 + durMs / 1000 + 0.02);
  }
  function chord(freqs, durMs = 320, type = 'sawtooth') {
    if (muted || !audioCtx) return;
    const t0 = audioCtx.currentTime;
    for (let i = 0; i < freqs.length; i++) {
      const f = freqs[i];
      const osc = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      osc.type = type;
      osc.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02 + i * 0.04);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
      osc.connect(g).connect(masterGain);
      osc.start(t0 + i * 0.04);
      osc.stop(t0 + durMs / 1000 + 0.02);
    }
  }

  // ───────────────────────────── Course generation
  function buildCourse(seed) {
    rand = mulberry32(seed >>> 0);
    currentSeed = seed >>> 0;
    staticObs = [];
    kinObs = [];
    buckets = [];

    // Side walls
    pushStaticSegment(20, 0, 20, WORLD_H, 4, COLORS.cyan);
    pushStaticSegment(W - 20, 0, W - 20, WORLD_H, 4, COLORS.magenta);

    // Sections
    const templates = ['pegfield', 'bigWheel', 'cascade', 'hammers', 'cross', 'gauntlet', 'gearPair'];
    let lastTemplate = null;
    for (let s = 0; s < SECTION_COUNT; s++) {
      const y0 = START_PAD + s * SECTION_H;
      let pick;
      // avoid repeating the same template back-to-back
      do { pick = choice(templates); } while (pick === lastTemplate);
      lastTemplate = pick;
      buildSection(pick, y0);
    }

    // Finish band: gentle funnel into the finish line
    buildFinishBand(START_PAD + SECTION_COUNT * SECTION_H);

    // Build spatial buckets
    bucketsH = 120;
    const N = Math.ceil(WORLD_H / bucketsH) + 1;
    buckets = new Array(N);
    for (let i = 0; i < N; i++) buckets[i] = [];
    const insert = (o, yMin, yMax) => {
      const a = Math.max(0, Math.floor(yMin / bucketsH));
      const b = Math.min(N - 1, Math.floor(yMax / bucketsH));
      for (let i = a; i <= b; i++) buckets[i].push(o);
    };
    for (const o of staticObs) {
      if (o.kind === 'circle')        insert(o, o.y - o.r - 2, o.y + o.r + 2);
      else if (o.kind === 'segment')  insert(o, Math.min(o.y1, o.y2) - 2, Math.max(o.y1, o.y2) + 2);
    }
    for (const o of kinObs) {
      // worst-case bounding for moving obstacles
      if (o.kind === 'arm' || o.kind === 'gear') insert(o, o.cy - o.length - 6, o.cy + o.length + 6);
      else if (o.kind === 'hammer')              insert(o, o.cy - 8, o.cy + o.length + o.bobR + 8);
    }
  }

  function pushStaticSegment(x1, y1, x2, y2, thick, color) {
    staticObs.push({ kind: 'segment', x1, y1, x2, y2, thick, color });
  }
  function pushStaticCircle(x, y, r, color) {
    staticObs.push({ kind: 'circle', x, y, r, color });
  }

  // — Section templates —
  // Every section is built to feel dominated by one or two BIG moving pieces
  // (or one dense field of static pieces) — never mostly empty space.
  function buildSection(template, y0) {
    if (template === 'pegfield')   return buildPegfield(y0);
    if (template === 'bigWheel')   return buildBigWheel(y0);
    if (template === 'cascade')    return buildCascade(y0);
    if (template === 'hammers')    return buildHammers(y0);
    if (template === 'cross')      return buildCross(y0);
    if (template === 'gauntlet')   return buildGauntlet(y0);
    if (template === 'gearPair')   return buildGearPair(y0);
  }

  // Dense plinko — 8 rows, tightly packed, big pegs that actually catch.
  function buildPegfield(y0) {
    const rows = 8;
    const inset = 38;
    for (let r = 0; r < rows; r++) {
      const cols = 7 + (r % 2);
      const span = W - inset * 2;
      const gap = span / (cols + 1);
      for (let c = 0; c < cols; c++) {
        const px = inset + gap * (c + 1) + ((r % 2) ? -gap / 2 : 0) + rrange(-4, 4);
        const py = y0 + 60 + r * 78 + rrange(-3, 3);
        pushStaticCircle(px, py, 13, COLORS.cyan);
      }
    }
  }

  // One huge multi-arm rotor (cross or T) that dominates the section.
  // Two or three arms sharing a pivot and spinning together — they sweep
  // across most of the canvas width.
  function buildBigWheel(y0) {
    const cx = W / 2 + rrange(-20, 20);
    const cy = y0 + SECTION_H * 0.5;
    const length = rrange(220, 280);
    const armCount = choice([2, 3, 4]);
    const omega = rrange(0.018, 0.034) * (rand() < 0.5 ? -1 : 1);
    const baseAngle = rand() * Math.PI * 2;
    const colorOrder = rand() < 0.5
      ? [COLORS.cyan, COLORS.magenta]
      : [COLORS.magenta, COLORS.cyan];
    for (let i = 0; i < armCount; i++) {
      const offset = (i / armCount) * Math.PI * 2;
      kinObs.push({
        kind: 'arm',
        cx, cy, length, omega,
        angle: baseAngle + offset,
        thick: 14,
        color: colorOrder[i % 2]
      });
    }
    // Hub disc so the center isn't a gap
    pushStaticCircle(cx, cy, 18, COLORS.cyan);
    // Big corner bumpers around the rotor so marbles can't just glide past
    const cornerR = 200;
    const cornerPegR = 18;
    for (let a = 0; a < 4; a++) {
      const ang = Math.PI / 4 + a * Math.PI / 2;
      const px = cx + Math.cos(ang) * cornerR;
      const py = cy + Math.sin(ang) * cornerR;
      if (px > 50 && px < W - 50 && py > y0 + 60 && py < y0 + SECTION_H - 60) {
        pushStaticCircle(px, py, cornerPegR, a % 2 === 0 ? COLORS.cyan : COLORS.magenta);
      }
    }
  }

  // Three-stage cascade of funnels: each narrows to a hard gap, marbles
  // ricochet off bumpers between stages. Fills the section top-to-bottom.
  function buildCascade(y0) {
    const stages = 3;
    for (let i = 0; i < stages; i++) {
      const top    = y0 + 40 + i * (SECTION_H / stages);
      const bottom = y0 + (i + 1) * (SECTION_H / stages) - 20;
      const cx = W / 2 + (i % 2 === 0 ? -1 : 1) * rrange(20, 60);
      const gap = rrange(70, 100);
      pushStaticSegment(50,       top, cx - gap / 2, bottom, 7, COLORS.cyan);
      pushStaticSegment(W - 50,   top, cx + gap / 2, bottom, 7, COLORS.magenta);
      // bumpers at the throat
      pushStaticCircle(cx - gap / 2 - 16, bottom, 11, COLORS.cyan);
      pushStaticCircle(cx + gap / 2 + 16, bottom, 11, COLORS.magenta);
    }
  }

  // Three big swinging hammers on alternating sides, each spanning ~40% of
  // canvas width with heavy bobs that genuinely punch marbles around.
  function buildHammers(y0) {
    const hammerCount = 3;
    for (let i = 0; i < hammerCount; i++) {
      const side = (i % 2 === 0) ? -1 : 1;
      const cx = W / 2 + side * (W * 0.32);
      const cy = y0 + 110 + i * ((SECTION_H - 220) / (hammerCount - 1));
      kinObs.push({
        kind: 'hammer',
        cx, cy,
        length: rrange(170, 220),
        bobR: rrange(28, 36),
        baseAngle: side > 0 ? -Math.PI / 2 - 0.4 : -Math.PI / 2 + 0.4,
        amp: 1.15 + rrange(-0.1, 0.1),
        phase: rand() * Math.PI * 2,
        omega: rrange(0.030, 0.050),
        color: side > 0 ? COLORS.magenta : COLORS.cyan,
        thick: 8
      });
    }
    // A line of pegs down the middle to interfere with the swept arcs
    for (let r = 0; r < 4; r++) {
      pushStaticCircle(W / 2 + rrange(-12, 12), y0 + 130 + r * 160, 12, r % 2 === 0 ? COLORS.cyan : COLORS.magenta);
    }
  }

  // X-shaped chamber: big diamond walls with a corner peg cluster on each side
  // and a single big rotor stitched through, so marbles have to thread or get hit.
  function buildCross(y0) {
    const cx = W / 2;
    const cy = y0 + SECTION_H / 2;
    const d = 150;
    pushStaticSegment(cx - d, cy, cx, cy - d, 6, COLORS.cyan);
    pushStaticSegment(cx, cy - d, cx + d, cy, 6, COLORS.magenta);
    pushStaticSegment(cx + d, cy, cx, cy + d, 6, COLORS.magenta);
    pushStaticSegment(cx, cy + d, cx - d, cy, 6, COLORS.cyan);
    pushStaticCircle(cx - d, cy, 14, COLORS.cyan);
    pushStaticCircle(cx + d, cy, 14, COLORS.magenta);
    pushStaticCircle(cx, cy - d, 14, COLORS.cyan);
    pushStaticCircle(cx, cy + d, 14, COLORS.magenta);
    // A big spinning bar threading through the diamond on one diagonal
    kinObs.push({
      kind: 'arm', cx, cy, length: 130, omega: rrange(0.025, 0.04) * (rand() < 0.5 ? -1 : 1),
      angle: rand() * Math.PI * 2, thick: 11, color: COLORS.magenta
    });
    kinObs.push({
      kind: 'arm', cx, cy, length: 130, omega: rrange(0.025, 0.04) * (rand() < 0.5 ? -1 : 1),
      angle: rand() * Math.PI * 2 + Math.PI / 2, thick: 11, color: COLORS.cyan
    });
  }

  // Pair of large counter-rotating gears that almost touch — marbles squeeze
  // between them and get spun into the next section.
  function buildGearPair(y0) {
    const cy = y0 + SECTION_H * 0.45;
    const r = rrange(58, 72);
    const gap = rrange(50, 70);
    const omega1 = rrange(0.022, 0.038);
    const omega2 = -omega1;             // counter-rotating
    kinObs.push({
      kind: 'gear', cx: W / 2 - r - gap / 2, cy, r, teeth: 10, length: r,
      angle: 0, omega: omega1, color: COLORS.cyan
    });
    kinObs.push({
      kind: 'gear', cx: W / 2 + r + gap / 2, cy, r, teeth: 10, length: r,
      angle: 0, omega: omega2, color: COLORS.magenta
    });
    // Funnel walls feeding marbles into the gear gap
    pushStaticSegment(40,      y0 + 60,  W / 2 - r - gap / 2 - 24, cy - r - 8, 6, COLORS.cyan);
    pushStaticSegment(W - 40,  y0 + 60,  W / 2 + r + gap / 2 + 24, cy - r - 8, 6, COLORS.magenta);
    // Exit ramps below
    pushStaticSegment(W / 2 - r - gap / 2 - 24, cy + r + 8,  60,      y0 + SECTION_H - 30, 5, COLORS.cyan);
    pushStaticSegment(W / 2 + r + gap / 2 + 24, cy + r + 8,  W - 60,  y0 + SECTION_H - 30, 5, COLORS.magenta);
  }

  // Tight serpentine of long ledges with steep drops to encourage rolling.
  function buildGauntlet(y0) {
    const leftEdge = 28, rightEdge = W - 28;
    const steps = 6;
    for (let i = 0; i < steps; i++) {
      const yy = y0 + 70 + i * (SECTION_H - 140) / (steps - 1);
      const side = i % 2;
      const len = rrange(W * 0.62, W * 0.78);
      const tilt = rrange(35, 65);     // steeper ramps → faster rolling
      if (side === 0) {
        pushStaticSegment(leftEdge, yy, leftEdge + len, yy + tilt, 7, COLORS.cyan);
      } else {
        pushStaticSegment(rightEdge, yy, rightEdge - len, yy + tilt, 7, COLORS.magenta);
      }
    }
    // a wall-bouncer peg on each tier
    for (let i = 0; i < steps; i++) {
      const yy = y0 + 80 + i * (SECTION_H - 140) / (steps - 1) + 50;
      const side = i % 2 === 0 ? 1 : -1;
      const px = side > 0 ? W - 60 : 60;
      pushStaticCircle(px, yy, 14, side > 0 ? COLORS.magenta : COLORS.cyan);
    }
  }

  function buildFinishBand(y0) {
    // Two slope walls funneling everyone into the finish strip.
    pushStaticSegment(40, y0,            W * 0.36, y0 + 200, 6, COLORS.cyan);
    pushStaticSegment(W - 40, y0,        W * 0.64, y0 + 200, 6, COLORS.magenta);
    // The finish line is drawn separately; collision-wise it's not solid.
  }

  // ───────────────────────────── Prerender static layer
  function prerenderStatic() {
    sctx.fillStyle = COLORS.bg;
    sctx.fillRect(0, 0, W, WORLD_H);

    // Faint grid every 100px so vertical motion reads
    sctx.strokeStyle = 'rgba(41, 247, 255, 0.045)';
    sctx.lineWidth = 1;
    for (let y = 0; y < WORLD_H; y += 100) {
      sctx.beginPath(); sctx.moveTo(0, y); sctx.lineTo(W, y); sctx.stroke();
    }

    // Static obstacles
    sctx.lineCap = 'round';
    for (const o of staticObs) {
      if (o.kind === 'circle') {
        sctx.fillStyle = o.color === COLORS.magenta ? 'rgba(255,61,240,0.16)' : 'rgba(41,247,255,0.16)';
        sctx.beginPath();
        sctx.arc(o.x, o.y, o.r, 0, Math.PI * 2);
        sctx.fill();
        sctx.strokeStyle = o.color;
        sctx.lineWidth = 2;
        sctx.stroke();
      } else if (o.kind === 'segment') {
        sctx.strokeStyle = o.color;
        sctx.lineWidth = o.thick;
        sctx.beginPath();
        sctx.moveTo(o.x1, o.y1); sctx.lineTo(o.x2, o.y2);
        sctx.stroke();
      }
    }

    // Finish line band
    const fy = FINISH_Y;
    const grad = sctx.createLinearGradient(0, fy - 6, 0, fy + 70);
    grad.addColorStop(0, 'rgba(255, 216, 74, 0.0)');
    grad.addColorStop(0.4, 'rgba(255, 216, 74, 0.35)');
    grad.addColorStop(1, 'rgba(255, 216, 74, 0.0)');
    sctx.fillStyle = grad;
    sctx.fillRect(0, fy - 6, W, 76);
    // Checker bands
    sctx.fillStyle = COLORS.finish;
    const stripe = 20;
    for (let x = 0; x < W; x += stripe) {
      sctx.fillRect(x, fy, stripe / 2, 4);
      sctx.fillRect(x + stripe / 2, fy + 8, stripe / 2, 4);
    }
    // Label
    sctx.font = 'bold 22px "Courier New", monospace';
    sctx.fillStyle = COLORS.finish;
    sctx.textAlign = 'center';
    sctx.fillText('FINISH', W / 2, fy + 44);
  }

  // ───────────────────────────── Collision helpers
  function collideCircle(b, cx, cy, cr) {
    const dx = b.x - cx, dy = b.y - cy;
    const d2 = dx * dx + dy * dy;
    const minD = b.r + cr;
    if (d2 >= minD * minD || d2 < 0.0001) return false;
    const d = Math.sqrt(d2);
    const nx = dx / d, ny = dy / d;
    const overlap = minD - d;
    b.x += nx * overlap;
    b.y += ny * overlap;
    const vDotN = b.vx * nx + b.vy * ny;
    if (vDotN < 0) {
      b.vx -= (1 + RESTITUTION) * vDotN * nx;
      b.vy -= (1 + RESTITUTION) * vDotN * ny;
    }
    return true;
  }

  function collideSegment(b, x1, y1, x2, y2, halfThick) {
    const dx = x2 - x1, dy = y2 - y1;
    const segLen2 = dx * dx + dy * dy;
    if (segLen2 < 0.0001) return false;
    let t = ((b.x - x1) * dx + (b.y - y1) * dy) / segLen2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const cx = x1 + t * dx, cy = y1 + t * dy;
    const dxc = b.x - cx, dyc = b.y - cy;
    const d2 = dxc * dxc + dyc * dyc;
    const minD = b.r + halfThick;
    if (d2 >= minD * minD || d2 < 0.0001) return false;
    const d = Math.sqrt(d2);
    const nx = dxc / d, ny = dyc / d;
    const overlap = minD - d;
    b.x += nx * overlap;
    b.y += ny * overlap;
    const vDotN = b.vx * nx + b.vy * ny;
    if (vDotN < 0) {
      b.vx -= (1 + RESTITUTION) * vDotN * nx;
      b.vy -= (1 + RESTITUTION) * vDotN * ny;
    }
    return true;
  }

  function spark(x, y, color, n) {
    for (let i = 0; i < n; i++) {
      particles.push({
        x, y,
        vx: (rand() - 0.5) * 3.6,
        vy: (rand() - 0.5) * 3.6 - 0.6,
        life: 0.4 + rand() * 0.3,
        color
      });
    }
    if (particles.length > 80) particles.splice(0, particles.length - 80);
  }

  // ───────────────────────────── Physics step
  function step(dt) {
    // Update kinematic obstacles first
    for (const o of kinObs) {
      if (o.kind === 'arm' || o.kind === 'gear') {
        o.angle += o.omega * dt;
      } else if (o.kind === 'hammer') {
        o.phase += o.omega * dt;
        o.angle = o.baseAngle + Math.sin(o.phase) * o.amp;
      }
    }

    // Integrate + collide each ball
    for (const b of balls) {
      if (!b.alive || b.finished) continue;

      // Forces
      b.vy += GRAVITY * dt;
      if (b.vy > TERMINAL_VY) b.vy = TERMINAL_VY;
      b.vx *= Math.pow(AIR_DRAG_X, dt);
      b.vy *= Math.pow(AIR_DRAG_Y, dt);

      // Integrate
      b.x += b.vx * dt;
      b.y += b.vy * dt;

      // Walls (cheap)
      if (b.x < 22 + b.r) { b.x = 22 + b.r; if (b.vx < 0) b.vx = -b.vx * RESTITUTION; }
      if (b.x > W - 22 - b.r) { b.x = W - 22 - b.r; if (b.vx > 0) b.vx = -b.vx * RESTITUTION; }

      // Bucket lookup
      const bucketIdx = Math.floor(b.y / bucketsH);
      let hit = false;
      for (let bi = Math.max(0, bucketIdx - 1); bi <= Math.min(buckets.length - 1, bucketIdx + 1); bi++) {
        const list = buckets[bi];
        for (let oi = 0; oi < list.length; oi++) {
          const o = list[oi];
          if (o.kind === 'circle') {
            if (collideCircle(b, o.x, o.y, o.r)) {
              hit = true;
              if (b._cooldown <= 0) {
                spark(b.x, b.y, b.color, 5);
                blip(360 + rand() * 80, 60, 'square', 0.06);
                b._cooldown = 0.08;
              }
            }
          } else if (o.kind === 'segment') {
            if (collideSegment(b, o.x1, o.y1, o.x2, o.y2, o.thick / 2)) {
              hit = true;
              if (b._cooldown <= 0) {
                spark(b.x, b.y, b.color, 4);
                blip(280 + rand() * 60, 80, 'sawtooth', 0.05);
                b._cooldown = 0.08;
              }
            }
          } else if (o.kind === 'arm') {
            const ex = o.cx + Math.cos(o.angle) * o.length;
            const ey = o.cy + Math.sin(o.angle) * o.length;
            if (collideSegment(b, o.cx, o.cy, ex, ey, o.thick / 2)) {
              hit = true;
              // tangential kick
              const tx = -Math.sin(o.angle), ty = Math.cos(o.angle);
              const kick = o.omega * o.length * 1.2;
              b.vx += tx * kick * 0.5;
              b.vy += ty * kick * 0.5;
              if (b._cooldown <= 0) {
                spark(b.x, b.y, o.color, 6);
                blip(180, 100, 'sawtooth', 0.07);
                b._cooldown = 0.1;
              }
            }
          } else if (o.kind === 'gear') {
            // gear is a circle plus teeth — approximate as a slightly bigger circle for collision
            if (collideCircle(b, o.cx, o.cy, o.r + 4)) {
              hit = true;
              // tangential spin
              const dx = b.x - o.cx, dy = b.y - o.cy;
              const dlen = Math.hypot(dx, dy) || 1;
              const tx = -dy / dlen, ty = dx / dlen;
              const kick = o.omega * (o.r + 4) * 1.0;
              b.vx += tx * kick * 0.4;
              b.vy += ty * kick * 0.4;
              if (b._cooldown <= 0) {
                spark(b.x, b.y, o.color, 5);
                blip(240, 80, 'square', 0.05);
                b._cooldown = 0.08;
              }
            }
          } else if (o.kind === 'hammer') {
            const bx = o.cx + Math.cos(o.angle) * o.length;
            const by = o.cy + Math.sin(o.angle) * o.length;
            // shaft
            collideSegment(b, o.cx, o.cy, bx, by, o.thick / 2);
            // bob
            if (collideCircle(b, bx, by, o.bobR)) {
              hit = true;
              // hammer head adds a hard tangential punch
              const tx = -Math.sin(o.angle), ty = Math.cos(o.angle);
              const kick = o.omega * o.length * o.amp * 1.4;
              b.vx += tx * kick * 0.6;
              b.vy += ty * kick * 0.6;
              if (b._cooldown <= 0) {
                spark(b.x, b.y, o.color, 8);
                blip(140, 130, 'sawtooth', 0.09);
                b._cooldown = 0.12;
              }
            }
          }
        }
      }

      b._cooldown = Math.max(0, b._cooldown - 0.016 * dt);

      // No multiplicative friction on contact — let the marble keep its
      // tangential speed so rolling on slopes actually accelerates instead
      // of decaying frame-by-frame.

      // Trail (sparse)
      b._trailT = (b._trailT || 0) + dt;
      if (b._trailT > 1.6) {
        b._trailT = 0;
        b.trail.push(b.x, b.y);
        if (b.trail.length > 24) b.trail.splice(0, 2);
      }

      // Finish?
      if (!b.finished && b.y >= FINISH_Y) {
        b.finished = true;
        b.finishedAt = raceElapsed;
        if (winner === null) {
          winner = b.label;
          // Snapshot the trailing marble's y at the moment of crossing — that's
          // the real margin of victory in pixels.
          const other = balls.find(x => x !== b);
          winnerMarginPx = other ? Math.max(0, Math.round(FINISH_Y - other.y)) : 0;
          mode = 'finishing';
          finishDelay = 1.0;       // sec of hold before result reveal
          chord(b.label === 'yes' ? [392, 494, 587, 784] : [330, 261, 196, 165], 480, 'sawtooth');
        }
      }
    }

    // Ball-ball soft contact (gives them a chance to bump and trade lead)
    if (balls.length === 2 && balls[0].alive && balls[1].alive) {
      const a = balls[0], c = balls[1];
      const dx = c.x - a.x, dy = c.y - a.y;
      const d2 = dx * dx + dy * dy;
      const minD = a.r + c.r;
      if (d2 < minD * minD && d2 > 0.0001) {
        const d = Math.sqrt(d2);
        const nx = dx / d, ny = dy / d;
        const overlap = minD - d;
        a.x -= nx * overlap * 0.5; a.y -= ny * overlap * 0.5;
        c.x += nx * overlap * 0.5; c.y += ny * overlap * 0.5;
        const va = a.vx * nx + a.vy * ny;
        const vc = c.vx * nx + c.vy * ny;
        const dv = vc - va;
        a.vx += dv * nx * 0.7; a.vy += dv * ny * 0.7;
        c.vx -= dv * nx * 0.7; c.vy -= dv * ny * 0.7;
      }
    }

    // Particles
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 0.18 * dt;
      p.life -= 0.025 * dt;
      if (p.life <= 0) particles.splice(i, 1);
    }
  }

  // ───────────────────────────── Camera
  function updateCamera(dt) {
    // Follow the leader (greatest y). If the race is over, stay on the winner.
    let leadY = 0;
    if (winner) {
      const b = balls.find(b => b.label === winner);
      leadY = b ? b.y : leadY;
    } else {
      for (const b of balls) if (b.y > leadY) leadY = b.y;
    }
    cameraTargetY = leadY - H_VIEW * 0.42;
    if (cameraTargetY < 0) cameraTargetY = 0;
    if (cameraTargetY > WORLD_H - H_VIEW) cameraTargetY = WORLD_H - H_VIEW;
    // Smooth lerp
    const k = mode === 'finishing' ? 0.06 : 0.14;
    cameraY += (cameraTargetY - cameraY) * Math.min(1, k * dt);
  }

  // ───────────────────────────── Rendering
  function render() {
    // Background sweep
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H_VIEW);

    // Blit visible slice of static prerender
    const camY = Math.max(0, Math.min(WORLD_H - H_VIEW, Math.floor(cameraY)));
    ctx.drawImage(
      staticCanvas,
      0, camY, W, H_VIEW,
      0, 0, W, H_VIEW
    );

    // World-coord draws
    ctx.save();
    ctx.translate(0, -camY);

    // Kinematic obstacles (only those visible)
    const yMin = camY - 40, yMax = camY + H_VIEW + 40;
    for (const o of kinObs) {
      if (o.cy < yMin || o.cy > yMax) continue;
      drawKinematic(o);
    }

    // Particles
    if (particles.length) {
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        if (p.y < yMin || p.y > yMax) continue;
        ctx.globalAlpha = Math.min(1, p.life * 1.6);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    // Trails
    for (const b of balls) drawTrail(b);

    // Balls
    for (const b of balls) drawBall(b);

    ctx.restore();
  }

  function drawKinematic(o) {
    if (o.kind === 'arm') {
      const ex = o.cx + Math.cos(o.angle) * o.length;
      const ey = o.cy + Math.sin(o.angle) * o.length;
      ctx.strokeStyle = o.color;
      ctx.lineWidth = o.thick;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(o.cx, o.cy); ctx.lineTo(ex, ey);
      ctx.stroke();
      ctx.fillStyle = COLORS.bg;
      ctx.beginPath(); ctx.arc(o.cx, o.cy, 5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = COLORS.cyan; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(o.cx, o.cy, 5, 0, Math.PI * 2); ctx.stroke();
    } else if (o.kind === 'gear') {
      ctx.save();
      ctx.translate(o.cx, o.cy);
      ctx.rotate(o.angle);
      ctx.strokeStyle = o.color;
      ctx.fillStyle = 'rgba(2,3,10,0.6)';
      ctx.lineWidth = 2;
      // teeth
      const r = o.r, rt = r + 6;
      const n = o.teeth;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2;
        const a1 = ((i + 0.5) / n) * Math.PI * 2;
        ctx.lineTo(Math.cos(a0) * r, Math.sin(a0) * r);
        ctx.lineTo(Math.cos(a1) * rt, Math.sin(a1) * rt);
      }
      ctx.closePath();
      ctx.fill(); ctx.stroke();
      // hub
      ctx.beginPath(); ctx.arc(0, 0, r * 0.32, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    } else if (o.kind === 'hammer') {
      const bx = o.cx + Math.cos(o.angle) * o.length;
      const by = o.cy + Math.sin(o.angle) * o.length;
      ctx.strokeStyle = o.color;
      ctx.lineWidth = o.thick;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(o.cx, o.cy); ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.fillStyle = o.color;
      ctx.beginPath(); ctx.arc(bx, by, o.bobR, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = COLORS.bg;
      ctx.beginPath(); ctx.arc(bx, by, o.bobR * 0.45, 0, Math.PI * 2); ctx.fill();
      // pivot
      ctx.fillStyle = COLORS.bg;
      ctx.beginPath(); ctx.arc(o.cx, o.cy, 5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = COLORS.cyan; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(o.cx, o.cy, 5, 0, Math.PI * 2); ctx.stroke();
    }
  }

  function drawBall(b) {
    if (!b.alive) return;
    ctx.save();
    ctx.shadowColor = b.color;
    ctx.shadowBlur = 22;
    ctx.fillStyle = b.color;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    // highlight
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath();
    ctx.arc(b.x - b.r * 0.35, b.y - b.r * 0.35, b.r * 0.32, 0, Math.PI * 2);
    ctx.fill();
    // letter
    ctx.fillStyle = COLORS.bg;
    ctx.font = 'bold 12px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(b.label === 'yes' ? 'Y' : 'N', b.x, b.y + 1);
    ctx.restore();
  }

  function drawTrail(b) {
    if (!b.alive || !b.trail || b.trail.length < 4) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const n = b.trail.length / 2;
    for (let i = 0; i < n; i++) {
      const tx = b.trail[i * 2];
      const ty = b.trail[i * 2 + 1];
      const k = i / n;
      ctx.globalAlpha = k * 0.45;
      ctx.fillStyle = b.color;
      ctx.beginPath();
      ctx.arc(tx, ty, b.r * (0.4 + k * 0.5), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // ───────────────────────────── HUD: lead indicator
  function updateScoreboard() {
    if (mode !== 'racing' && mode !== 'finishing') return;
    let leadLabel;
    if (winner) leadLabel = winner;
    else {
      const [a, b] = balls;
      leadLabel = a.y >= b.y ? a.label : b.label;
    }
    scoreYes.classList.toggle('lead', leadLabel === 'yes');
    scoreNo.classList.toggle('lead',  leadLabel === 'no');
  }

  // ───────────────────────────── Lifecycle
  function spawnBalls() {
    const startY = 70;
    balls = [
      {
        label: 'yes', color: COLORS.cyan,
        x: W * 0.40 + rrange(-6, 6), y: startY,
        vx: rrange(-0.4, 0.4), vy: 0,
        r: BALL_R, alive: true, finished: false,
        trail: [], _cooldown: 0
      },
      {
        label: 'no',  color: COLORS.magenta,
        x: W * 0.60 + rrange(-6, 6), y: startY,
        vx: rrange(-0.4, 0.4), vy: 0,
        r: BALL_R, alive: true, finished: false,
        trail: [], _cooldown: 0
      }
    ];
  }

  function startRace(seed) {
    if (mode === 'racing' || mode === 'finishing') return;
    ensureAudio();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();

    buildCourse(seed);
    prerenderStatic();
    spawnBalls();
    cameraY = 0; cameraTargetY = 0;
    winner = null;
    winnerMarginPx = 0;
    mode = 'racing';
    raceStart = performance.now();
    raceElapsed = 0;

    const q = qInput.value.trim();
    banner.textContent = q ? `“${q}”` : '';
    menu.classList.add('hidden');
    result.classList.add('hidden');
    hud.classList.remove('hidden');
    scoreYes.classList.remove('lead');
    scoreNo.classList.remove('lead');

    // tone-up
    blip(440, 90, 'square', 0.08);
    setTimeout(() => blip(660, 90, 'square', 0.08), 110);
  }

  function endRace(which) {
    mode = 'done';
    verdict.textContent = which.toUpperCase();
    verdict.className = 'verdict ' + which;
    const secs = (raceElapsed / 1000).toFixed(1);
    const margin = winnerMarginPx;
    let marginLabel;
    if (margin <= 6) marginLabel = 'PHOTO FINISH';
    else if (margin <= 50)  marginLabel = `WON BY ${margin} PX`;
    else if (margin <= 200) marginLabel = `WON BY A NOSE — ${margin} PX`;
    else marginLabel = `WON GOING AWAY — ${margin} PX`;
    resultMeta.textContent = `${secs}S · ${marginLabel}`;
    result.classList.remove('hidden');
    hud.classList.add('hidden');
    writeUrlState();
  }

  // ───────────────────────────── URL state & share
  function parseUrl() {
    try {
      const u = new URL(window.location.href);
      const seedRaw = u.searchParams.get('seed');
      const q = u.searchParams.get('q') || '';
      const seed = seedRaw ? (parseInt(seedRaw, 16) >>> 0) : null;
      return { seed, q };
    } catch (e) { return { seed: null, q: '' }; }
  }
  function writeUrlState() {
    try {
      const u = new URL(window.location.href);
      u.searchParams.set('seed', currentSeed.toString(16));
      const q = (qInput.value || '').trim();
      if (q) u.searchParams.set('q', q); else u.searchParams.delete('q');
      window.history.replaceState({}, '', u.toString());
    } catch (e) {}
  }
  // ───────────────────────────── Main loop
  // Fixed-timestep physics + variable-rate rendering so behavior is identical
  // regardless of frame rate or rAF throttling.
  const FIXED_DT_MS = 1000 / 60;          // physics tick = 1 simulated frame
  const FIXED_DT    = 1;                  // dt passed to step() in frame units
  const MAX_TICKS   = 16;                 // cap catch-up to avoid spirals
  let physAccum = 0;
  let lastT = performance.now();

  function loop(now) {
    let frameMs = now - lastT;
    if (frameMs > 250) frameMs = 250;     // clamp huge gaps (tab return)
    lastT = now;

    if (mode === 'racing' || mode === 'finishing') {
      physAccum += frameMs;
      let ticks = 0;
      while (physAccum >= FIXED_DT_MS && ticks < MAX_TICKS) {
        const sub = FIXED_DT / SUBSTEPS;
        for (let s = 0; s < SUBSTEPS; s++) step(sub);
        physAccum -= FIXED_DT_MS;
        ticks++;
        raceElapsed += FIXED_DT_MS;
      }
      if (ticks === MAX_TICKS) physAccum = 0;
      updateCamera(frameMs / FIXED_DT_MS);
      updateScoreboard();

      if (mode === 'finishing') {
        finishDelay -= frameMs / 1000;
        if (finishDelay <= 0) endRace(winner);
      }
    } else {
      updateCamera(frameMs / FIXED_DT_MS);
    }

    render();
    scheduleNext(loop);
  }

  function scheduleNext(fn) {
    // Hybrid: rAF when the tab is active, setTimeout(16) fallback when
    // rAF is throttled (hidden tabs, iframe previews). First one wins.
    let called = false;
    const guard = (t) => { if (called) return; called = true; fn(t || performance.now()); };
    const fb = setTimeout(() => guard(performance.now()), 24);
    requestAnimationFrame((t) => { clearTimeout(fb); guard(t); });
  }

  // ───────────────────────────── UI wiring
  flipBtn.addEventListener('click', () => {
    if (mode === 'racing' || mode === 'finishing') return;
    const seed = (pendingSeed != null) ? pendingSeed : ((Math.random() * 0xffffffff) >>> 0);
    pendingSeed = null;
    startRace(seed);
  });
  qInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); flipBtn.click(); }
  });
  againBtn.addEventListener('click', () => {
    mode = 'idle';
    winner = null;
    balls = [];
    particles = [];
    result.classList.add('hidden');
    hud.classList.add('hidden');
    menu.classList.remove('hidden');
    qInput.focus();
  });
  muteBtn.addEventListener('click', () => {
    muted = !muted;
    try { localStorage.setItem('flipper.muted', muted ? '1' : '0'); } catch (e) {}
    applyMuteUI();
  });
  window.addEventListener('keydown', (e) => {
    const inField = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
    if (inField) return;
    if (e.key === ' ' || e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      if (mode === 'idle')      flipBtn.click();
      else if (mode === 'done') { againBtn.click(); setTimeout(() => flipBtn.click(), 50); }
    } else if (e.key === 'm' || e.key === 'M') {
      muteBtn.click();
    }
  });

  // ───────────────────────────── Boot
  (() => {
    const { seed, q } = parseUrl();
    if (q && !qInput.value) qInput.value = q;
    if (seed != null) pendingSeed = seed;
    // Bake an idle backdrop so the menu has something nice behind it
    buildCourse((Math.random() * 0xffffffff) >>> 0);
    prerenderStatic();
    cameraY = 0;
    lastT = performance.now();
    scheduleNext(loop);
  })();
})();
