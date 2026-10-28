/* 浏览器启动模拟：DOM/Canvas 桩 + 按 index.html 顺序加载脚本 + 跑 5 帧
 * 运行：node _debug/_boot-sim.js
 * 目的：抓运行时报错（如非法正则、未定义引用），无需真实浏览器
 */
'use strict';
const fs = require('fs');
const path = require('path');

// ---- 沙箱 ----
const sandbox = {};
const noop = () => {};
const gradient = { addColorStop: noop };

const ctx2d = new Proxy({}, {
  get(target, prop) {
    if (prop === 'createRadialGradient' || prop === 'createLinearGradient') return () => gradient;
    if (prop === 'canvas') return { width: 1280, height: 720 };
    if (typeof target[prop] !== 'undefined') return target[prop];
    return noop;
  },
  set(target, prop, value) { target[prop] = value; return true; }
});

function makeCanvas(id) {
  return {
    id, width: 0, height: 0, style: {},
    clientWidth: 1280, clientHeight: 720,
    _listeners: {},
    focused: false,
    setAttribute: noop,
    focus() { this.focused = true; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 1280, height: 720 }; },
    addEventListener(type, cb) { (this._listeners[type] = this._listeners[type] || []).push(cb); },
    removeEventListener: noop,
    getContext(type) { return type === '2d' ? ctx2d : null; }
  };
}

const canvases = {};
const documentStub = {
  hidden: false,
  getElementById(id) {
    if (!canvases[id]) canvases[id] = makeCanvas(id);
    return canvases[id];
  },
  createElement(tag) { return makeCanvas(tag); },
  addEventListener: noop, removeEventListener: noop,
  body: { appendChild: noop }
};

var rafQueue = [];
var keyHandlers = [];
var pointerHandlers = [];   // window 上的 pointerdown（main.js 现在挂在 window 捕获阶段）
var pointerUpHandlers = [];      // window 上的 pointerup / pointercancel
var pointerMoveHandlers = [];    // window 上的 pointermove
var store = {};
function pressKey(code) {
  const e = { code, preventDefault: noop, repeat: false };
  for (const cb of keyHandlers) {
    try { cb(e); } catch (err) { /* 浏览器语义：单个监听器抛错不阻断其它监听器 */ }
  }
}
function runFrames(count, stepMs) {
  for (let f = 0; f < count; f++) {
    const queued = rafQueue.slice();
    rafQueue.length = 0;
    for (const cb of queued) {
      try { cb(now); } catch (err) {
        console.log('  ✗ frame →', err.constructor.name + ':', err.message);
        process.exit(1);
      }
    }
    now += (stepMs || 16.7);
  }
}

// 往 window 派发一次 pointerdown（坐标用逻辑坐标，画布桩的 rect 就是 1280×720）
// 注：main.js 的切赛道入口挂在 window 捕获阶段，所以这里派发给 window 监听器而非某个画布
function clickPage(clientX, clientY) {
  const e = { type: 'pointerdown', clientX, clientY, isPrimary: true, preventDefault: noop };
  for (const cb of pointerHandlers) {
    try { cb(e); } catch (err) {
      console.log('  ✗ window pointerdown 抛错 →', err.constructor.name + ':', err.message);
      process.exit(1);
    }
  }
}

// 通用指针派发：opts 可给 pointerId / pointerType / isPrimary
function dispatchPointer(type, clientX, clientY, opts) {
  opts = opts || {};
  const e = {
    type: type, clientX: clientX, clientY: clientY,
    pointerId: opts.pointerId === undefined ? 1 : opts.pointerId,
    pointerType: opts.pointerType === undefined ? 'touch' : opts.pointerType,
    isPrimary: opts.isPrimary === undefined ? true : opts.isPrimary,
    preventDefault: noop
  };
  const list = (type === 'pointerdown') ? pointerHandlers
    : (type === 'pointermove') ? pointerMoveHandlers
    : pointerUpHandlers;
  for (const cb of list) {
    try { cb(e); } catch (err) {
      console.log('  ✗ window ' + type + ' 抛错 →', err.constructor.name + ':', err.message);
      process.exit(1);
    }
  }
}
var now = 0;
// 最小 AudioContext 桩（真实浏览器里 resume/振荡器都可用，这里只保证不抛错）
// 录音：osc.start(t) 时记下 { freq, t, type }；t 为数字 = 定时音（beep/tone），undefined = 持续音（引擎）
const audioLog = [];
class AudioContextStub {
  constructor() { this.currentTime = 0; this.sampleRate = 44100; this.destination = {}; this.state = 'running'; }
  resume() { return Promise.resolve(); }
  createGain() { return { connect: noop, disconnect: noop, gain: param() }; }
  createOscillator() {
    return {
      connect: noop, disconnect: noop, stop: noop, type: '', detune: param(),
      frequency: param(),
      start(t) { audioLog.push({ freq: this.frequency.value, t: t, type: this.type }); }
    };
  }
  createBiquadFilter() { return { connect: noop, disconnect: noop, type: '', frequency: param(), Q: param(), detune: param() }; }
  createDynamicsCompressor() { return { connect: noop, disconnect: noop, threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() }; }
  createBuffer(ch, len, rate) { return { getChannelData: () => new Float32Array(len || 1) }; }
  createBufferSource() { return { connect: noop, disconnect: noop, start: noop, stop: noop, buffer: null, playbackRate: param() }; }
  createWaveShaper() { return { connect: noop, disconnect: noop, curve: null, oversample: '' }; }
}
function param() { return { value: 0, setValueAtTime: noop, linearRampToValueAtTime: noop, exponentialRampToValueAtTime: noop, setTargetAtTime: noop, cancelScheduledValues: noop }; }
// window 与 globalThis 同一对象（与浏览器一致），UMD 挂载与 window.* 引用互通
const windowStub = {
  innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1,
  location: { search: '' },
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
  performance: { now: () => Date.now() },
  addEventListener(type, cb) {
    if (type === 'keydown') keyHandlers.push(cb);
    else if (type === 'pointerdown') pointerHandlers.push(cb);
    else if (type === 'pointerup' || type === 'pointercancel') pointerUpHandlers.push(cb);
    else if (type === 'pointermove') pointerMoveHandlers.push(cb);
  },
  removeEventListener: noop,
  requestAnimationFrame(cb) { rafQueue.push(cb); return rafQueue.length; },
  document: documentStub
};

// ---- 按 index.html 顺序加载 ----
const scripts = [
  'vendor/three.min.js', 'vendor/cannon.min.js',
  'js/util.js', 'js/track.js', 'js/car.js', 'js/race.js', 'js/scene.js',
  'js/render.js', 'js/gl.js', 'js/gl-cars.js', 'js/flight-physics.js',
  'js/input.js', 'js/audio.js', 'js/main.js'
];

for (const f of scripts) {
  const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  try {
    const fn = new Function('window', 'document', 'globalThis', 'self', 'module', 'exports', 'require', src);
    windowStub.AudioContext = AudioContextStub;
    fn(windowStub, documentStub, windowStub, windowStub, undefined, undefined, undefined);
    console.log('  ✓', f);
  } catch (err) {
    console.log('  ✗', f, '→', err.constructor.name + ':', err.message);
    process.exit(1);
  }
}

// ---- 跑 5 帧（模拟 rAF）----
runFrames(5);

// ---- 断言关键状态 ----
console.log('---');
console.log('RaceTrack:', typeof windowStub.RaceTrack, '| RaceGL:', typeof windowStub.RaceGL,
  '| RaceRender:', typeof windowStub.RaceRender, '| RaceCar:', typeof windowStub.RaceCar);
console.log('trackId/main 状态: 见流程输出');

// ---- 流程 0：点击右箭头切赛道（标题改版后箭头位置动态扫描）----
runFrames(1);   // 先让标题画一帧，drawTitle 会记录箭头命中框
let hitX = -1, hitY = -1;
for (let y = 290; y <= 420 && hitX < 0; y += 4) {
  for (let x = 600; x <= 1200; x += 4) {
    if (windowStub.RaceRender.hitTestTitleArrow(x, y) === 'right') { hitX = x; hitY = y; break; }
  }
}
if (hitX < 0) { console.log('  ✗ 未在标题里找到右箭头命中区（hitTestTitleArrow 全返回 null）'); process.exit(1); }
clickPage(hitX, hitY);
runFrames(2);
console.log('[click] 右箭头 (' + hitX + ',' + hitY + ') → slotrace.track =', store['slotrace.track']);
if (store['slotrace.track'] !== 'attic') { console.log('  ✗ 点击切换赛道失败'); process.exit(1); }

// ---- 流程 0b：整行半平面点击（非箭头精确框、行命中返回 'right' 的点）----
let rowX = -1;
for (let x = 600; x <= 1250 && rowX < 0; x += 2) {
  if (!windowStub.RaceRender.hitTestTitleArrow(x, hitY) &&
      windowStub.RaceRender.hitTestTitleRow(x, hitY) === 'right') { rowX = x; }
}
if (rowX < 0) { console.log('  ✗ 未找到整行命中的右半平面点'); process.exit(1); }
clickPage(rowX, hitY);
runFrames(2);
console.log('[row-click] (' + (hitX + 108) + ',' + hitY + ') →', store['slotrace.track']);
if (store['slotrace.track'] !== 'figure8') {
  console.log('  ✗ 整行点击切换赛道失败，期望 figure8，实际 =', store['slotrace.track']);
  process.exit(1);
}

// ---- 流程 0c：备用键 KeyD（←/→ 被宿主拦走时的通路）----
pressKey('KeyD'); runFrames(2);
console.log('[keyD] →', store['slotrace.track']);
if (store['slotrace.track'] !== 'attic') {
  console.log('  ✗ KeyD 备用键切换失败，期望 attic，实际 =', store['slotrace.track']);
  process.exit(1);
}

// ---- 流程 0d：createTrack 抛错时状态不被污染（先建后提交）----
// 当前停在 attic：先正常切到 figure8，让下一次 KeyD 的目标正好是 attic（被包成抛错的那条）
pressKey('KeyD'); runFrames(2);
if (store['slotrace.track'] !== 'figure8') {
  console.log('  ✗ 0d 前置切换失败，期望 figure8，实际 =', store['slotrace.track']);
  process.exit(1);
}
const beforeId = store['slotrace.track'];
const origCreateTrack = windowStub.RaceTrack.createTrack;
windowStub.RaceTrack.createTrack = function (id) {
  if (id === 'attic') throw new Error('boom');
  return origCreateTrack.apply(windowStub.RaceTrack, arguments);
};
pressKey('KeyD'); runFrames(2);
if (store['slotrace.track'] !== beforeId) {
  console.log('  ✗ createTrack 抛错后状态被污染，期望仍 =', beforeId, '实际 =', store['slotrace.track']);
  process.exit(1);
}
if (!(windowStub.__DBG__ && String(windowStub.__DBG__.err || '').indexOf('boom') >= 0)) {
  console.log('  ✗ __DBG__.err 未记录 boom，实际 =', windowStub.__DBG__ && windowStub.__DBG__.err);
  process.exit(1);
}
// 恢复原 createTrack：同一方向再按一次应当切换成功（证明失败那次没把 trackId 弄脏）
windowStub.RaceTrack.createTrack = origCreateTrack;
pressKey('KeyD'); runFrames(2);
if (store['slotrace.track'] !== 'attic') {
  console.log('  ✗ 恢复 createTrack 后切换失败，期望 attic，实际 =', store['slotrace.track']);
  process.exit(1);
}
console.log('[guard] createTrack 抛错时状态未被污染');

// ---- 流程 1：ArrowRight ×2 切赛道 → Enter 开赛 → 跑 ~3 秒 ----
console.log('  [dbg] keyHandlers:', keyHandlers.map(h => h.name || 'anon').join(','), '| input instance:', typeof (windowStub.RaceInput && windowStub.RaceInput.createInput));
pressKey('ArrowRight'); runFrames(2);
console.log('  [dbg] after ArrowRight#1: store=', JSON.stringify(store), 'title=', documentStub.title);
pressKey('ArrowRight'); runFrames(2);
if (store['slotrace.track'] !== 'attic') {
  console.log('  ✗ 键盘 ArrowRight ×2 后面板未回到 attic，实际 =', store['slotrace.track']);
  process.exit(1);
}
console.log('[key] ArrowRight ×2 → slotrace.track =', store['slotrace.track']);
console.log('  [dbg] after ArrowRight#2: store=', JSON.stringify(store));
pressKey('Enter'); runFrames(200);
console.log('  [dbg] after Enter+3s: store=', JSON.stringify(store));
console.log('流程1（切换+开赛+跑3秒）✓');

// ---- 流程 2：Esc 回标题 → 左右切回 → 再开赛 ----
pressKey('Escape'); runFrames(2);
pressKey('ArrowLeft'); runFrames(2);
pressKey('ArrowRight'); runFrames(2);
pressKey('Enter'); runFrames(120);
console.log('流程2（切回+再开赛）✓');
console.log('localStorage slotrace.track =', store['slotrace.track'], '| store keys:', Object.keys(store));
console.log('当前赛道:', windowStub.RaceTrack ? (function(){ try { return windowStub.RaceTrack.createTrack(store['slotrace.track'] || 'figure8').name; } catch (e) { return 'err'; } })() : '-');
const selftest = sandbox.__SELFTEST__;
if (selftest) console.log('selftest:', JSON.stringify(selftest).slice(0, 120));
console.log('document.title:', documentStub.title || '(未设置)');
// ---- 流程 3：移动端左右半屏油门 ----
pressKey('Escape'); runFrames(8);
if (windowStub.__DBG__.phase !== 'title') {
  console.log('  ✗ Esc 后应回到 title，实际 =', windowStub.__DBG__.phase); process.exit(1);
}

// 3a：点按标题任意处开始（触摸，不能点在选择器那一行 y∈[324,412]）
dispatchPointer('pointerdown', 100, 600, { pointerId: 3, pointerType: 'touch' });
dispatchPointer('pointerup', 100, 600, { pointerId: 3, pointerType: 'touch' });
runFrames(10);
if (windowStub.__DBG__.phase !== 'countdown' && windowStub.__DBG__.phase !== 'running') {
  console.log('  ✗ 点按后应开赛，实际 phase =', windowStub.__DBG__.phase); process.exit(1);
}
console.log('[tap-start] phase=' + windowStub.__DBG__.phase);

// 3b：左半屏按住 = P1 油门
dispatchPointer('pointerdown', 100, 400, { pointerId: 4 });
runFrames(4);
if (windowStub.__DBG__.zones[0] !== 1) { console.log('  ✗ 左半屏按住后 zones=', JSON.stringify(windowStub.__DBG__.zones)); process.exit(1); }
dispatchPointer('pointerup', 100, 400, { pointerId: 4 });
runFrames(4);
if (windowStub.__DBG__.zones[0] !== 0) { console.log('  ✗ 左半屏松开后 zones=', JSON.stringify(windowStub.__DBG__.zones)); process.exit(1); }
console.log('[zone-left] down→1 up→0');

// 3c：右半屏按住 = P2 油门
dispatchPointer('pointerdown', 1100, 400, { pointerId: 5 });
runFrames(4);
if (windowStub.__DBG__.zones[1] !== 1) { console.log('  ✗ 右半屏按住后 zones=', JSON.stringify(windowStub.__DBG__.zones)); process.exit(1); }
dispatchPointer('pointerup', 1100, 400, { pointerId: 5 });
runFrames(4);
if (windowStub.__DBG__.zones[1] !== 0) { console.log('  ✗ 右半屏松开后 zones=', JSON.stringify(windowStub.__DBG__.zones)); process.exit(1); }
console.log('[zone-right] down→1 up→0');

// 3d：双指同时按住左右两半
dispatchPointer('pointerdown', 100, 400, { pointerId: 6, isPrimary: true });
dispatchPointer('pointerdown', 1100, 400, { pointerId: 7, isPrimary: false });
runFrames(4);
if (windowStub.__DBG__.zones[0] !== 1 || windowStub.__DBG__.zones[1] !== 1) {
  console.log('  ✗ 双指后 zones=', JSON.stringify(windowStub.__DBG__.zones)); process.exit(1);
}
dispatchPointer('pointerup', 100, 400, { pointerId: 6 });
dispatchPointer('pointerup', 1100, 400, { pointerId: 7 });
runFrames(4);
if (windowStub.__DBG__.zones[0] !== 0 || windowStub.__DBG__.zones[1] !== 0) {
  console.log('  ✗ 双指松开后 zones=', JSON.stringify(windowStub.__DBG__.zones)); process.exit(1);
}
console.log('[zone-both] 双指 [1,1] → 松开 [0,0]');

// ---- 流程 4：屏上按钮（桌游纸卡芯片）----
pressKey('Escape'); runFrames(8);
if (windowStub.__DBG__.phase !== 'title') {
  console.log('  ✗ 流程4前应回到 title，实际 =', windowStub.__DBG__.phase); process.exit(1);
}

// 4a：标题右上角静音芯片 → 写入 localStorage 且不会误开赛
dispatchPointer('pointerdown', 1233, 42, { pointerId: 8 });
runFrames(8);
if (windowStub.__DBG__.phase !== 'title') {
  console.log('  ✗ 点静音芯片不应开赛，phase =', windowStub.__DBG__.phase); process.exit(1);
}
if (store['slotrace.muted'] !== '1' || windowStub.__DBG__.muted !== true) {
  console.log('  ✗ 静音未持久化：store=' + store['slotrace.muted'] + ' muted=' + windowStub.__DBG__.muted); process.exit(1);
}
dispatchPointer('pointerup', 1233, 42, { pointerId: 8 });
runFrames(4);
console.log('[ui-mute] title 芯片 → 静音持久化 ✓');

// 4b：再点一次恢复有声
dispatchPointer('pointerdown', 1233, 42, { pointerId: 8 });
runFrames(8);
if (store['slotrace.muted'] !== '0' || windowStub.__DBG__.muted !== false) {
  console.log('  ✗ 取消静音失败'); process.exit(1);
}
dispatchPointer('pointerup', 1233, 42, { pointerId: 8 });
runFrames(4);
console.log('[ui-unmute] 恢复有声 ✓');

// 4b2：标题上的「开始比赛」按钮直接开赛
dispatchPointer('pointerdown', 640, 536, { pointerId: 14 });   // 开始按钮 (500..780, 508..564)
runFrames(8);
const phase4b2 = windowStub.__DBG__.phase;
if (phase4b2 !== 'countdown' && phase4b2 !== 'running') {
  console.log('  ✗ 点开始按钮应开赛，phase =', phase4b2); process.exit(1);
}
dispatchPointer('pointerup', 640, 536, { pointerId: 14 });
runFrames(2);
console.log('[ui-start] 开始比赛按钮 → ' + phase4b2 + ' ✓');
pressKey('Escape'); runFrames(8);
if (windowStub.__DBG__.phase !== 'title') {
  console.log('  ✗ Esc 应回标题，phase =', windowStub.__DBG__.phase); process.exit(1);
}

// 4c：开赛 → 点暂停芯片 → paused，且不注入半屏油门
dispatchPointer('pointerdown', 100, 600, { pointerId: 9 });
dispatchPointer('pointerup', 100, 600, { pointerId: 9 });
runFrames(10);
const phase4c = windowStub.__DBG__.phase;
if (phase4c !== 'countdown' && phase4c !== 'running') {
  console.log('  ✗ 点按开赛失败，phase =', phase4c); process.exit(1);
}
dispatchPointer('pointerdown', 851, 46, { pointerId: 10 });   // 暂停芯片 (828..874, 24..68)
runFrames(8);
if (windowStub.__DBG__.phase !== 'paused') {
  console.log('  ✗ 点暂停芯片应进入 paused，phase =', windowStub.__DBG__.phase); process.exit(1);
}
if (windowStub.__DBG__.zones[0] !== 0 || windowStub.__DBG__.zones[1] !== 0) {
  console.log('  ✗ 点芯片不应注入油门，zones =', JSON.stringify(windowStub.__DBG__.zones)); process.exit(1);
}
dispatchPointer('pointerup', 851, 46, { pointerId: 10 });
runFrames(2);
console.log('[ui-pause] 暂停芯片 → paused，zones 保持 [0,0] ✓');

// 4d：暂停面板「继续」→ 恢复比赛
dispatchPointer('pointerdown', 475, 374, { pointerId: 11 });   // 继续 (400..550, 342..390)
runFrames(8);
const phase4d = windowStub.__DBG__.phase;
if (phase4d !== 'countdown' && phase4d !== 'running') {
  console.log('  ✗ 点继续应恢复比赛，phase =', phase4d); process.exit(1);
}
dispatchPointer('pointerup', 475, 374, { pointerId: 11 });
runFrames(2);
console.log('[ui-resume] 暂停面板继续 → ' + phase4d + ' ✓');

// 4e：再暂停 → 「回标题」
dispatchPointer('pointerdown', 851, 46, { pointerId: 12 });
runFrames(8);
if (windowStub.__DBG__.phase !== 'paused') {
  console.log('  ✗ 再次暂停失败，phase =', windowStub.__DBG__.phase); process.exit(1);
}
dispatchPointer('pointerup', 851, 46, { pointerId: 12 });
runFrames(2);
dispatchPointer('pointerdown', 805, 374, { pointerId: 13 });   // 回标题 (730..880, 342..390)
runFrames(8);
if (windowStub.__DBG__.phase !== 'title') {
  console.log('  ✗ 点回标题应回 title，phase =', windowStub.__DBG__.phase); process.exit(1);
}
dispatchPointer('pointerup', 805, 374, { pointerId: 13 });
runFrames(2);
console.log('[ui-back] 暂停面板回标题 ✓');

// ---- 流程 5：反馈层音效（倒计时 beep / 按钮点击音）----
audioLog.length = 0;
pressKey('Escape'); runFrames(8);
dispatchPointer('pointerdown', 640, 536, { pointerId: 20 });   // 开始比赛
runFrames(8);
dispatchPointer('pointerup', 640, 536, { pointerId: 20 });
runFrames(210);   // 3.5s：覆盖 3/2/1 三档 + GO
const beeps = audioLog.filter(e => typeof e.t === 'number');
const low = beeps.filter(e => e.freq === 440).length;
const high = beeps.filter(e => e.freq === 990).length;
if (low < 3 || high < 1) {
  console.log('  ✗ 倒计时 beep 不全：440×' + low + '，990×' + high + '，全部=' + JSON.stringify(beeps)); process.exit(1);
}
console.log('[sfx-countdown] 3/2/1 低 beep ×' + low + ' + GO 高 beep ×' + high + ' ✓');

audioLog.length = 0;
dispatchPointer('pointerdown', 907, 46, { pointerId: 21 });    // 比赛中静音芯片
runFrames(4);
dispatchPointer('pointerup', 907, 46, { pointerId: 21 });
runFrames(2);
const ticks = audioLog.filter(e => typeof e.t === 'number' && e.freq === 1250).length;
if (ticks < 1) { console.log('  ✗ 芯片点击音缺失，audioLog=' + JSON.stringify(audioLog)); process.exit(1); }
pressKey('KeyM'); runFrames(2);   // 点芯片进入静音，M 恢复有声（同时验证键盘路径）
console.log('[sfx-click] 芯片点击音 ✓（并经 M 键恢复有声）');

console.log('启动模拟 ✓ 点击/键盘/开赛/屏上按钮/反馈音效全部流程通过');
