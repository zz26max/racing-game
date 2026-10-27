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
var now = 0;
// 最小 AudioContext 桩（真实浏览器里 resume/振荡器都可用，这里只保证不抛错）
class AudioContextStub {
  constructor() { this.currentTime = 0; this.sampleRate = 44100; this.destination = {}; this.state = 'running'; }
  resume() { return Promise.resolve(); }
  createGain() { return { connect: noop, disconnect: noop, gain: param() }; }
  createOscillator() { return { connect: noop, disconnect: noop, start: noop, stop: noop, type: '', frequency: param(), detune: param() }; }
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

// ---- 流程 0：点击右箭头切赛道 ----
runFrames(1);   // 先让标题画一帧，drawTitle 会记录箭头命中框
let hitX = -1;
for (let x = 700; x <= 1200; x += 4) {
  if (windowStub.RaceRender.hitTestTitleArrow(x, 368) === 'right') { hitX = x; break; }
}
if (hitX < 0) { console.log('  ✗ 未在标题里找到右箭头命中区（hitTestTitleArrow 全返回 null）'); process.exit(1); }
clickPage(hitX, 368);
runFrames(2);
console.log('[click] 右箭头 x=' + hitX + ' → slotrace.track =', store['slotrace.track']);
if (store['slotrace.track'] !== 'attic') { console.log('  ✗ 点击切换赛道失败'); process.exit(1); }

// ---- 流程 0b：整行半平面点击（名称右侧、非箭头精确框内）----
clickPage(900, 368);
runFrames(2);
console.log('[row-click] (900,368) →', store['slotrace.track']);
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
console.log('启动模拟 ✓ 点击/键盘/开赛全部流程通过');
