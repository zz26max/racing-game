/* 主循环：1280×720 逻辑分辨率 + DPR/letterbox；状态机与 1/120 固定步长推进比赛 */
(function () {
  'use strict';

  var W = 1280, H = 720;
  var STEP = 1 / 120;      // 固定物理步长（秒）
  var MAX_STEPS = 6;       // 单帧最多补 6 步，避免卡顿后雪崩
  var BEST_KEY = 'slotrace.best';
  var MUTE_KEY = 'slotrace.muted';  // 静音状态持久化（'1' 静音 / '0' 有声）
  var TRACK_KEY = 'slotrace.track';   // 标题界面选择的赛道（localStorage 持久化）
  var FALLBACK = '#C98B55';
  var DEFAULT_LAPS = 3;    // 默认圈数（无头截图可用 ?laps=N 覆盖）
  var MAX_FF_STEPS = 72000; // ?ff 快进上限（600 秒），防止参数异常卡死

  var canvas = document.getElementById('game');
  // HUD 画在独立的 2D 叠加层上，3D 场景由 RaceGL 画在 #game
  var hudCanvas = document.getElementById('hud');
  var hudCtx = hudCanvas ? hudCanvas.getContext('2d') : null;
  var dpr = 1, scaleX = 1, scaleY = 1;
  var track = null, scene = null, input = null, audio = null, gl = null;
  var trackId = 'figure8';              // 当前赛道 id
  var trackList = [];                   // 可选赛道元信息（id/name/desc）
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

  // 读赛道 id：URL ?track= 优先，其次 localStorage；未注册的 id 回落默认
  function readTrackId() {
    var search = window.location.search || '';
    var m = new RegExp('(?:\\?|&)track=([^&]*)').exec(search);
    if (m) {
      try { return decodeURIComponent(m[1]); } catch (err) { return m[1]; }
    }
    try {
      var saved = window.localStorage.getItem(TRACK_KEY);
      if (saved) return saved;
    } catch (err) { /* 隐私模式静默 */ }
    return null;
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
    // 画布可聚焦：键盘事件落在宿主 iframe 内时也能收到（点击画布时 onPointerDown 会主动 focus）
    if (canvas && canvas.setAttribute) canvas.setAttribute('tabindex', '0');
    if (hudCanvas && hudCanvas.setAttribute) hudCanvas.setAttribute('tabindex', '0');
    if (window.RaceTrack && typeof window.RaceTrack.listTracks === 'function') {
      trackList = window.RaceTrack.listTracks();
      var saved = readTrackId();
      for (var i = 0; i < trackList.length; i++) {
        if (trackList[i].id === saved) { trackId = saved; break; }
      }
    }
    try { track = window.RaceTrack ? window.RaceTrack.createTrack(trackId) : null; } catch (err) { track = null; trackId = 'figure8'; }
    try {
      var built = window.RaceScene && track ? window.RaceScene.build(track) : null;
      scene = built && built.canvas ? built.canvas : null;
    } catch (err) { scene = null; }
    try { input = window.RaceInput ? window.RaceInput.createInput() : null; } catch (err) { input = null; }
    try { audio = window.RaceAudio ? window.RaceAudio.createAudio() : null; } catch (err) { audio = null; }
    // 恢复上次的静音选择（M 键 / 屏上喇叭写入 localStorage）
    try {
      if (audio && window.localStorage && window.localStorage.getItem(MUTE_KEY) === '1') audio.setMuted(true);
    } catch (errM) { /* 隐私模式静默 */ }
    // 3D 渲染器：缺 three.js / WebGL 不可用时留空，draw() 回落 2D。
    // 失败原因必须留下痕迹——静默回落会表现成「画面正常但完全不对」（曾因一处 ReferenceError 整局掉进 2D 路径）
    try {
      gl = (window.RaceGL && canvas) ? window.RaceGL.create(canvas, track) : null;
    } catch (err) {
      gl = null;
      var DBG0 = window.__DBG__ || (window.__DBG__ = {});
      DBG0.glError = 'RaceGL.create: ' + (err && err.message ? err.message : String(err));
      if (window.console && console.error) console.error('[RaceGL] 3D 初始化失败，回落到 2D：', err);
    }
    if (window.RaceGLCars && gl) window.RaceGLCars.attach(gl, track);
    // 脱轨飞行接上 cannon 刚体（缺任一模块时保留内置抛体）
    if (window.RaceFlightPhysics && window.RaceCar && window.RaceCar.setFlightHooks) { window.RaceCar.setFlightHooks(window.RaceFlightPhysics.create()); }
    best = readBest();
  }

  // 开局：两辆车各入一条槽，圈数由 ?laps=N 决定（默认 3）
  function startRace() {
    releaseAllPointers();
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
    cdSound = -1;            // 倒计时发声档复位（-1 = 还没响过）
  }

  // 倒计时声音：3/2/1 各一声低 beep，进 GO 段一声高 beep（与画面数字同一阈值 COUNTDOWN_GO）
  var cdSound = -1;
  var COUNTDOWN_GO = 0.8;
  function countdownSounds() {
    if (phase !== 'countdown' || !race || !audio) return;
    var rem = race.countdown - race.t;
    var stage = rem > COUNTDOWN_GO ? Math.ceil(rem - COUNTDOWN_GO) : 0;
    if (stage === cdSound) return;
    cdSound = stage;
    audio.beep(stage > 0 ? 440 : 990);
  }

  // 标题界面切换赛道：重建赛道、2D 底图与 3D 场景（车模/灯光保留）
  // 先建后提交：createTrack 失败时 trackId/track/localStorage 一个都不动。
  // 旧写法先写 trackId 再连，抛错后会出现「trackId 已是新赛道、track 还是旧的」半更新，
  // 标题便永久显示旧赛道名——所以改成建成功才提交状态。
  function switchTrack(dir) {
    var DBG = window.__DBG__ || (window.__DBG__ = {});
    DBG.calls = (DBG.calls || 0) + 1;
    DBG.lastDir = dir;
    if (!window.RaceTrack || trackList.length < 2) { DBG.guarded = 'no-tracklist:' + trackList.length; return; }
    DBG.guarded = '';
    var idx = 0;
    for (var i = 0; i < trackList.length; i++) {
      if (trackList[i].id === trackId) { idx = i; break; }
    }
    idx = (idx + dir + trackList.length) % trackList.length;
    var nextId = trackList[idx].id;
    var nextTrack = null;
    try { nextTrack = window.RaceTrack.createTrack(nextId); } catch (err) { DBG.err = 'createTrack(' + nextId + '): ' + (err && err.message); return; }
    if (!nextTrack) { DBG.err = 'createTrack(' + nextId + '): 返回空'; return; }
    // 创建成功后才提交状态
    trackId = nextId;
    track = nextTrack;
    try { window.localStorage.setItem(TRACK_KEY, trackId); } catch (err) { /* 隐私模式静默 */ }
    try {
      var built = window.RaceScene && window.RaceScene.build ? window.RaceScene.build(track) : null;
      scene = built && built.canvas ? built.canvas : null;
    } catch (err2) { scene = null; DBG.err = 'scene.build: ' + (err2 && err2.message); }
    if (gl && typeof gl.setTrack === 'function') {
      try { gl.setTrack(track); } catch (err3) { gl = null; DBG.err = 'gl.setTrack: ' + (err3 && err3.message); }   // 3D 重建失败整体回落 2D
    }
    if (audio && typeof audio.resume === 'function') audio.resume();
  }

  // ---- 屏上按钮（桌游纸卡芯片）----
  var pressedPointers = Object.create(null);  // pointerId → 按住的按钮 id（按下高亮用）
  var portraitHintDismissed = false;          // 竖屏遮罩「点按继续」后本会话内不再弹

  // 按下集合归并去重，供 render 高亮芯片
  function pressedUIList() {
    var out = [];
    for (var k in pressedPointers) {
      var v = pressedPointers[k];
      if (out.indexOf(v) < 0) out.push(v);
    }
    return out;
  }

  // 屏上按钮动作：键盘快捷键与触摸按钮共用同一条路径
  function togglePause() {
    if (phase === 'paused') { phase = pausedFrom || 'running'; pausedFrom = null; }
    else if (phase === 'countdown' || phase === 'running') { pausedFrom = phase; phase = 'paused'; }
  }

  function backToTitle() {
    phase = 'title';
    race = null;
    acc = 0;
    portraitHintDismissed = false;
    releaseAllPointers();
  }

  function toggleMute() {
    if (!audio) return;
    var next = !audio.isMuted();
    audio.setMuted(next);
    try { window.localStorage.setItem(MUTE_KEY, next ? '1' : '0'); } catch (err) { /* 隐私模式静默 */ }
  }

  function runUIAction(id) {
    if (id === 'pause' || id === 'resume') togglePause();
    else if (id === 'start') { if (phase === 'title' || phase === 'finished') startRace(); }
    else if (id === 'restart' || id === 'again') startRace();
    else if (id === 'back') backToTitle();
    else if (id === 'mute') toggleMute();
    else if (id === 'portraitDismiss') portraitHintDismissed = true;
    var D = window.__DBG__ || (window.__DBG__ = {});
    D.ui = id;
  }

  // ---- 移动端：左右半屏油门 ----
  var activePointers = Object.create(null);   // pointerId → 0（左半屏）| 1（右半屏）
  var touchHeld = [false, false];             // 左右半屏当前是否被按住

  function zoneOfClientX(x) {
    var w = (window.innerWidth || W);
    return (Number(x) < w / 2) ? 0 : 1;
  }

  function setZoneHeld(zone, on) {
    if (zone !== 0 && zone !== 1) return;
    touchHeld[zone] = !!on;
    if (input && typeof input.setTouch === 'function') input.setTouch(zone, on);
    var D = window.__DBG__ || (window.__DBG__ = {});
    D.zones = [touchHeld[0] ? 1 : 0, touchHeld[1] ? 1 : 0];
  }

  function zoneStillHeld(zone) {
    for (var k in activePointers) { if (activePointers[k] === zone) return true; }
    return false;
  }

  function releasePointer(id) {
    delete pressedPointers[id];
    var z = activePointers[id];
    if (z === undefined) return;
    delete activePointers[id];
    if (!zoneStillHeld(z)) setZoneHeld(z, false);
  }

  function releaseAllPointers() {
    activePointers = Object.create(null);
    setZoneHeld(0, false);
    setZoneHeld(1, false);
  }

  // 指针事件坐标 → 1280×720 逻辑坐标（画布 CSS 尺寸等比缩放到逻辑分辨率）
  function toLogical(e) {
    var cx = e && isFinite(e.clientX) ? Number(e.clientX) : 0;
    var cy = e && isFinite(e.clientY) ? Number(e.clientY) : 0;
    var rect = null;
    try {
      rect = (hudCanvas && hudCanvas.getBoundingClientRect) ? hudCanvas.getBoundingClientRect() : null;
    } catch (err) { rect = null; }
    var w = rect && rect.width ? rect.width : 1;    // 宽高为 0 时回退 1，避免除零
    var h = rect && rect.height ? rect.height : 1;
    var left = rect && isFinite(rect.left) ? Number(rect.left) : 0;
    var top = rect && isFinite(rect.top) ? Number(rect.top) : 0;
    return { x: (cx - left) * W / w, y: (cy - top) * H / h };
  }

  // 页面按下（window 捕获阶段）：聚焦画布 + 标题界面切赛道
  // 命中顺序：先箭头精确框，再整行半平面回退（箭头框外、整行的左/右半边也能切）
  function onPointerDown(e) {
    try { if (hudCanvas && hudCanvas.focus) hudCanvas.focus(); } catch (err) { /* 忽略 */ }

    // 屏上按钮最先消费：比赛里点芯片不能变成半屏油门，标题里点喇叭不能开赛
    var R = window.RaceRender;
    var uiHit = null;
    if (R && typeof R.hitTestUI === 'function') {
      var lp = toLogical(e);
      try { uiHit = R.hitTestUI(lp.x, lp.y); } catch (err0) { uiHit = null; }
    }
    if (uiHit) {
      var pid = (e && e.pointerId !== undefined) ? e.pointerId : 'p';
      pressedPointers[pid] = uiHit;
      if (audio) audio.click();
      runUIAction(uiHit);
      if (e && e.preventDefault) e.preventDefault();
      return;
    }

    // 比赛中：按住左右半屏 = 对应玩家的油门（多点触控各自跟踪，第二根手指也算）
    if (phase === 'countdown' || phase === 'running') {
      var id = (e && e.pointerId !== undefined) ? e.pointerId : 'p';
      var z = zoneOfClientX(e && e.clientX);
      activePointers[id] = z;
      setZoneHeld(z, true);
      if (e && e.preventDefault) e.preventDefault();
      return;
    }

    if (phase !== 'title' && phase !== 'finished') return;
    var hit = null;
    if (R) {
      var p = toLogical(e);
      try { hit = typeof R.hitTestTitleArrow === 'function' ? R.hitTestTitleArrow(p.x, p.y) : null; } catch (err2) { hit = null; }
      if (!hit && typeof R.hitTestTitleRow === 'function') {
        try { hit = R.hitTestTitleRow(p.x, p.y); } catch (err3) { hit = null; }
      }
    }
    if (hit === 'left') { switchTrack(-1); return; }
    if (hit === 'right') { switchTrack(1); return; }
    // 手机点按任意处开始；鼠标点击维持旧行为（只聚焦）
    if (!e || e.pointerType !== 'mouse') startRace();
  }

  function onPointerUp(e) {
    if (!e) return;
    releasePointer((e.pointerId !== undefined) ? e.pointerId : 'p');
  }

  // 手指从一半划到另一半：释放旧区、按住新区
  function onPointerMove(e) {
    if (!e) return;
    var id = (e.pointerId !== undefined) ? e.pointerId : 'p';
    var z = activePointers[id];
    if (z === undefined) return;
    var nz = zoneOfClientX(e.clientX);
    if (nz === z) return;
    activePointers[id] = nz;
    if (!zoneStillHeld(z)) setZoneHeld(z, false);
    setZoneHeld(nz, true);
  }

  // Enter 开始 / R 重开 / P 暂停 / M 静音 / Esc 回标题
  function handleInput() {
    if (!input) return;
    if (phase === 'title') {
      if (input.consume('left')) { switchTrack(-1); return; }
      if (input.consume('right')) { switchTrack(1); return; }
    }
    input.consume('left');
    input.consume('right');
    if (input.consume('start') && (phase === 'title' || phase === 'finished')) startRace();
    if (input.consume('restart')) startRace();
    if (input.consume('mute')) toggleMute();
    if (input.consume('back')) backToTitle();
    if (input.consume('pause')) togglePause();
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

  // 救车反馈：saveWindow（超限且已松油）进入即"武装"，gripUse 回落到 <1 的那一刻
  // 播放上行音——把"松油救回来了"从纯 HUD 信息变成可感知事件。脱轨则清除武装（boom 已负责）。
  var saveArmed = [false, false];
  var FLY_GUARD = 1.7;          // = car.js FLY_GUARD：derailT 越过它即落地
  var prevDerailT = [0, 0];
  function saveFeedback() {
    if (!race || !race.entries) return;
    for (var i = 0; i < 2 && i < race.entries.length; i++) {
      var car = race.entries[i].car;
      if (!car) { saveArmed[i] = false; continue; }
      // 镜头震动：脱轨瞬间强震，落地瞬间中震（3D 路径；2D 兜底无相机，自然忽略）
      var dt2 = Number(car.derailT) || 0;
      if (car.derailed && prevDerailT[i] === 0 && dt2 > 0 && gl && typeof gl.shake === 'function') gl.shake(9);
      if (car.derailed && prevDerailT[i] <= FLY_GUARD && dt2 > FLY_GUARD && gl && typeof gl.shake === 'function') gl.shake(5);
      prevDerailT[i] = dt2;
      if (!audio) continue;
      if (car.derailed) { saveArmed[i] = false; continue; }
      if (car.saveWindow && car.gripUse >= 1) { saveArmed[i] = true; continue; }
      if (saveArmed[i] && car.gripUse < 1) { audio.save(); saveArmed[i] = false; continue; }
      if (!car.saveWindow && car.gripUse < 1) saveArmed[i] = false;
    }
  }

  function clamp01(v) { var n = Number(v); if (!isFinite(n) || n < 0) return 0; return n > 1 ? 1 : n; }

  // 引擎音：速度比例 = speed / 400；油门行程决定音量（不踩不响）；
  // 预警量提前到 gripUse 0.55 渐入（黄区前就低声存在），并做非对称平滑
  // （0.18s 快攻 / 0.4s 慢放）——预警是"渐渐紧张"而不是突然钻出来
  var warnSm = [0, 0];
  function engineSounds(dt) {
    if (!audio || !race || !race.entries) return;
    for (var i = 0; i < 2 && i < race.entries.length; i++) {
      var car = race.entries[i].car;
      var warn = 0;
      if (car && !car.derailed) {
        var gu = Math.max(Number(car.gripUse) || 0, 0);
        var gripWarn = clamp01((gu - 0.55) / 0.75);
        var slipWarn = clamp01((Number(car.slip) || 0) / 0.9);
        warn = Math.max(gripWarn, slipWarn);
      }
      // 非对称指数平滑：上升 0.18s、下降 0.4s
      var tau = warn > warnSm[i] ? 0.18 : 0.4;
      warnSm[i] += (warn - warnSm[i]) * (1 - Math.exp(-(dt || 0.016) / tau));
      audio.engine(i, car ? car.speed / 400 : 0, warnSm[i], car ? car.throttle : 0);
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
      saveFeedback();
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

  // 诊断面板：把「切赛道为什么没反应」需要的状态摊平成 4 行文本写进 #dbg（?debug=1 才可见）
  // 采样：每 6 帧写一次 textContent（12px 文本重写 DOM 有成本，采样后肉眼仍算实时）
  // 缺 #dbg / 缺 __DBG__ 时静默跳过，不影响游戏本身
  var dbgFrame = 0;
  function updateDbg() {
    if ((dbgFrame++ % 6) !== 0) return;
    var D = window.__DBG__;
    if (!D) return;
    var el = null;
    try { el = document.getElementById('dbg'); } catch (err) { el = null; }
    if (!el) return;
    var name = track && track.name ? String(track.name) : '-';
    var keys = D.keys && D.keys.length ? D.keys.slice(-3).join(',') : '-';
    var pt = (D.pt && isFinite(D.pt.x) && isFinite(D.pt.y))
      ? (Math.round(D.pt.x) + ',' + Math.round(D.pt.y)) : '-';
    D.phase = phase;
    D.zones = [touchHeld[0] ? 1 : 0, touchHeld[1] ? 1 : 0];
    D.muted = audio ? !!audio.isMuted() : false;
    var errCount = window.__ERRORS__ && window.__ERRORS__.length ? window.__ERRORS__.length : 0;
    el.textContent =
      'BUILD5 list=' + trackList.length + ' phase=' + phase + ' id=' + trackId + ' name=' + name + '\n' +
      'calls=' + (D.calls || 0) + ' dir=' + (D.lastDir === undefined || D.lastDir === null ? '-' : D.lastDir) +
        ' guard=' + (D.guarded || '-') + '\n' +
      'key=' + keys + ' pt=' + pt + '\n' +
      'err=' + (D.err || '-') + ' errors=' + errCount + '\n' +
      'zones=P1:' + (touchHeld[0] ? 1 : 0) + ' P2:' + (touchHeld[1] ? 1 : 0) + ' phase=' + phase;
  }

  // 帧入口：计时、输入、按阶段推进
  function tick(now) {
    var dt = (now - last) / 1000;
    last = now;
    if (!(dt > 0)) dt = 0;
    if (dt > 0.05) dt = 0.05;
    handleInput();
    if (phase === 'paused') { acc = 0; updateDbg(); return; }
    time += dt;
    if (phase === 'countdown' || phase === 'running') step(dt);
    countdownSounds();
    engineSounds(dt);
    updateDbg();
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
    portraitHintDismissed = false;   // 转屏后遮罩重新评估（仍竖屏则再提示一次）

    // 让 WebGL 的视口/宽高比跟上 CSS 尺寸
    if (gl && typeof gl.resize === 'function') {
      try { gl.resize(); } catch (err) { /* 渲染器 resize 失败不影响 HUD */ }
    }
  }

  // 当前赛道在列表中的下标
  function trackIndex() {
    for (var i = 0; i < trackList.length; i++) {
      if (trackList[i].id === trackId) return i;
    }
    return 0;
  }

  // 当前帧的渲染快照（3D 与 2D 兜底、HUD 共用同一份状态）
  function snapshot() {
    return {
      track: track, scene: scene, phase: phase, time: time,
      countdownT: race ? race.countdown - race.t : 0,
      race: race, best: best, particles: [],
      trackName: track ? track.name : '', trackDesc: track ? track.desc : '',
      trackIndex: trackIndex(), trackCount: trackList.length,
      portrait: (window.innerHeight || H) > (window.innerWidth || W),
      portraitHint: !portraitHintDismissed,
      muted: audio ? !!audio.isMuted() : false,
      pressed: pressedUIList()
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
      // 标题右下角的构建标记：截图里一眼确认加载到的是哪个版本、赛道加载到几条（不需要 ?debug=1）
      hudCtx.save();
      hudCtx.font = '11px monospace';
      hudCtx.textAlign = 'right';
      hudCtx.textBaseline = 'bottom';
      hudCtx.fillStyle = 'rgba(233,220,196,.45)';
      hudCtx.fillText('build 14 · ' + trackList.length + ' tracks', W - 8, H - 6);
      hudCtx.restore();
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
  window.addEventListener('pointerdown', function () { try { window.focus(); } catch (err) { /* 忽略 */ } }, false);
  window.addEventListener('pointerdown', warmAudio, false);
  window.addEventListener('resize', resize, false);

  // 指针：挂在 window 捕获阶段，避免被画布/叠加层吃掉（#hud 是 pointer-events:none，
  // 真实点击会穿到下层，单挂某个画布不可靠）；一次点击只进一次，无需防抖。
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointerup', onPointerUp, true);
  window.addEventListener('pointercancel', onPointerUp, true);
  window.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('blur', releaseAllPointers, false);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) releaseAllPointers();
  }, false);

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
