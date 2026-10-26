/* 主循环：1280×720 逻辑分辨率 + DPR/letterbox；状态机与 1/120 固定步长推进比赛 */
(function () {
  'use strict';

  var W = 1280, H = 720;
  var STEP = 1 / 120;      // 固定物理步长（秒）
  var MAX_STEPS = 6;       // 单帧最多补 6 步，避免卡顿后雪崩
  var BEST_KEY = 'slotrace.best';
  var FALLBACK = '#C98B55';
  var DEFAULT_LAPS = 3;    // 默认圈数（无头截图可用 ?laps=N 覆盖）
  var MAX_FF_STEPS = 72000; // ?ff 快进上限（600 秒），防止参数异常卡死

  var canvas = document.getElementById('game');
  // HUD 画在独立的 2D 叠加层上，3D 场景由 RaceGL 画在 #game
  var hudCanvas = document.getElementById('hud');
  var hudCtx = hudCanvas ? hudCanvas.getContext('2d') : null;
  var dpr = 1, scaleX = 1, scaleY = 1;
  var track = null, scene = null, input = null, audio = null, gl = null;
  var phase = 'title', race = null, time = 0, best = null;
  var pausedFrom = null, acc = 0, last = 0, warmed = false;
  var freeze = false;   // ?freeze=1：快进后冻结比赛推进，只保留渲染与 rAF

  // 历史最佳圈存为整数毫秒
  function readBest() {
    try {
      var raw = window.localStorage.getItem(BEST_KEY);
      var ms = raw === null ? NaN : parseInt(raw, 10);
      return isFinite(ms) && ms >= 0 ? ms : null;
    } catch (err) { return null; }
  }

  function saveBest(ms) {
    try { window.localStorage.setItem(BEST_KEY, String(ms)); } catch (err) { /* 隐私模式静默 */ }
  }

  function toMs(sec) {
    var ms = Math.round(Number(sec) * 1000);
    return isFinite(ms) && ms >= 0 ? ms : 0;
  }

  // 读 URL 里的单个数值参数；缺失/非法返回 null
  function readNumParam(name) {
    var search = window.location.search || '';
    var m = new RegExp('(?:\\?|&)' + name + '=([^&]*)').exec(search);
    if (!m) return null;
    var raw = m[1];
    try { raw = decodeURIComponent(raw); } catch (err) { /* 保留原文 */ }
    if (raw === '') return null;
    var n = Number(raw);
    return isFinite(n) ? n : null;
  }

  // ?laps=N：圈数取整，非法或小于 1 回落默认 3
  function readLaps() {
    var n = readNumParam('laps');
    if (n === null || n < 1) return DEFAULT_LAPS;
    return Math.floor(n);
  }

  // 各模块降级初始化：缺哪个都不阻塞其余部分
  function init() {
    try { track = window.RaceTrack ? window.RaceTrack.createTrack() : null; } catch (err) { track = null; }
    try {
      var built = window.RaceScene && track ? window.RaceScene.build(track) : null;
      scene = built && built.canvas ? built.canvas : null;
    } catch (err) { scene = null; }
    try { input = window.RaceInput ? window.RaceInput.createInput() : null; } catch (err) { input = null; }
    try { audio = window.RaceAudio ? window.RaceAudio.createAudio() : null; } catch (err) { audio = null; }
    // 3D 渲染器：缺 three.js / WebGL 不可用时留空，draw() 回落 2D
    try { gl = (window.RaceGL && canvas) ? window.RaceGL.create(canvas, track) : null; } catch (err) { gl = null; }
    if (window.RaceGLCars && gl) window.RaceGLCars.attach(gl, track);
    // 脱轨飞行接上 cannon 刚体（缺任一模块时保留内置抛体）
    if (window.RaceFlightPhysics && window.RaceCar && window.RaceCar.setFlightHooks) { window.RaceCar.setFlightHooks(window.RaceFlightPhysics.create()); }
    best = readBest();
  }

  // 开局：两辆车各入一条槽，圈数由 ?laps=N 决定（默认 3）
  function startRace() {
    if (!window.RaceRace || !window.RaceCar || !track) return;
    race = window.RaceRace.createRace({
      track: track,
      cars: [
        window.RaceCar.createCar({ lane: 1, name: 'P1' }),
        window.RaceCar.createCar({ lane: -1, name: 'P2' })
      ],
      laps: readLaps()
    });
    phase = 'countdown';
    pausedFrom = null;
    acc = 0;
  }

  // Enter 开始 / R 重开 / P 暂停 / M 静音 / Esc 回标题
  function handleInput() {
    if (!input) return;
    if (input.consume('start') && (phase === 'title' || phase === 'finished')) startRace();
    if (input.consume('restart')) startRace();
    if (input.consume('mute') && audio) audio.setMuted(!audio.isMuted());
    if (input.consume('back')) { phase = 'title'; race = null; acc = 0; }
    if (input.consume('pause')) {
      if (phase === 'paused') { phase = pausedFrom || 'running'; pausedFrom = null; }
      else if (phase === 'countdown' || phase === 'running') { pausedFrom = phase; phase = 'paused'; }
    }
  }

  // 完赛：切阶段、礼花音、记录冠军最佳圈
  function onFinished() {
    phase = 'finished';
    pausedFrom = null;
    if (audio) audio.fanfare();
    var win = race ? race.winner : null;
    var lap = win && win.bestLap !== null ? win.bestLap : null;
    if (lap === null) return;
    var ms = toMs(lap);
    if (best === null || ms < best) { best = ms; saveBest(ms); }
  }

  // 每车圈数与脱轨次数快照，用于比对事件
  function lapSnapshot() {
    var list = [], entries = race && race.entries ? race.entries : [];
    for (var i = 0; i < entries.length; i++) {
      list.push({ lap: entries[i].lap, derails: entries[i].car ? entries[i].car.totalDerails : 0 });
    }
    return list;
  }

  // 过圈 chime、甩出 boom：一帧内多圈只响一次
  function emitEvents(before) {
    if (!audio || !race || !race.entries) return;
    for (var i = 0; i < race.entries.length && i < before.length; i++) {
      var entry = race.entries[i], car = entry.car;
      if (entry.lap > before[i].lap) audio.chime();
      if (car && car.totalDerails > before[i].derails) audio.boom();
    }
  }

  // 引擎音：速度比例 = speed / 400
  function engineSounds() {
    if (!audio || !race || !race.entries) return;
    for (var i = 0; i < 2 && i < race.entries.length; i++) {
      var car = race.entries[i].car;
      audio.engine(i, car ? car.speed / 400 : 0);
    }
  }

  // 固定步长推进，仅 countdown / running 调用
  function step(dt) {
    if (!race || !window.RaceRace) return;
    if (freeze) return;   // ?freeze=1：跳过 RaceRace.update，race 状态保持快进结果不动
    acc += dt;
    var steps = 0;
    while (acc >= STEP && steps < MAX_STEPS) {
      var before = lapSnapshot();
      window.RaceRace.update(race, STEP, [input ? input.get(0) : 0, input ? input.get(1) : 0]);
      acc -= STEP;
      steps += 1;
      emitEvents(before);
      if (race.phase === 'finished') break;
    }
    if (steps >= MAX_STEPS) acc = 0;   // 掉帧过多时丢弃余量，防止追赶抖动
    if (phase === 'countdown' && race.phase === 'running') phase = 'running';
    if (race.phase === 'finished') onFinished();
  }

  // ?ff=S：同步快进 S 秒比赛时间（S×120 步 1/120 推进），完赛即停在结算画面
  function fastForward(sec) {
    if (!race || !window.RaceRace || typeof window.RaceRace.update !== 'function') return 0;
    // ff 计的是比赛时间：跳过 3.2 秒倒计时，直接进入 running（无头截图等不起倒计时）
    if (race.phase === 'countdown') {
      race.t = race.countdown;
      race.phase = 'running';
      race.elapsed = 0;
      for (var j = 0; j < race.entries.length; j++) race.entries[j].lapStart = 0;
      phase = 'running';
    }
    var steps = Math.round(Number(sec) * 120);
    if (!isFinite(steps) || steps <= 0) steps = 0;
    if (steps > MAX_FF_STEPS) steps = MAX_FF_STEPS;
    var done = 0;
    for (var i = 0; i < steps; i++) {
      window.RaceRace.update(race, STEP, [1, 1]);
      done += 1;
      if (race.phase === 'finished') break;
    }
    time += done * STEP;
    acc = 0;
    if (race.phase === 'finished') onFinished();
    else if (race.phase === 'running') phase = 'running';
    return done;
  }

  // 帧入口：计时、输入、按阶段推进
  function tick(now) {
    var dt = (now - last) / 1000;
    last = now;
    if (!(dt > 0)) dt = 0;
    if (dt > 0.05) dt = 0.05;
    handleInput();
    if (phase === 'paused') { acc = 0; return; }
    time += dt;
    if (phase === 'countdown' || phase === 'running') step(dt);
    engineSounds();
  }

  // 逻辑坐标 → 设备像素；16:9 内接 CSS 尺寸，#game 与 #hud 同步（居中交给 CSS 的 fixed + translate）
  function resize() {
    if (!canvas && !hudCanvas) return;
    var winW = window.innerWidth || W, winH = window.innerHeight || H;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    var pixelW = Math.round(W * dpr), pixelH = Math.round(H * dpr);
    var scale = Math.min(winW / W, winH / H);
    if (!(scale > 0)) scale = 1;
    var cssW = Math.round(W * scale) + 'px', cssH = Math.round(H * scale) + 'px';

    if (canvas) {
      canvas.width = pixelW;
      canvas.height = pixelH;
      canvas.style.width = cssW;
      canvas.style.height = cssH;
    }
    if (hudCanvas) {
      hudCanvas.width = pixelW;
      hudCanvas.height = pixelH;
      hudCanvas.style.width = cssW;
      hudCanvas.style.height = cssH;
    }
    scaleX = pixelW / W;
    scaleY = pixelH / H;

    // 让 WebGL 的视口/宽高比跟上 CSS 尺寸
    if (gl && typeof gl.resize === 'function') {
      try { gl.resize(); } catch (err) { /* 渲染器 resize 失败不影响 HUD */ }
    }
  }

  // 当前帧的渲染快照（3D 与 2D 兜底、HUD 共用同一份状态）
  function snapshot() {
    return {
      track: track, scene: scene, phase: phase, time: time,
      countdownT: race ? race.countdown - race.t : 0,
      race: race, best: best, particles: []
    };
  }

  // HUD 叠加层：先透明清屏，再按阶段画标题或 HUD
  function drawHUD(state) {
    if (!hudCtx) return;
    hudCtx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
    hudCtx.clearRect(0, 0, W, H);
    if (!window.RaceRender) return;
    if (state.phase === 'title') {
      if (typeof window.RaceRender.drawTitle === 'function') window.RaceRender.drawTitle(hudCtx, state);
    } else if (typeof window.RaceRender.drawHUD === 'function') {
      window.RaceRender.drawHUD(hudCtx, state);
    }
  }

  function draw() {
    var state = snapshot();

    if (gl && typeof gl.render === 'function') {
      try {
        gl.render(race, time);
        drawHUD(state);
        return;
      } catch (err) {
        gl = null;   // 3D 画不出来就整体回落 2D，避免黑屏
      }
    }

    // 2D 兜底：原 RaceRender.draw 整帧（底图 + 车 + HUD）画到叠加层上
    if (!hudCtx) return;
    hudCtx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
    hudCtx.fillStyle = FALLBACK;
    hudCtx.fillRect(0, 0, W, H);
    if (!window.RaceRender || typeof window.RaceRender.draw !== 'function') {
      hudCtx.fillStyle = '#FFFFFF';
      hudCtx.font = 'bold 28px monospace';
      hudCtx.textAlign = 'left';
      hudCtx.textBaseline = 'top';
      hudCtx.fillText('缺少 render.js', 24, 24);
      return;
    }
    window.RaceRender.draw(hudCtx, state);
  }

  function frame(now) {
    tick(now);
    draw();
    window.requestAnimationFrame(frame);
  }

  // 首次按键/点击解锁 AudioContext（autoplay 策略）
  function warmAudio() {
    if (warmed) return;
    warmed = true;
    if (audio && typeof audio.resume === 'function') audio.resume();
  }

  // 自检：无输入跑 75 秒（9000 × 1/120s），验证完赛、圈时与脱轨计数（?selftest=1）
  // 脱轨加长后 3 圈全油门约 57 秒，50 秒会误判 FAIL，故留到 75 秒
  function runSelftest() {
    var errs = [];
    window.onerror = function (msg, src, line, col, err) {
      var detail = err && err.message ? err.message : msg;
      errs.push(String(detail) + ' @' + String(src) + ':' + String(line));
      return false;
    };
    var result = { ok: false, phase: null, winnerLaps: null, bestLap: null, derails: 0, errs: errs };
    try {
      if (!window.RaceTrack || !window.RaceCar || !window.RaceRace) {
        throw new Error('缺少 track/car/race 模块');
      }
      var stTrack = window.RaceTrack.createTrack();
      var stRace = window.RaceRace.createRace({
        track: stTrack,
        cars: [
          window.RaceCar.createCar({ lane: 1, name: 'P1' }),
          window.RaceCar.createCar({ lane: -1, name: 'P2' })
        ],
        laps: 3
      });
      var stCar = stRace.entries[0].car;
      var derails = 0;
      for (var i = 0; i < 9000; i++) {
        window.RaceRace.update(stRace, 1 / 120, [1, 0.8]);
        if (stCar.justDerailed) {
          derails += 1;
          stCar.justDerailed = false;   // 读到即消费，避免同一标记重复计数
        }
      }
      result.phase = stRace.phase;
      result.winnerLaps = stRace.winner ? stRace.winner.lapTimes.length : null;
      result.bestLap = stRace.winner ? stRace.winner.bestLap : null;
      result.derails = derails;
      result.ok = stRace.phase === 'finished' && !!stRace.winner &&
        stRace.winner.lapTimes.length === 3 && derails >= 1 && errs.length === 0;
    } catch (err) {
      result.ok = false;
      errs.push('EXCEPTION: ' + String(err && err.message ? err.message : err));
    }
    var out = document.getElementById('selftest');
    if (out) {
      out.hidden = false;
      out.textContent = JSON.stringify(result);
    }
    document.title = result.ok ? 'SELFTEST PASS' : 'SELFTEST FAIL';
    window.__SELFTEST__ = result;
    return result;
  }

  window.addEventListener('keydown', warmAudio, false);
  window.addEventListener('pointerdown', warmAudio, false);
  window.addEventListener('resize', resize, false);

  init();
  resize();

  var search = window.location.search || '';
  // 自检模式：只跑离屏模拟，不启动 rAF 主循环，也不自动 startRace
  if (/(?:\?|&)selftest=1(?:&|$)/.test(search)) {
    runSelftest();
    return;
  }

  var ffSec = readNumParam('ff');

  if (ffSec !== null && ffSec > 0) {
    // 无头截图：浏览器虚拟时钟不推进 rAF，先同步跑完 ff 秒再接管 rAF
    startRace();
    fastForward(ffSec);
    // freeze=1 只在配合 ff 时生效：快进到位后冻结，便于截取脱轨瞬间
    if (/(?:\?|&)freeze=1(?:&|$)/.test(search)) freeze = true;
    last = window.performance && window.performance.now ? window.performance.now() : Date.now();
    draw();                       // 立即出一帧，快进结果不依赖 rAF
    window.requestAnimationFrame(frame);
    return;
  }

  if (/(?:\?|&)demo=1(?:&|$)/.test(search)) startRace();

  last = window.performance && window.performance.now ? window.performance.now() : Date.now();
  window.requestAnimationFrame(frame);
})();
