/* 赛道 / 车辆 / 脱轨 / 比赛 四项行为测试（node:test + node:assert/strict，只依赖 ../js/*.js） */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const trackMod = require('../js/track.js');
const carMod = require('../js/car.js');
const raceMod = require('../js/race.js');
const renderMod = require('../js/render.js');

// 固定物理步长（与 main.js 保持一致）
const DT = 1 / 120;

// 推进车辆 frames 帧，返回本段内 justDerailed 触发次数（读后复位）
function runCar(car, track, seconds) {
  const frames = Math.round(seconds / DT);
  let derails = 0;
  for (let i = 0; i < frames; i++) {
    carMod.update(car, DT, { throttle: 1 }, track);
    if (car.justDerailed) {
      derails += 1;
      car.justDerailed = false;
    }
  }
  return derails;
}

// 1) 赛道：总长、起点切线为单位向量、最近点反查
test('赛道：总长在 2300-2600，起点切线为单位向量，nearestS 可反查弧长', () => {
  const track = trackMod.createTrack();

  assert.ok(track.totalLength >= 2300, 'totalLength 应 >= 2300，实际 ' + track.totalLength);
  assert.ok(track.totalLength <= 2600, 'totalLength 应 <= 2600，实际 ' + track.totalLength);

  const p0 = track.sampleAt(0);
  assert.ok(Math.abs(Math.hypot(p0.tx, p0.ty) - 1) <= 0.001,
    'sampleAt(0) 切线应为单位向量，实际 |t| = ' + Math.hypot(p0.tx, p0.ty));

  const p700 = track.sampleAt(700);
  const back = track.nearestS(p700.x, p700.y);
  assert.ok(Math.abs(back - 700) < 5, 'nearestS(sampleAt(700)) 应接近 700，实际 ' + back);
});

// 2) 车辆：全油门 3 秒内速度能上 250+；弯道脱轨属正常设计，只验证能自动复位、不连环脱轨
// 说明：本车全油门约 2.52s 就在弯道脱轨，3.0s 时正处于复位倒计时（瞬时速度已衰减），
// 因此“3 秒后 speed > 250”按“前 3 秒内 speed 峰值”校验。
// 复位窗口 3.0s：新脱轨含落地弹跳，全程约 2.6s（飞出 + 弹跳滑停 + 停留 + 归位）。
test('车辆：全油门 3 秒 speed 峰值 > 250，脱轨后 3.0 秒内自动复位且 6 秒内脱轨不超过 3 次', () => {
  const track = trackMod.createTrack();
  const car = carMod.createCar({ lane: 1, name: 'P1' });

  // 阶段 1 + 2：全油门连续跑到 6 秒；前 3 秒记录速度峰值，全程记录首次脱轨与自动复位
  const firstPhaseEnd = Math.round(3 / DT);
  const totalFrames = Math.round(6 / DT);
  let peakSpeed = 0;        // 前 3 秒内的速度峰值
  let derailAt = -1;        // 首次脱轨时刻（秒）
  let recoverAt = -1;       // 复位完成时刻（秒）：derailT 归零、blinkT > 0、derailed === false
  let recoverState = null;  // 复位当帧的状态快照
  let totalAt6 = car.totalDerails;

  for (let i = 0; i < totalFrames; i++) {
    carMod.update(car, DT, { throttle: 1 }, track);
    const t = (i + 1) * DT;
    if (i < firstPhaseEnd) peakSpeed = Math.max(peakSpeed, car.speed);
    if (derailAt < 0 && (car.justDerailed || car.derailed)) {
      derailAt = t;
    }
    if (derailAt >= 0 && recoverAt < 0 &&
        car.derailed === false && car.derailT === 0 && car.blinkT > 0) {
      recoverAt = t;
      recoverState = { derailT: car.derailT, blinkT: car.blinkT, derailed: car.derailed };
    }
    totalAt6 = car.totalDerails;
  }

  // 若脱轨发生在 6 秒末尾，复位窗口可能越过 6 秒：再跑到“脱轨后 3.0 秒”上限继续观察
  if (derailAt >= 0 && recoverAt < 0) {
    const limitFrame = Math.round((derailAt + 3.0) / DT);
    for (let i = totalFrames; i < limitFrame && recoverAt < 0; i++) {
      carMod.update(car, DT, { throttle: 1 }, track);
      const t = (i + 1) * DT;
      if (car.derailed === false && car.derailT === 0 && car.blinkT > 0) {
        recoverAt = t;
        recoverState = { derailT: car.derailT, blinkT: car.blinkT, derailed: car.derailed };
      }
    }
  }

  // 1) 全油门 3 秒内应加速到 250 以上（取峰值，理由见用例前注释）
  assert.ok(peakSpeed > 250, '全油门前 3 秒 speed 峰值应 > 250，实际 ' + peakSpeed.toFixed(1));

  // 3) 不会连环脱轨：6 秒内脱轨次数有上限
  assert.ok(totalAt6 <= 3, '6 秒内脱轨次数应 <= 3（不连环脱轨），实际 ' + totalAt6);

  // 2) 若中途脱轨，脱轨后 3.0 秒内应能自动复位
  if (derailAt >= 0) {
    assert.ok(recoverAt >= 0,
      '脱轨后 3.0 秒内应自动复位（derailT 归零、blinkT > 0、derailed === false），实际未观察到复位');
    assert.ok(recoverAt - derailAt <= 3.0,
      '复位耗时应 <= 3.0 秒，实际 ' + (recoverAt - derailAt).toFixed(3) + ' 秒');
    assert.equal(recoverState.derailed, false, '复位后 derailed 应为 false');
    assert.equal(recoverState.derailT, 0, '复位后 derailT 应归零，实际 ' + recoverState.derailT);
    assert.ok(recoverState.blinkT > 0, '复位后 blinkT 应 > 0，实际 ' + recoverState.blinkT);
  }
});

// 3) 脱轨：弯道不收油会被甩出赛道
test('脱轨：从 s=0 全油门 20 秒，justDerailed 至少触发一次', () => {
  const track = trackMod.createTrack();
  const car = carMod.createCar({ lane: 1, name: 'P1' });

  const derails = runCar(car, track, 20);
  assert.ok(derails >= 1, '全油门 20 秒应至少甩出一次，实际触发 ' + derails + ' 次（totalDerails=' + car.totalDerails + '）');
});

// 4) 比赛：两车全油门 70 秒跑完 3 圈，冠军与排名一致
// 说明：脱轨期间 s 不再前进，全油门单圈约 18s，3 圈约 58s，故时间窗取 70 秒。
test('比赛：两车全油门 70 秒内完赛，冠军跑满 3 圈且排名第一', () => {
  const track = trackMod.createTrack();
  const cars = [
    carMod.createCar({ lane: 1, name: 'P1' }),
    carMod.createCar({ lane: -1, name: 'P2' })
  ];
  const race = raceMod.createRace({ track: track, cars: cars, laps: 3 });

  const frames = Math.round(70 / DT);
  for (let i = 0; i < frames && race.phase !== 'finished'; i++) {
    raceMod.update(race, DT, [1, 1]);
  }

  assert.equal(race.phase, 'finished', '70 秒内应完赛，实际阶段 ' + race.phase);
  assert.ok(race.winner, '应有冠军');
  assert.equal(race.winner.lapTimes.length, 3, '冠军应记录 3 个圈速，实际 ' + race.winner.lapTimes.length);
  assert.equal(raceMod.standings(race)[0], race.winner, '排名第一应为冠军');
});

// 5) 阁楼赛道：几何断言 + 治理驾驶（模拟玩家收油过弯）完赛
// 说明：阁楼赛道弯道较紧（最紧 r44，脱轨阈值 sqrt(950*44)≈204px/s），
// 全油门机器人会在每个弯道反复脱轨（设计如此，技术赛道惩罚激进驾驶），
// 因此完赛测试使用治理型油门：接近弯道限速时收油，模拟真实玩家操作。
test('阁楼赛道：几何合法，治理驾驶 150 秒内完赛 3 圈且零脱轨', () => {
  const track = trackMod.createTrack('attic');

  assert.equal(track.id, 'attic', '赛道 id 应为 attic');
  assert.ok(track.totalLength >= 3400 && track.totalLength <= 4100,
    'totalLength 应在 3400-4100，实际 ' + track.totalLength.toFixed(0));
  const p0 = track.sampleAt(0);
  assert.ok(Math.abs(Math.hypot(p0.tx, p0.ty) - 1) <= 0.001, '起点切线应为单位向量');
  const back = track.nearestS(track.sampleAt(700).x, track.sampleAt(700).y);
  assert.ok(Math.abs(back - 700) < 5, 'nearestS 应可反查弧长');
  // 桥面高程：平段 36，引桥末端 0
  const sc = track.bridge.sCenter;
  assert.ok(track.elevationAt(sc) === track.bridge.height, '桥面平段高程应为 bridge.height');
  assert.ok(track.elevationAt(sc + track.bridge.rampHalf) === 0, '引桥末端高程应为 0');

  const cars = [
    carMod.createCar({ lane: 1, name: 'P1' }),
    carMod.createCar({ lane: -1, name: 'P2' })
  ];
  const race = raceMod.createRace({ track: track, cars: cars, laps: 3 });
  const DT = 1 / 120;
  const GOVERNOR = 190;   // 直道目标速度
  let derails = 0;
  for (let i = 0; i < Math.round(150 / DT) && race.phase !== 'finished'; i++) {
    const thr = [];
    for (const e of race.entries) {
      const ahead = track.cornerLimit(e.car.s + 60);
      const target = Math.min(GOVERNOR, isFinite(ahead) ? ahead * 0.95 : GOVERNOR);
      thr.push(e.car.speed < target ? 1 : 0);
    }
    raceMod.update(race, DT, thr);
    for (const e of race.entries) {
      if (e.car.justDerailed) { derails += 1; e.car.justDerailed = false; }
    }
  }

  assert.equal(race.phase, 'finished', '150 秒内应完赛，实际阶段 ' + race.phase);
  assert.ok(race.winner && race.winner.lapTimes.length === 3, '冠军应跑满 3 圈');
  assert.ok(derails === 0, '治理驾驶应零脱轨，实际 ' + derails + ' 次');
});

// 6) 赛道注册表：两条赛道均可创建，未知 id 回落默认
test('赛道注册表：listTracks 返回双赛道，未知 id 回落 8 字环道', () => {
  const list = trackMod.listTracks();
  assert.ok(list.length >= 2, '至少两条赛道');
  assert.ok(list.some(t => t.id === 'figure8'), '应包含 figure8');
  assert.ok(list.some(t => t.id === 'attic'), '应包含 attic');
  const fallback = trackMod.createTrack('不存在的赛道');
  assert.equal(fallback.id, 'figure8', '未知 id 应回落 figure8');
});

// 7) 3D 场景：两条赛道都能建出来，且 setTrack 真的重建
// 说明：gl.js 在 'use strict' 下跑，任何未声明的变量都会让 RaceGL.create 抛错，
// 而 main.js 会静默回落到 2D——画面"还在跑"，实际整条赛道都没有 3D。
// 曾经因为桥墩循环里一个漏声明的 off 把整局打回 2D，地图直接跑到画面外。
test('3D 场景：两条赛道都能构建，create() 暴露 setTrack 且切换后真的重建几何', () => {
  const { buildScene } = require('./gl-scene.js');
  for (const id of ['figure8', 'attic']) {
    const r = buildScene(id);
    assert.ok(r.meshes >= 4, id + ' 至少要有 4 个网格，实际 ' + r.meshes);
    assert.ok(r.tris >= 100, id + ' 至少要有 100 个三角面，实际 ' + r.tris);
    assert.ok(r.switchedVerts > 0, id + ' setTrack 之后赛道分组里没有几何');
  }
});

// 8) 画面取景：2D 兜底把赛道层平移到画布中心后，两条赛道都必须完整落在 1280×720 内
// 说明：赛道坐标原点在赛道中心（有正有负），画布是 0..W / 0..H。scene.js 的赛道层与
// render.js 的车辆沿用同一个平移量；漏掉平移时整条赛道会跑到画布左上角外面
// （WebGL 不可用回落 2D 时暴露成「地图不在画面中」）。
test('画面取景：两条赛道平移到画布中心后完整落在 1280×720 内', () => {
  const sceneMod = require('../js/scene.js');
  const W = sceneMod.width, H = sceneMod.height;
  const ox = W / 2, oy = H / 2;
  for (const id of ['figure8', 'attic']) {
    const track = trackMod.createTrack(id);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of track.points) {
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.y > y1) y1 = p.y;
    }
    const pad = track.width / 2 + 8;   // 路面半宽 + 护栏/路肩余量
    assert.ok(x0 + ox - pad >= 0, id + ' 左侧出画：' + (x0 + ox - pad).toFixed(0));
    assert.ok(x1 + ox + pad <= W, id + ' 右侧出画：' + (x1 + ox + pad).toFixed(0));
    assert.ok(y0 + oy - pad >= 0, id + ' 上方出画：' + (y0 + oy - pad).toFixed(0));
    assert.ok(y1 + oy + pad <= H, id + ' 下方出画：' + (y1 + oy + pad).toFixed(0));
  }
});

// 9) 触摸油门：setTouch 独立于键盘，按下/松开即时生效
test('触摸油门：setTouch 控制 P1/P2，clear 后全部释放', () => {
  const inputMod = require('../js/input.js');
  const inp = inputMod.createInput();
  assert.equal(inp.get(0), 0);
  assert.equal(inp.get(1), 0);
  inp.setTouch(0, true);
  assert.equal(inp.get(0), 1, '按住左半屏应给 P1 油门');
  assert.equal(inp.get(1), 0, '不应串到 P2');
  inp.setTouch(0, false);
  assert.equal(inp.get(0), 0);
  inp.setTouch(1, true);
  assert.equal(inp.get(1), 1, '按住右半屏应给 P2 油门');
  inp.setTouch(1, 999);
  assert.equal(inp.get(1), 1, '越界 index 应被忽略');
  inp.clear();
  assert.equal(inp.get(1), 0, 'clear 后触摸油门应释放');
  inp.destroy();
});

// 10) 屏上按钮：drawTitle / drawHUD 注册的芯片可被 hitTestUI 命中，触控目标 ≥44px
// 说明：屏上按钮是手机唯一的暂停/静音/回标题入口；漏注册 = 手机上功能整个不可达。
// 结算页按钮也在这里一并覆盖（boot-sim 无法快速跑到 finished）。
test('UI：各阶段芯片注册命中区，触控目标 ≥44 且不与油门区冲突', () => {
  // Canvas2D 桩：所有方法吞掉，measureText 给固定宽度
  const ctx = new Proxy({}, {
    get(t, p) {
      if (p === 'measureText') return () => ({ width: 10 });
      if (typeof t[p] !== 'undefined') return t[p];
      return () => {};
    },
    set(t, p, v) { t[p] = v; return true; }
  });
  const R = renderMod;

  // 比赛阶段：暂停 + 静音芯片
  R.drawHUD(ctx, { phase: 'running', time: 0, race: null, muted: false, pressed: [] });
  assert.equal(R.hitTestUI(851, 46), 'pause', '暂停芯片中心应命中');
  assert.equal(R.hitTestUI(828, 24), 'pause', '暂停芯片左上角应命中');
  assert.equal(R.hitTestUI(874, 68), 'pause', '暂停芯片右下角应命中');
  assert.equal(R.hitTestUI(877, 68), null, '芯片外 3px 不应命中');
  assert.equal(R.hitTestUI(907, 46), 'mute', '静音芯片中心应命中');

  // 暂停阶段：面板三键
  R.drawHUD(ctx, { phase: 'paused', time: 0, race: null, muted: false, pressed: [] });
  assert.equal(R.hitTestUI(475, 374), 'resume', '继续键应命中');
  assert.equal(R.hitTestUI(640, 374), 'restart', '重开键应命中');
  assert.equal(R.hitTestUI(805, 374), 'back', '回标题键应命中');

  // 结算阶段：再来一局 / 回标题（race 用 null 也要能画出按钮并注册）
  R.drawHUD(ctx, { phase: 'finished', time: 0, race: null, muted: false, pressed: [] });
  const againHit = R.hitTestUI(533, 556);
  const backHit = R.hitTestUI(747, 556);
  assert.ok(againHit === 'again' || againHit === 'back', '结算页应有按钮命中，实际 ' + againHit);
  assert.ok(backHit === 'again' || backHit === 'back', '结算页应有按钮命中，实际 ' + backHit);

  // 标题阶段：右上角静音芯片；油门区（下半屏）不应注册任何按钮
  R.drawTitle(ctx, { phase: 'title', time: 0, trackName: '阁楼复刻', trackDesc: '', trackCount: 2, muted: false, pressed: [] });
  assert.equal(R.hitTestUI(1233, 42), 'mute', '标题静音芯片应命中');
  assert.equal(R.hitTestUI(640, 536), 'start', '开始比赛按钮应命中');
  assert.equal(R.hitTestUI(100, 600), null, '标题下半屏（点按开始区）不应注册按钮');

  // 竖屏遮罩：portrait 时全屏可点，且优先于其他按钮（最后注册 = 最上层）
  R.drawHUD(ctx, { phase: 'running', time: 0, race: null, muted: false, pressed: [], portrait: true });
  assert.equal(R.hitTestUI(640, 360), 'portraitDismiss', '竖屏遮罩全屏命中');
  assert.equal(R.hitTestUI(851, 46), 'portraitDismiss', '遮罩优先于暂停芯片');
  R.drawHUD(ctx, { phase: 'running', time: 0, race: null, muted: false, pressed: [], portrait: true, portraitHint: false });
  assert.equal(R.hitTestUI(640, 360), null, 'portraitHint=false 时不注册遮罩');
  assert.equal(R.hitTestUI(851, 46), 'pause', '遮罩关闭后暂停芯片恢复可命中');
});

// 11) 反馈层音效：接口存在、参数被消费、静音门控生效（Node 桩 AudioContext）
// 说明：预警引擎音 / 倒计时 beep / 救车音 / 点击音是「听声知极限」的核心反馈；
// boot-sim 只能断言「响了几次」，这里断言「参数与门控」——muted 时一个振荡器都不许启动。
test('音效：engine 预警参数、click/save/beep 入队，静音时全部静默', () => {
  const audioMod = require('../js/audio.js');
  const scheduled = [];   // osc.start(t) 且 t 为数字的音（定时音）
  let contOsc = 0;        // 持续音（引擎/预警层）计数
  const ctx = {
    state: 'running', sampleRate: 44100, currentTime: 1.0, destination: {},
    resume: () => Promise.resolve(true),
    createGain: () => ({ gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, setTargetAtTime() {} }, connect() {} }),
    createOscillator: () => {
      const osc = {
        type: 'sine', detune: { value: 0 },
        frequency: { value: 0, setValueAtTime() {}, setTargetAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {},
        start(t) {
          if (t === undefined) { contOsc += 1; return; }
          scheduled.push({ freq: osc.frequency.value, type: osc.type });
        },
        stop() {}, disconnect() {}
      };
      return osc;
    },
    createBiquadFilter: () => ({ type: '', frequency: { value: 0, setTargetAtTime() {} }, Q: { value: 0 }, connect() {} }),
    createBuffer: (c, len) => ({ getChannelData: () => new Float32Array(len || 64) }),
    createBufferSource: () => ({ buffer: null, connect() {}, start() { scheduled.push({ noise: true }); }, stop() {}, disconnect() {} }),
    close() {}
  };
  const win = {
    AudioContext: function () { return ctx; },
    addEventListener() {}, removeEventListener() {}
  };
  const prevWindow = global.window;
  global.window = win;
  try {
    const audio = audioMod.createAudio();
    audio.resume();   // ctx 惰性创建（真实浏览器由首次手势触发）；state 桩固定 'running'

    // 引擎：持续音 2 条（sawtooth 本体 + square 预警层）
    audio.engine(0, 0.5, 0.9);
    assert.ok(contOsc >= 2, 'engine 应建立本体+预警两条持续振荡器，实际 ' + contOsc);

    // 定时音入队
    audio.beep(440);
    audio.click();
    audio.save();
    const freqs = scheduled.map(x => x.freq);
    assert.ok(freqs.indexOf(440) >= 0, 'beep(440) 应入队');
    assert.ok(freqs.indexOf(1250) >= 0, 'click tick 应入队');
    assert.ok(freqs.indexOf(660) >= 0, 'save 上行第二音应入队');
    const beforeMuted = scheduled.length;

    // 静音门控：muted 期间一个新音都不入队
    audio.setMuted(true);
    audio.beep(440);
    audio.click();
    audio.save();
    audio.boom();
    audio.engine(1, 0.5, 1);
    assert.equal(scheduled.length, beforeMuted, '静音期间不得新增任何音');

    audio.setMuted(false);
    audio.beep(440);
    assert.equal(scheduled.length, beforeMuted + 1, '解除静音后恢复入队');
    audio.destroy();
  } finally {
    if (prevWindow === undefined) delete global.window; else global.window = prevWindow;
  }
});
