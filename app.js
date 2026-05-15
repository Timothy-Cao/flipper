/* FLIPPER — neon marble race oracle.
 *
 * Two teams of marbles (YES green, NO red) drop down a long vertical course
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
  const settingsToggle = document.getElementById('settingsToggle');
  const settingsPanel  = document.getElementById('settingsPanel');
  const weightSlider   = document.getElementById('weightSlider');
  const weightText     = document.getElementById('weightText');
  const fatal     = document.getElementById('fatal');
  const exploreBtn = document.getElementById('explore');

  const placeholders = [
    'Should I do 10 pushups right now?',
    'Should I text my crush?',
    'Should I call a random friend?',
    'Should I go for a walk outside?',
    'Should I finally start that project?',
    'Should I learn a new recipe tonight?',
    'Should I compliment a stranger today?',
    'Should I sign up for that class?',
    'Should I try cold showers for a week?',
    'Should I read a book instead of scrolling?',
    'Should I ask for that raise?',
    'Should I plan a spontaneous trip?',
    'Should I write a letter to someone I miss?',
    'Should I wake up early tomorrow?',
    'Should I delete social media for a week?',
    'Should I donate to that cause?',
    'Should I say yes to the next invite?',
    'Should I forgive them?',
  ];
  let phIdx = Math.random() * placeholders.length | 0;
  qInput.placeholder = placeholders[phIdx];
  setInterval(() => {
    if (qInput.value) return;
    phIdx = (phIdx + 1) % placeholders.length;
    qInput.placeholder = placeholders[phIdx];
  }, 4000);

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
  // Hand-designed course — one fixed layout that varies per-seed only through
  // spinner phases and start-impulse jitter.
  const WORLD_H   = 4150;
  const FINISH_Y  = 4010;

  // Physics — tuned to feel like a marble race: bouncy contacts, free
  // rolling on ramps, no per-contact velocity drain. Pinball bumpers use
  // their own much-higher per-obstacle restitution.
  const GRAVITY          = 0.23;    // px / frame² (60fps reference) - low, drifty
  const LEAD_GRAVITY_SCALE = 0.82;  // leader floats a touch
  const COMEBACK_GRAVITY_BOOST = 0.42;
  const COMEBACK_DISTANCE = 900;    // px behind leader to reach max boost
  const AIR_DRAG_X       = 0.996;
  const AIR_DRAG_Y       = 0.9994;
  const TERMINAL_VY      = 6.4;
  const MAX_BALL_SPEED   = 80;
  const RESTITUTION      = 0.66;    // default for walls/pegs/pads
  const PLINKO_RESTITUTION = 0.82;  // a little livelier than rails
  const BUMPER_RESTITUTION = 0.92;
  const BALL_R           = 16;
  const SUBSTEPS         = 3;       // physics sub-steps per render frame
  const TOTAL_BALLS      = 10;
  const DEFAULT_YES_BALLS = 5;

  const COLORS = {
    bg:        '#03040a',
    bg_far:    '#08091a',
    cyan:      '#33d7ff',     // course theme - walls / pegs / arms
    magenta:   '#9b7cff',     // course theme - walls / pegs / arms
    finish:    '#ffd84a',
    yesBall:   '#3dff8a',     // marbles - green
    noBall:    '#ff4660'      // marbles - red
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
  let winnerBall   = null;
  let winnerMarginPx = 0;
  let raceStart    = 0;
  let raceElapsed  = 0;
  let finishDelay  = 0;      // counted down while finishing
  let finishFxStart = 0;
  let currentSeed  = 0;
  let pendingSeed  = null;
  let yesBallCount = DEFAULT_YES_BALLS;

  let screenShake  = 0;

  // Explore / pan mode
  let exploring    = false;
  let exploreCamY  = 0;
  let dragStartY   = null;
  let dragCamStart = 0;

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

    // Hand-designed sequence. Y coords laid out top-to-bottom.
    buildStartFunnel(0);            //   0 — 240   opening plinko, immediately
    buildBlackHoles(240);           // 240 — 480   alternating gravity wells
    buildPlinkoTwinFunnel(480);     // 480 — 1060  deeper plinko into twin funnels
    buildHexSpinners(1060);         // 1060 — 1980 hex tiling of 7 giant X rotors
    buildGateChannels(1980);        // 1980 — 2300 dividers + moving-hole gate
    buildPinballField(2300);        // 2300 — 2780 wall of bouncy circular bumpers
    buildFinishFunnel(2780);        // 2780 — 3560 funnel, flipper chute, finish

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
      if (o.kind === 'arm' || o.kind === 'gear') insert(o, o.cy - o.length - 6, o.cy + o.length + 6);
      else if (o.kind === 'wallFlipper')         insert(o, o.cy - o.length - 12, o.cy + o.length + 12);
      else if (o.kind === 'hammer')              insert(o, o.cy - 8, o.cy + o.length + o.bobR + 8);
      else if (o.kind === 'movingFloor')         insert(o, o.y - 30, o.y + 30);
      else if (o.kind === 'blackHole')           insert(o, o.cy - o.pullR - 4, o.cy + o.pullR + 4);
      else if (o.kind === 'breakPlatform')      insert(o, o.y - 20, o.y + 20);
      else if (o.kind === 'bumper')             insert(o, o.cy - o.r - 10, o.cy + o.r + 10);
    }
  }

  function pushStaticSegment(x1, y1, x2, y2, thick, color, cap = 'round') {
    staticObs.push({ kind: 'segment', x1, y1, x2, y2, thick, color, cap });
  }
  function pushStaticCircle(x, y, r, color) {
    staticObs.push({ kind: 'circle', x, y, r, color });
  }
  function pushSectionLabel(text, y) {
  }
  function pushPlinkoPeg(x, y, r, color) {
    staticObs.push({
      kind: 'circle',
      x, y, r, color,
      restitution: PLINKO_RESTITUTION
    });
  }
  function pushPlinkoSideRails(y1, y2) {
    pushStaticSegment(38, y1, 38, y2, 5, COLORS.cyan);
    pushStaticSegment(W - 38, y1, W - 38, y2, 5, COLORS.magenta);
  }

  // ───────────────────────────── The course
  // Marbles spawn at the top, side-by-side. Each stage below is hand-tuned.

  function pushBumper(x, y, r) {
    kinObs.push({
      kind: 'bumper',
      cx: x, cy: y, r,
      baseR: r,
      color: COLORS.finish,
      restitution: BUMPER_RESTITUTION,
      hitT: 0
    });
  }

  // 1 · Opening plinko. The marbles hit pegs almost immediately, so the
  // first split is chaotic instead of a queue into a bottleneck.
  function buildStartFunnel(y0) {
    pushSectionLabel('OPENING PLINKO', y0 + 48);
    const rows = 3;
    const left = 64;
    const right = W - 64;
    pushPlinkoSideRails(y0 + 72, y0 + 236);
    for (let r = 0; r < rows; r++) {
      const cols = 10 - (r % 2);
      const gap = (right - left) / (cols - 1);
      for (let c = 0; c < cols; c++) {
        const px = left + gap * c;
        const py = y0 + 96 + r * 58;
        pushPlinkoPeg(px, py, 12, COLORS.cyan);
      }
    }
  }

  // 2 · Four gravity wells that alternate on/off in pairs.
  function buildBlackHoles(y0) {
    pushSectionLabel('GRAVITY WELLS', y0 + 22);
    const positions = [
      { x: W * 0.22, y: y0 + 80,  group: 0 },
      { x: W * 0.78, y: y0 + 80,  group: 1 },
      { x: W * 0.35, y: y0 + 190, group: 1 },
      { x: W * 0.65, y: y0 + 190, group: 0 },
    ];
    for (const p of positions) {
      kinObs.push({
        kind: 'blackHole',
        cx: p.x,
        cy: p.y,
        visR: 18,
        pullR: 250,
        strength: 1.0,
        group: p.group,
        phase: rand() * Math.PI * 2,
        period: 2.2 + rand() * 0.6,
        active: 0,
        color: p.group === 0 ? COLORS.cyan : COLORS.magenta
      });
    }
  }

  // 3 · Plinko field that drops into two side-by-side funnels.
  function buildPlinkoTwinFunnel(y0) {
    pushSectionLabel('TWIN PLINKO', y0 + 18);
    // Dense plinko (7 rows, 9–10 cols)
    const rows = 7;
    const left = 62;
    const right = W - 62;
    pushPlinkoSideRails(y0 + 14, y0 + 402);
    for (let r = 0; r < rows; r++) {
      const cols = 9 + (r % 2);
      const gap = (right - left) / (cols - 1);
      for (let c = 0; c < cols; c++) {
        const px = left + gap * c;
        const py = y0 + 40 + r * 54;
        pushPlinkoPeg(px, py, 13, COLORS.cyan);
      }
    }
    // Twin funnels below — split the canvas left / right with a center pin.
    const fTop = y0 + 430;
    const fBot = y0 + 570;
    pushStaticSegment(50,        fTop,  W/4 - 22,    fBot, 6, COLORS.cyan);
    pushStaticSegment(W/2 - 28,  fTop,  W/4 + 22,    fBot, 6, COLORS.cyan);
    pushStaticSegment(W/2 + 28,  fTop,  3*W/4 - 22,  fBot, 6, COLORS.magenta);
    pushStaticSegment(W - 50,    fTop,  3*W/4 + 22,  fBot, 6, COLORS.magenta);
    // Center divider tip (forces a deterministic left/right split)
    pushStaticCircle(W/2, fTop - 4, 10, '#ffd84a');
  }

  // 4 · Hex-tile arrangement of 7 giant 4-arm rotors:
  //     ●   ●          (row of 2)
  //   ●   ●   ●        (row of 3, offset)
  //     ●   ●          (row of 2)
  function buildHexSpinners(y0) {
    pushSectionLabel('ROTOR HEX', y0 + 56);
    const armLen = 102;
    const thick  = 18;
    // Tight hex spacing: adjacent crosses nearly touch, but leave
    // ball-sized gaps that can open and close as the arms rotate.
    const rowGap = 210;
    const xL = W * 0.30, xR = W * 0.70;
    const xA = W * 0.16, xB = W * 0.50, xC = W * 0.84;
    const y1 = y0 + 150;
    const y2 = y0 + 150 + rowGap;
    const y3 = y0 + 150 + rowGap * 2;
    // alternating direction reads as "interlocked gears"
    spawnRotor(xL, y1, armLen, thick, COLORS.cyan,    +1);
    spawnRotor(xR, y1, armLen, thick, COLORS.magenta, -1);
    spawnRotor(xA, y2, armLen, thick, COLORS.magenta, -1);
    spawnRotor(xB, y2, armLen, thick, COLORS.cyan,    +1);
    spawnRotor(xC, y2, armLen, thick, COLORS.magenta, -1);
    spawnRotor(xL, y3, armLen, thick, COLORS.magenta, +1);
    spawnRotor(xR, y3, armLen, thick, COLORS.cyan,    -1);
  }
  function spawnRotor(cx, cy, length, thick, color, dir) {
    const omega = dir * 0.024;
    const baseAngle = rand() * Math.PI * 2;
    for (let i = 0; i < 4; i++) {
      kinObs.push({
        kind: 'arm',
        cx, cy, length, omega,
        angle: baseAngle + i * (Math.PI / 2),
        thick,
        color
      });
    }
    pushStaticCircle(cx, cy, 14, color);     // hub
  }

  // 5 · Gated channels — dividers split the section into booths, and a
  //     moving hole sweeps the floor below. Marbles wait on the floor for
  //     the hole to pass under them.
  function buildGateChannels(y0) {
    pushSectionLabel('TIMING BOOTHS', y0 + 10);
    const dividerTop = y0 + 20;
    const floorY = y0 + 240;
    const dividerBot = floorY - 6;
    const lanes = 8;
    const laneW = (W - 40) / lanes;
    for (let i = 1; i < lanes; i++) {
      const dx = 20 + laneW * i;
      pushStaticSegment(dx, dividerTop, dx, dividerBot, 4, i % 2 === 0 ? COLORS.cyan : COLORS.magenta);
    }
    kinObs.push({
      kind: 'movingFloor',
      y: floorY,
      floorThick: 9,
      holeWidth: laneW * 1.62,
      amp: W / 2 - 68,
      period: 3.0,
      phase: rand() * Math.PI * 2,
      color: COLORS.cyan
    });
  }

  // 6 · Pinball field — symmetrical layout with varied sizes, wall bumpers,
  //     and coverage up near the funnel mouth.
  function buildPinballField(y0) {
    pushSectionLabel('BUMPER BANK', y0 + 18);
    const cx = W / 2;
    // Wall-hugging half-circles along edges
    pushBumper(20,    y0 + 70,  28);
    pushBumper(W-20,  y0 + 70,  28);
    pushBumper(20,    y0 + 200, 16);
    pushBumper(W-20,  y0 + 200, 24);
    // Interior rows — offsets from center
    const rows = [
      { y: y0 + 55,  xs: [-220, -110, 0, 110, 220],        rs: [26, 16, 22, 16, 26] },
      { y: y0 + 130, xs: [-275, -165, -55, 55, 165, 275],  rs: [14, 22, 18, 18, 22, 14] },
      { y: y0 + 210, xs: [-220, -110, 0, 110, 220],        rs: [18, 28, 14, 28, 18] },
      { y: y0 + 295, xs: [-275, -165, -55, 55, 165, 275],  rs: [10, 16, 24, 24, 16, 10] },
      { y: y0 + 380, xs: [-110, 0, 110],                    rs: [14, 26, 14] },
    ];
    for (const row of rows) {
      for (let i = 0; i < row.xs.length; i++) {
        const bx = cx + row.xs[i];
        if (bx > 40 && bx < W - 40) pushBumper(bx, row.y, row.rs[i]);
      }
    }
    // Shrink bumpers that are too close — balls need at least 24px gap
    const bumpers = kinObs.filter(o => o.kind === 'bumper');
    const minGap = 24;
    for (let i = 0; i < bumpers.length; i++) {
      for (let j = i + 1; j < bumpers.length; j++) {
        const a = bumpers[i], b = bumpers[j];
        const dx = a.cx - b.cx, dy = a.cy - b.cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const gap = dist - a.r - b.r;
        if (gap < minGap) {
          const shrink = (minGap - gap) / 2 + 1;
          const bigger = a.r >= b.r ? a : b;
          bigger.r = Math.max(6, bigger.r - shrink);
          bigger.baseR = bigger.r;
        }
      }
    }
  }

  function spawnWallFlipper(side, y, phase) {
    const wallX = side === 'left' ? W / 2 - 120 : W / 2 + 120;
    const base = side === 'left' ? 0.22 : Math.PI - 0.22;
    const swing = side === 'left' ? -1.35 : 1.35;
    kinObs.push({
      kind: 'wallFlipper',
      side,
      cx: wallX,
      cy: y,
      length: 110,
      thick: 14,
      baseAngle: base,
      swing,
      angle: base,
      phase,
      omega: 0.047 + rand() * 0.025,
      active: 0,
      color: side === 'left' ? COLORS.cyan : COLORS.magenta
    });
  }

  // 7 · Long final funnel into a flipper chute with breakable platforms,
  //     then pinball flippers, then straight into the finish.
  function buildFinishFunnel(y0) {
    pushSectionLabel('KICKER CHUTE', y0 + 32);
    pushStaticSegment(40,     y0,      W/2 - 120, y0 + 190, 8, COLORS.cyan);
    pushStaticSegment(W - 40, y0,      W/2 + 120, y0 + 190, 8, COLORS.magenta);

    const chuteTop = y0 + 190;
    const chuteBot = y0 + 1170;
    pushStaticSegment(W/2 - 120, chuteTop, W/2 - 120, chuteBot, 7, COLORS.cyan);
    pushStaticSegment(W/2 + 120, chuteTop, W/2 + 120, chuteBot, 7, COLORS.magenta);

    // Breakable platforms — 15 thin shelves that shatter on first hit
    pushSectionLabel('GLASS FLOOR', chuteTop + 30);
    const platLeft  = W / 2 - 116;
    const platRight = W / 2 + 116;
    for (let i = 0; i < 15; i++) {
      const py = chuteTop + 70 + i * 32;
      kinObs.push({
        kind: 'breakPlatform',
        x1: platLeft,
        x2: platRight,
        y: py,
        thick: 4,
        broken: false,
        restitution: 1.4,
        color: COLORS.finish
      });
    }

    const flipY = chuteTop + 520 + 280;
    spawnWallFlipper('left',  flipY, rand() * Math.PI * 2);
    spawnWallFlipper('right', flipY, rand() * Math.PI * 2);
  }

  // ───────────────────────────── Prerender static layer
  function prerenderStatic() {
    sctx.fillStyle = COLORS.bg;
    sctx.fillRect(0, 0, W, WORLD_H);

    // Subtle vertical gradient bands for depth
    const bgGrad = sctx.createLinearGradient(0, 0, 0, WORLD_H);
    bgGrad.addColorStop(0, 'rgba(51, 215, 255, 0.02)');
    bgGrad.addColorStop(0.3, 'rgba(0, 0, 0, 0)');
    bgGrad.addColorStop(0.5, 'rgba(155, 124, 255, 0.015)');
    bgGrad.addColorStop(0.7, 'rgba(0, 0, 0, 0)');
    bgGrad.addColorStop(1, 'rgba(255, 216, 74, 0.02)');
    sctx.fillStyle = bgGrad;
    sctx.fillRect(0, 0, W, WORLD_H);

    // Faint grid — horizontal + vertical for depth
    sctx.strokeStyle = 'rgba(51, 215, 255, 0.035)';
    sctx.lineWidth = 1;
    for (let y = 0; y < WORLD_H; y += 100) {
      sctx.beginPath(); sctx.moveTo(0, y); sctx.lineTo(W, y); sctx.stroke();
    }
    sctx.strokeStyle = 'rgba(51, 215, 255, 0.02)';
    for (let x = 0; x < W; x += 100) {
      sctx.beginPath(); sctx.moveTo(x, 0); sctx.lineTo(x, WORLD_H); sctx.stroke();
    }

    // Static obstacles
    sctx.lineCap = 'round';
    for (const o of staticObs) {
      if (o.kind === 'circle') {
        sctx.save();
        // Radial gradient fill for 3D depth
        const pg = sctx.createRadialGradient(
          o.x - o.r * 0.3, o.y - o.r * 0.3, o.r * 0.1,
          o.x, o.y, o.r
        );
        if (o.color === COLORS.magenta) {
          pg.addColorStop(0, 'rgba(180, 155, 255, 0.3)');
          pg.addColorStop(1, 'rgba(155, 124, 255, 0.08)');
        } else {
          pg.addColorStop(0, 'rgba(80, 230, 255, 0.3)');
          pg.addColorStop(1, 'rgba(51, 215, 255, 0.08)');
        }
        sctx.fillStyle = pg;
        sctx.beginPath();
        sctx.arc(o.x, o.y, o.r, 0, Math.PI * 2);
        sctx.fill();
        sctx.strokeStyle = o.color;
        sctx.lineWidth = 2;
        sctx.stroke();
        sctx.restore();
      } else if (o.kind === 'segment') {
        sctx.lineCap = o.cap || 'round';
        sctx.strokeStyle = o.color;
        sctx.lineWidth = o.thick;
        sctx.beginPath();
        sctx.moveTo(o.x1, o.y1); sctx.lineTo(o.x2, o.y2);
        sctx.stroke();
      } else if (o.kind === 'label') {
        sctx.save();
        sctx.font = 'bold 11px "Courier New", monospace';
        sctx.textAlign = 'center';
        sctx.textBaseline = 'middle';
        // Subtle line behind label
        const tw = sctx.measureText(o.text).width;
        sctx.strokeStyle = 'rgba(51, 215, 255, 0.08)';
        sctx.lineWidth = 1;
        sctx.beginPath();
        sctx.moveTo(o.x - tw / 2 - 20, o.y);
        sctx.lineTo(o.x + tw / 2 + 20, o.y);
        sctx.stroke();
        sctx.fillStyle = 'rgba(216,232,255,0.5)';
        sctx.shadowColor = COLORS.cyan;
        sctx.shadowBlur = 10;
        sctx.fillText(o.text, o.x, o.y);
        sctx.restore();
      }
    }

    // Finish line band
    const fy = FINISH_Y;
    const grad = sctx.createLinearGradient(0, fy - 10, 0, fy + 80);
    grad.addColorStop(0, 'rgba(255, 216, 74, 0.0)');
    grad.addColorStop(0.3, 'rgba(255, 216, 74, 0.25)');
    grad.addColorStop(0.5, 'rgba(255, 216, 74, 0.4)');
    grad.addColorStop(1, 'rgba(255, 216, 74, 0.0)');
    sctx.fillStyle = grad;
    sctx.fillRect(0, fy - 10, W, 90);
    // Checker bands
    sctx.fillStyle = COLORS.finish;
    const stripe = 16;
    for (let x = 0; x < W; x += stripe) {
      sctx.fillRect(x, fy, stripe / 2, 3);
      sctx.fillRect(x + stripe / 2, fy + 6, stripe / 2, 3);
    }
    // Finish label with glow
    sctx.save();
    sctx.font = 'bold 20px "Courier New", monospace';
    sctx.fillStyle = COLORS.finish;
    sctx.textAlign = 'center';
    sctx.shadowColor = COLORS.finish;
    sctx.shadowBlur = 16;
    sctx.fillText('FINISH', W / 2, fy + 38);
    sctx.restore();
  }

  // ───────────────────────────── Collision helpers
  // `rest` overrides the default restitution; bumpers and plinko pegs pass
  // their own tuned values here.
  function collideCircle(b, cx, cy, cr, rest) {
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
      const r = rest != null ? rest : RESTITUTION;
      b.vx -= (1 + r) * vDotN * nx;
      b.vy -= (1 + r) * vDotN * ny;
    }
    return true;
  }

  function collideSegment(b, x1, y1, x2, y2, halfThick, rest) {
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
      const r = rest != null ? rest : RESTITUTION;
      b.vx -= (1 + r) * vDotN * nx;
      b.vy -= (1 + r) * vDotN * ny;
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
    if (particles.length > 48) particles.splice(0, particles.length - 48);
  }

  function clampBallSpeed(b) {
    const speed = Math.hypot(b.vx, b.vy);
    if (speed <= MAX_BALL_SPEED) return;
    const k = MAX_BALL_SPEED / speed;
    b.vx *= k;
    b.vy *= k;
  }

  // ───────────────────────────── Physics step
  function step(dt) {
    // Update kinematic obstacles first
    for (const o of kinObs) {
      if (o.kind === 'arm' || o.kind === 'gear') {
        o.angle += o.omega * dt;
      } else if (o.kind === 'wallFlipper') {
        o.phase += o.omega * dt;
        const pulse = Math.max(0, Math.sin(o.phase));
        o.active = pulse * pulse * pulse;
        const prevAngle = o.angle;
        o.angle = o.baseAngle + o.swing * o.active;
        o.angVel = (o.angle - prevAngle) / dt;
      } else if (o.kind === 'hammer') {
        o.phase += o.omega * dt;
        o.angle = o.baseAngle + Math.sin(o.phase) * o.amp;
      } else if (o.kind === 'movingFloor') {
        // Period is in seconds; dt is in frame units (1 = 1/60s).
        o.phase += (2 * Math.PI / (60 * o.period)) * dt;
      } else if (o.kind === 'bumper') {
        if (o.hitT > 0) {
          o.hitT = Math.max(0, o.hitT - 0.04 * dt);
          o.r = o.baseR + o.hitT * 6;
        }
      } else if (o.kind === 'blackHole') {
        o.phase += (2 * Math.PI / (60 * o.period)) * dt;
        const wave = Math.sin(o.phase);
        o.active = o.group === 0 ? Math.max(0, wave) : Math.max(0, -wave);
      }
    }

    let leaderY = 0;
    for (const b of balls) {
      if (b.alive && !b.finished && b.y > leaderY) leaderY = b.y;
    }

    // Integrate + collide each ball
    for (const b of balls) {
      if (!b.alive) continue;

      // Forces
      const trailing = Math.max(0, leaderY - b.y);
      const comeback = Math.min(
        COMEBACK_GRAVITY_BOOST,
        (trailing / COMEBACK_DISTANCE) * COMEBACK_GRAVITY_BOOST
      );
      b.vy += GRAVITY * (LEAD_GRAVITY_SCALE + comeback) * dt;
      if (b.vy > TERMINAL_VY) b.vy = TERMINAL_VY;
      b.vx *= Math.pow(AIR_DRAG_X, dt);
      b.vy *= Math.pow(AIR_DRAG_Y, dt);
      clampBallSpeed(b);

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
            if (collideCircle(b, o.x, o.y, o.r, o.restitution)) {
              hit = true;
              if (b._cooldown <= 0) {
                spark(b.x, b.y, b.color, 4);
                blip(360 + rand() * 80, 60, 'square', 0.06);
                b._cooldown = 0.08;
              }
            }
          } else if (o.kind === 'segment') {
            if (collideSegment(b, o.x1, o.y1, o.x2, o.y2, o.thick / 2, o.restitution)) {
              hit = true;
              if (b._cooldown <= 0) {
                spark(b.x, b.y, b.color, 3);
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
                spark(b.x, b.y, o.color, 4);
                blip(180, 100, 'sawtooth', 0.07);
                b._cooldown = 0.1;
              }
            }
          } else if (o.kind === 'wallFlipper') {
            const ex = o.cx + Math.cos(o.angle) * o.length;
            const ey = o.cy + Math.sin(o.angle) * o.length;
            if (collideSegment(b, o.cx, o.cy, ex, ey, o.thick / 2, 0.82)) {
              hit = true;
              const dx = b.x - o.cx, dy = b.y - o.cy;
              const contactDist = Math.min(Math.hypot(dx, dy), o.length);
              const tx = -Math.sin(o.angle), ty = Math.cos(o.angle);
              const av = o.angVel || 0;
              const kick = av * contactDist * 3.5;
              b.vx += tx * kick;
              b.vy += ty * kick;
              if (b._cooldown <= 0) {
                spark(b.x, b.y, o.color, 6);
                blip(120 + o.active * 180, 120, 'sawtooth', 0.09);
                b._cooldown = 0.1;
              }
            }
          } else if (o.kind === 'gear') {
            // gear is a circle plus teeth — approximate as a slightly bigger circle for collision
            if (collideCircle(b, o.cx, o.cy, o.r + 4)) {
              hit = true;
              const dx = b.x - o.cx, dy = b.y - o.cy;
              const dlen = Math.hypot(dx, dy) || 1;
              const tx = -dy / dlen, ty = dx / dlen;
              const kick = o.omega * (o.r + 4) * 1.0;
              b.vx += tx * kick * 0.4;
              b.vy += ty * kick * 0.4;
              if (b._cooldown <= 0) {
                spark(b.x, b.y, o.color, 4);
                blip(240, 80, 'square', 0.05);
                b._cooldown = 0.08;
              }
            }
          } else if (o.kind === 'hammer') {
            const bx = o.cx + Math.cos(o.angle) * o.length;
            const by = o.cy + Math.sin(o.angle) * o.length;
            collideSegment(b, o.cx, o.cy, bx, by, o.thick / 2);
            if (collideCircle(b, bx, by, o.bobR)) {
              hit = true;
              const tx = -Math.sin(o.angle), ty = Math.cos(o.angle);
              const kick = o.omega * o.length * o.amp * 1.4;
              b.vx += tx * kick * 0.6;
              b.vy += ty * kick * 0.6;
              if (b._cooldown <= 0) {
                spark(b.x, b.y, o.color, 5);
                blip(140, 130, 'sawtooth', 0.09);
                b._cooldown = 0.12;
              }
            }
          } else if (o.kind === 'movingFloor') {
            // Horizontal floor at y=o.y with a moving gap. Collision is two
            // segments: 20..holeStart and holeEnd..W-20.
            const hc = W / 2 + o.amp * Math.sin(o.phase);
            const hs = hc - o.holeWidth / 2;
            const he = hc + o.holeWidth / 2;
            const leftEnd = Math.max(20, hs);
            const rightStart = Math.min(W - 20, he);
            const ht = o.floorThick / 2;
            const edgeGrace = b.r * 0.65;
            if (b.x + edgeGrace < hs) {
              if (collideSegment(b, 20, o.y, leftEnd, o.y, ht, 1.3)) {
                hit = true;
                if (b._cooldown <= 0) {
                  spark(b.x, b.y, o.color, 3);
                  blip(220, 80, 'sawtooth', 0.05);
                  b._cooldown = 0.08;
                }
              }
            } else if (b.x - edgeGrace > he) {
              if (collideSegment(b, rightStart, o.y, W - 20, o.y, ht, 1.3)) {
                hit = true;
                if (b._cooldown <= 0) {
                  spark(b.x, b.y, o.color, 3);
                  blip(220, 80, 'sawtooth', 0.05);
                  b._cooldown = 0.08;
                }
              }
            }
            // ball within hole range falls through, no collision
          } else if (o.kind === 'blackHole') {
            if (o.active > 0.01) {
              const dx = o.cx - b.x, dy = o.cy - b.y;
              const d2 = dx * dx + dy * dy;
              if (d2 < o.pullR * o.pullR && d2 > 1) {
                const d = Math.sqrt(d2);
                const falloff = 1 - d / o.pullR;
                const force = o.strength * o.active * falloff * falloff * dt;
                b.vx += (dx / d) * force;
                b.vy += (dy / d) * force;
              }
            }
          } else if (o.kind === 'breakPlatform') {
            if (!o.broken) {
              if (collideSegment(b, o.x1, o.y, o.x2, o.y, o.thick / 2, o.restitution)) {
                hit = true;
                o.broken = true;
                // Glass shatter VFX — wide shard burst
                const mx = (o.x1 + o.x2) / 2;
                for (let si = 0; si < 30; si++) {
                  const ang = (si / 30) * Math.PI * 2 + rand() * 0.4;
                  const spd = 2 + rand() * 5;
                  particles.push({
                    x: o.x1 + rand() * (o.x2 - o.x1), y: o.y,
                    vx: Math.cos(ang) * spd,
                    vy: Math.sin(ang) * spd - 3,
                    life: 0.5 + rand() * 0.6,
                    color: rand() > 0.5 ? '#aef4ff' : '#fff'
                  });
                }
                spark(mx, o.y, COLORS.finish, 10);
                if (particles.length > 120) particles.splice(0, particles.length - 120);
                // Layered crash sound: low thud + high shatter
                blip(80, 200, 'sawtooth', 0.3);
                blip(1200 + rand() * 800, 60, 'square', 0.15);
                blip(2400 + rand() * 600, 40, 'square', 0.1);
                screenShake = 0.3;
                const blastR = 80;
                const blastForce = -80;
                for (const ob of balls) {
                  const dy = ob.y - o.y;
                  const dx = ob.x - (o.x1 + o.x2) / 2;
                  const dist = Math.sqrt(dx * dx + dy * dy);
                  if (dist < blastR) {
                    const falloff = 1 - dist / blastR;
                    ob.vy = blastForce * falloff;
                    ob.vx += (rand() - 0.5) * 4;
                  }
                }
                b.vy = blastForce * 0.8;
              }
            }
          } else if (o.kind === 'bumper') {
            if (collideCircle(b, o.cx, o.cy, o.r, o.restitution)) {
              hit = true;
              o.hitT = 1;
              if (b._cooldown <= 0) {
                spark(b.x, b.y, '#fff0aa', 6);
                blip(520, 80, 'square', 0.09);
                b._cooldown = 0.06;
              }
            }
          }
        }
      }

      b._cooldown = Math.max(0, b._cooldown - 0.016 * dt);
      clampBallSpeed(b);

      // No multiplicative friction on contact — let the marble keep its
      // tangential speed so rolling on slopes actually accelerates instead
      // of decaying frame-by-frame.

      // Trail (sparse)
      b._trailT = (b._trailT || 0) + dt;
      if (b._trailT > 1.6) {
        b._trailT = 0;
        b.trail.push(b.x, b.y);
        if (b.trail.length > 18) b.trail.splice(0, 2);
      }

      // Finish?
      if (!b.finished && b.y >= FINISH_Y) {
        b.finished = true;
        b.finishedAt = raceElapsed;
        if (winner === null) {
          winner = b.label;
          winnerBall = b;
          finishFxStart = raceElapsed;
          // Margin = how far back is the SECOND-place marble (could be either team).
          let secondY = 0;
          for (const other of balls) {
            if (other === b) continue;
            if (other.y > secondY) secondY = other.y;
          }
          winnerMarginPx = Math.max(0, Math.round(FINISH_Y - secondY));
          mode = 'finishing';
          finishDelay = 10.0;      // let the pack keep falling before the result overlay
          banner.textContent = `${b.label.toUpperCase()} WINS`;
          chord(b.label === 'yes' ? [392, 494, 587, 784] : [330, 261, 196, 165], 480, 'sawtooth');
        }
      }
    }

    // Ball-ball soft contact for all pairs — with 10 marbles, cluster
    // dynamics matter and the trailing pack can shove the leader.
    for (let i = 0; i < balls.length; i++) {
      const a = balls[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < balls.length; j++) {
        const c = balls[j];
        if (!c.alive) continue;
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
          clampBallSpeed(a);
          clampBallSpeed(c);
        }
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
    if (exploring) {
      cameraY = exploreCamY;
      return;
    }
    let leadY = 0;
    if (winner && winnerBall) {
      leadY = winnerBall.y;
    } else {
      for (const b of balls) if (b.y > leadY) leadY = b.y;
    }
    cameraTargetY = leadY - H_VIEW * 0.42;
    if (cameraTargetY < 0) cameraTargetY = 0;
    if (cameraTargetY > WORLD_H - H_VIEW) cameraTargetY = WORLD_H - H_VIEW;
    const k = mode === 'finishing' ? 0.06 : 0.14;
    cameraY += (cameraTargetY - cameraY) * Math.min(1, k * dt);
  }

  // ───────────────────────────── Rendering
  function render() {
    // Background sweep
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H_VIEW);

    // Screen shake
    let shakeX = 0, shakeY = 0;
    if (screenShake > 0) {
      shakeX = (Math.random() - 0.5) * screenShake * 24;
      shakeY = (Math.random() - 0.5) * screenShake * 24;
      screenShake *= 0.85;
      if (screenShake < 0.01) screenShake = 0;
    }

    // Blit visible slice of static prerender
    const camY = Math.max(0, Math.min(WORLD_H - H_VIEW, Math.floor(cameraY)));
    ctx.save();
    ctx.translate(shakeX, shakeY);
    ctx.drawImage(
      staticCanvas,
      0, camY, W, H_VIEW,
      0, 0, W, H_VIEW
    );

    // World-coord draws
    ctx.translate(0, -camY);

    drawFinishGlow(camY);

    // Kinematic obstacles (only those visible)
    const yMin = camY - 40, yMax = camY + H_VIEW + 40;
    for (const o of kinObs) {
      const oy = o.cy != null ? o.cy : o.y;
      if (oy < yMin || oy > yMax) continue;
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

    drawWinnerAnnouncement(camY);

    ctx.restore();
  }

  function winnerColor() {
    return winner === 'yes' ? COLORS.yesBall : COLORS.noBall;
  }

  function finishFxAmount() {
    if (!winner || !finishFxStart) return 0;
    return Math.min(1, Math.max(0, (raceElapsed - finishFxStart) / 900));
  }

  function drawFinishGlow(camY) {
    if (!winner) return;
    const color = winnerColor();
    const amount = finishFxAmount();
    const pulse = 0.82 + 0.18 * Math.sin((raceElapsed - finishFxStart) * 0.012);
    const sy = FINISH_Y - camY;
    const glowY = Math.max(camY + 90, Math.min(camY + H_VIEW - 90, FINISH_Y - 48));

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = (0.035 + amount * 0.055) * pulse;
    ctx.fillStyle = color;
    ctx.fillRect(0, camY, W, H_VIEW);

    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = (0.07 + amount * 0.1) * pulse;
    const grad = ctx.createRadialGradient(W / 2, glowY, 30, W / 2, glowY, 430);
    grad.addColorStop(0, color);
    grad.addColorStop(0.42, color);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, camY, W, H_VIEW);

    if (sy > -140 && sy < H_VIEW + 220) {
      ctx.globalAlpha = 0.22 + amount * 0.28;
      ctx.shadowColor = color;
      ctx.shadowBlur = 10 + amount * 14;
      ctx.strokeStyle = color;
      ctx.lineWidth = 4 + amount * 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(46, FINISH_Y - 150);
      ctx.lineTo(46, FINISH_Y + 90);
      ctx.moveTo(W - 46, FINISH_Y - 150);
      ctx.lineTo(W - 46, FINISH_Y + 90);
      ctx.stroke();

      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 0.08 + amount * 0.08;
      ctx.fillStyle = color;
      ctx.fillRect(36, FINISH_Y - 116, W - 72, 180);
    }
    ctx.restore();
  }

  function drawWinnerAnnouncement(camY) {
    if (!winner) return;
    const amount = finishFxAmount();
    const color = winnerColor();
    const y = Math.min(FINISH_Y - 118, camY + H_VIEW - 160);

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 82px "Courier New", monospace';
    ctx.letterSpacing = '0px';
    ctx.globalAlpha = Math.min(0.96, amount * 1.3);
    ctx.shadowColor = color;
    ctx.shadowBlur = 12;
    ctx.lineWidth = 8;
    ctx.strokeStyle = 'rgba(2,3,10,0.78)';
    ctx.strokeText(winner.toUpperCase(), W / 2, y);
    ctx.fillStyle = color;
    ctx.fillText(winner.toUpperCase(), W / 2, y);

    ctx.font = 'bold 14px "Courier New", monospace';
    ctx.shadowBlur = 6;
    ctx.globalAlpha = Math.min(0.78, amount * 1.1);
    ctx.fillText('FIRST THROUGH THE FINISH', W / 2, y + 62);
    ctx.restore();
  }

  function drawKinematic(o) {
    if (o.kind === 'arm') {
      const ex = o.cx + Math.cos(o.angle) * o.length;
      const ey = o.cy + Math.sin(o.angle) * o.length;
      ctx.save();
      ctx.strokeStyle = o.color;
      ctx.lineWidth = o.thick;
      ctx.lineCap = 'round';
      ctx.shadowColor = o.color;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.moveTo(o.cx, o.cy); ctx.lineTo(ex, ey);
      ctx.stroke();
      ctx.restore();
    } else if (o.kind === 'wallFlipper') {
      const ex = o.cx + Math.cos(o.angle) * o.length;
      const ey = o.cy + Math.sin(o.angle) * o.length;
      ctx.save();
      // Tapered flipper — gradient along length
      const fg = ctx.createLinearGradient(o.cx, o.cy, ex, ey);
      fg.addColorStop(0, o.color);
      fg.addColorStop(1, o.color === COLORS.cyan ? 'rgba(51, 215, 255, 0.5)' : 'rgba(155, 124, 255, 0.5)');
      ctx.strokeStyle = fg;
      ctx.lineWidth = o.thick + o.active * 3;
      ctx.lineCap = 'round';
      ctx.shadowColor = o.color;
      ctx.shadowBlur = 8 + o.active * 14;
      ctx.beginPath();
      ctx.moveTo(o.cx, o.cy); ctx.lineTo(ex, ey);
      ctx.stroke();
      // Pivot — matching team color ring
      ctx.shadowBlur = 0;
      ctx.fillStyle = COLORS.bg;
      ctx.beginPath(); ctx.arc(o.cx, o.cy, 6, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = o.color; ctx.lineWidth = 2;
      ctx.shadowColor = o.color; ctx.shadowBlur = 6;
      ctx.beginPath(); ctx.arc(o.cx, o.cy, 6, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
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
      ctx.fillStyle = COLORS.bg;
      ctx.beginPath(); ctx.arc(o.cx, o.cy, 5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = COLORS.cyan; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(o.cx, o.cy, 5, 0, Math.PI * 2); ctx.stroke();
    } else if (o.kind === 'movingFloor') {
      const hc = W / 2 + o.amp * Math.sin(o.phase);
      const hs = hc - o.holeWidth / 2;
      const he = hc + o.holeWidth / 2;
      const leftEnd = Math.max(20, hs);
      const rightStart = Math.min(W - 20, he);
      ctx.strokeStyle = o.color;
      ctx.lineWidth = o.floorThick;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(20, o.y); ctx.lineTo(leftEnd, o.y);
      ctx.moveTo(rightStart, o.y); ctx.lineTo(W - 20, o.y);
      ctx.stroke();
      // Yellow accent at the hole edges so the gate is readable
      ctx.strokeStyle = COLORS.finish;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(hs, o.y - 11); ctx.lineTo(hs, o.y + 11);
      ctx.moveTo(he, o.y - 11); ctx.lineTo(he, o.y + 11);
      ctx.stroke();
    } else if (o.kind === 'blackHole') {
      ctx.save();
      const a = o.active;
      // Pull radius halo
      if (a > 0.01) {
        const grad = ctx.createRadialGradient(o.cx, o.cy, o.visR, o.cx, o.cy, o.pullR * a);
        grad.addColorStop(0, `rgba(155, 124, 255, ${0.12 * a})`);
        grad.addColorStop(1, 'rgba(155, 124, 255, 0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(o.cx, o.cy, o.pullR * a, 0, Math.PI * 2);
        ctx.fill();
      }
      // Core
      ctx.fillStyle = a > 0.01 ? `rgba(8, 4, 20, ${0.7 + 0.3 * a})` : 'rgba(8, 4, 20, 0.4)';
      ctx.beginPath();
      ctx.arc(o.cx, o.cy, o.visR, 0, Math.PI * 2);
      ctx.fill();
      // Ring
      ctx.strokeStyle = o.color;
      ctx.lineWidth = 2 + a * 2;
      ctx.globalAlpha = 0.3 + a * 0.7;
      ctx.shadowColor = o.color;
      ctx.shadowBlur = 4 + a * 14;
      ctx.beginPath();
      ctx.arc(o.cx, o.cy, o.visR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    } else if (o.kind === 'breakPlatform') {
      if (o.broken) return;
      ctx.save();
      // Glass shimmer gradient
      const gx1 = o.x1, gx2 = o.x2;
      const gg = ctx.createLinearGradient(gx1, o.y, gx2, o.y);
      gg.addColorStop(0, 'rgba(174, 244, 255, 0.3)');
      gg.addColorStop(0.3, 'rgba(220, 250, 255, 0.7)');
      gg.addColorStop(0.5, 'rgba(255, 255, 255, 0.85)');
      gg.addColorStop(0.7, 'rgba(220, 250, 255, 0.7)');
      gg.addColorStop(1, 'rgba(174, 244, 255, 0.3)');
      ctx.strokeStyle = gg;
      ctx.lineWidth = o.thick;
      ctx.lineCap = 'round';
      ctx.shadowColor = 'rgba(174, 244, 255, 0.6)';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.moveTo(o.x1, o.y);
      ctx.lineTo(o.x2, o.y);
      ctx.stroke();
      ctx.restore();
    } else if (o.kind === 'bumper') {
      ctx.save();
      const h = o.hitT || 0;
      const drawR = o.baseR + h * 6;
      const g = Math.round(216 + h * 39);
      const bl = Math.round(74 + h * 180);
      // Clip wall-hugging bumpers so only the inner half shows
      if (o.cx < 38) {
        ctx.beginPath();
        ctx.rect(38, o.cy - drawR - 30, W, drawR * 2 + 60);
        ctx.clip();
      } else if (o.cx > W - 38) {
        ctx.beginPath();
        ctx.rect(0, o.cy - drawR - 30, W - 38, drawR * 2 + 60);
        ctx.clip();
      }
      // Outer glow
      ctx.shadowColor = `rgb(255, ${g}, ${bl})`;
      ctx.shadowBlur = 8 + h * 20;
      // Radial gradient — bright highlight off-center for a 3D look
      const grad = ctx.createRadialGradient(
        o.cx - drawR * 0.25, o.cy - drawR * 0.25, drawR * 0.1,
        o.cx, o.cy, drawR
      );
      grad.addColorStop(0, `rgba(255, ${Math.min(255, g + 30)}, ${Math.min(255, bl + 60)}, 1)`);
      grad.addColorStop(0.7, `rgb(255, ${g}, ${bl})`);
      grad.addColorStop(1, `rgb(${Math.round(200 + h * 55)}, ${Math.round(160 + h * 40)}, ${Math.round(20 + h * 100)})`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(o.cx, o.cy, drawR, 0, Math.PI * 2);
      ctx.fill();
      // Thin bright rim
      ctx.shadowBlur = 0;
      ctx.strokeStyle = `rgba(255, ${Math.min(255, g + 20)}, ${Math.min(255, bl + 40)}, ${0.5 + h * 0.4})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawBall(b) {
    if (!b.alive) return;
    ctx.save();
    ctx.shadowColor = b.color;
    ctx.shadowBlur = 18;
    // Radial gradient for 3D sphere
    const bg = ctx.createRadialGradient(
      b.x - b.r * 0.3, b.y - b.r * 0.3, b.r * 0.05,
      b.x, b.y, b.r
    );
    bg.addColorStop(0, '#fff');
    bg.addColorStop(0.3, b.color);
    bg.addColorStop(1, b.label === 'yes' ? 'rgba(20, 100, 50, 0.9)' : 'rgba(120, 20, 30, 0.9)');
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    // Crisp rim
    ctx.strokeStyle = 'rgba(2,3,10,0.6)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // Team label
    ctx.fillStyle = COLORS.bg;
    ctx.font = 'bold 9px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(b.label === 'yes' ? 'YES' : 'NO', b.x, b.y + 1);
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
      let leader = null;
      for (const b of balls) {
        if (!b.alive || b.finished) continue;
        if (!leader || b.y > leader.y) leader = b;
      }
      leadLabel = leader ? leader.label : null;
    }
    scoreYes.classList.toggle('lead', leadLabel === 'yes');
    scoreNo.classList.toggle('lead',  leadLabel === 'no');
  }

  // ───────────────────────────── Lifecycle
  function clampYesBallCount(value) {
    const n = Number.isFinite(value) ? Math.round(value) : DEFAULT_YES_BALLS;
    return Math.max(1, Math.min(TOTAL_BALLS - 1, n));
  }

  function updateWeightUI() {
    yesBallCount = clampYesBallCount(yesBallCount);
    const noBallCount = TOTAL_BALLS - yesBallCount;
    if (weightSlider) {
      weightSlider.value = String(yesBallCount);
      weightSlider.setAttribute('aria-valuetext', `YES ${yesBallCount}, NO ${noBallCount}`);
    }
    if (weightText) weightText.textContent = `YES ${yesBallCount} / NO ${noBallCount}`;
  }

  function spawnBalls() {
    balls = [];
    // One seeded-random horizontal lineup across the top. Slots prevent
    // instant overlap; shuffled team order and jitter make starts vary.
    const lineup = [];
    const yesCount = clampYesBallCount(yesBallCount);
    const noCount = TOTAL_BALLS - yesCount;
    for (let i = 0; i < yesCount; i++) lineup.push('yes');
    for (let i = 0; i < noCount; i++) lineup.push('no');
    for (let i = lineup.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = lineup[i]; lineup[i] = lineup[j]; lineup[j] = tmp;
    }

    const xStart = W * 0.12;
    const xEnd   = W * 0.88;
    const yy = 54;
    for (let i = 0; i < lineup.length; i++) {
      const label = lineup[i];
      const x0 = xStart + (xEnd - xStart) * (i / (lineup.length - 1));
      balls.push({
        label,
        color: label === 'yes' ? COLORS.yesBall : COLORS.noBall,
        x: x0 + rrange(-10, 10),
        y: yy + rrange(-4, 4),
        vx: rrange(-0.35, 0.35),
        vy: 0,
        r: BALL_R,
        alive: true,
        finished: false,
        trail: [],
        _cooldown: 0
      });
    }
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
    winnerBall = null;
    winnerMarginPx = 0;
    finishFxStart = 0;
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
    const finishMs = winnerBall && Number.isFinite(winnerBall.finishedAt) ? winnerBall.finishedAt : raceElapsed;
    const secs = (finishMs / 1000).toFixed(1);
    const margin = winnerMarginPx;
    const marginLabel = margin <= 6 ? 'PHOTO FINISH' : `FIRST BY ${margin} PX`;
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
      const wRaw = u.searchParams.get('w');
      const seed = seedRaw ? (parseInt(seedRaw, 16) >>> 0) : null;
      const weight = wRaw ? clampYesBallCount(parseInt(wRaw, 10)) : DEFAULT_YES_BALLS;
      return { seed, q, weight };
    } catch (e) { return { seed: null, q: '', weight: DEFAULT_YES_BALLS }; }
  }
  function writeUrlState() {
    try {
      const u = new URL(window.location.href);
      u.searchParams.set('seed', currentSeed.toString(16));
      const q = (qInput.value || '').trim();
      if (q) u.searchParams.set('q', q); else u.searchParams.delete('q');
      if (yesBallCount !== DEFAULT_YES_BALLS) u.searchParams.set('w', String(yesBallCount));
      else u.searchParams.delete('w');
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
  settingsToggle.addEventListener('click', () => {
    const open = settingsPanel.classList.contains('hidden');
    settingsPanel.classList.toggle('hidden', !open);
    settingsToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  weightSlider.addEventListener('input', () => {
    yesBallCount = clampYesBallCount(parseInt(weightSlider.value, 10));
    updateWeightUI();
  });
  againBtn.addEventListener('click', () => {
    mode = 'idle';
    winner = null;
    winnerBall = null;
    finishFxStart = 0;
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

  // ───────────────────────────── Explore mode
  function enterExplore() {
    exploring = true;
    exploreCamY = cameraY;
    if (mode === 'idle') menu.classList.add('hidden');
    exploreBtn.setAttribute('aria-pressed', 'true');
  }
  function exitExplore() {
    exploring = false;
    dragStartY = null;
    if (mode === 'idle') {
      cameraY = 0;
      cameraTargetY = 0;
      menu.classList.remove('hidden');
    }
    exploreBtn.setAttribute('aria-pressed', 'false');
  }
  function clampExploreCam() {
    if (exploreCamY < 0) exploreCamY = 0;
    if (exploreCamY > WORLD_H - H_VIEW) exploreCamY = WORLD_H - H_VIEW;
  }
  exploreBtn.addEventListener('click', () => {
    if (exploring) { exitExplore(); return; }
    enterExplore();
  });
  canvas.addEventListener('pointerdown', (e) => {
    if (!exploring) return;
    dragStartY = e.clientY;
    dragCamStart = exploreCamY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!exploring || dragStartY == null) return;
    const rect = canvas.getBoundingClientRect();
    const scale = WORLD_H / rect.height * (H_VIEW / WORLD_H);
    exploreCamY = dragCamStart - (e.clientY - dragStartY) * (WORLD_H / rect.height);
    clampExploreCam();
  });
  canvas.addEventListener('pointerup', () => { dragStartY = null; });
  canvas.addEventListener('pointercancel', () => { dragStartY = null; });
  canvas.addEventListener('wheel', (e) => {
    if (!exploring) return;
    e.preventDefault();
    exploreCamY += e.deltaY * 2;
    clampExploreCam();
  }, { passive: false });

  window.addEventListener('keydown', (e) => {
    const inField = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
    if (inField) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (exploring) {
        exitExplore();
      } else if (mode === 'racing' || mode === 'finishing' || mode === 'done') {
        mode = 'idle';
        winner = null;
        winnerBall = null;
        finishFxStart = 0;
        balls = [];
        particles = [];
        result.classList.add('hidden');
        hud.classList.add('hidden');
        menu.classList.remove('hidden');
        qInput.focus();
      }
    } else if (e.key === 'v' || e.key === 'V') {
      e.preventDefault();
      exploreBtn.click();
    } else if (e.key === ' ' || e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      if (mode === 'idle')      flipBtn.click();
      else if (mode === 'done') { againBtn.click(); setTimeout(() => flipBtn.click(), 50); }
    } else if (e.key === 'm' || e.key === 'M') {
      muteBtn.click();
    }
  });

  // ───────────────────────────── Boot
  (() => {
    const { seed, q, weight } = parseUrl();
    if (q && !qInput.value) qInput.value = q;
    yesBallCount = weight;
    updateWeightUI();
    if (seed != null) pendingSeed = seed;
    // Bake an idle backdrop so the menu has something nice behind it
    buildCourse((Math.random() * 0xffffffff) >>> 0);
    prerenderStatic();
    cameraY = 0;
    lastT = performance.now();
    scheduleNext(loop);
  })();
})();
