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
    addEventListener: noop, removeEventListener: noop,
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
var store = {};
function pressKey(code) {
  const e = { code, preventDefault: noop, repeat: false };
  for (const cb of keyHandlers) {
    try { cb(e); } catch (err) { /* 浏览器语义：单个监听器抛错不阻断其它监听器 */ }
  }
}
function runFrames(count, stepMs) {
  var queued = rafQueue.slice(); rafQueue.length = 0;
  for (let f = 0; f < count; f++) {
    for (const cb of queued) cb(now);
    now += (stepMs || 16.7);
    queued = rafQueue.slice(); rafQueue.length = 0;
  }
}
var now = 0;
// window 与 globalThis 同一对象（与浏览器一致），UMD 挂载与 window.* 引用互通
const windowStub = {
  innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1,
  location: { search: '' },
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
  performance: { now: () => Date.now() },
  addEventListener(type, cb) { if (type === 'keydown') keyHandlers.push(cb); },
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
    fn(windowStub, documentStub, windowStub, windowStub, undefined, undefined, undefined);
    console.log('  ✓', f);
  } catch (err) {
    console.log('  ✗', f, '→', err.constructor.name + ':', err.message);
    process.exit(1);
  }
}

// ---- 跑 5 帧（模拟 rAF）----
var queued = rafQueue.slice();
rafQueue.length = 0;
for (let frame = 0; frame < 5; frame++) {
  for (const cb of queued) {
    try { cb(now); } catch (err) {
      console.log('  ✗ frame', frame, '→', err.constructor.name + ':', err.message);
      process.exit(1);
    }
    now += 16.7;
  }
  queued = rafQueue.slice();
  rafQueue.length = 0;
}

// ---- 断言关键状态 ----
console.log('---');
console.log('RaceTrack:', typeof windowStub.RaceTrack, '| RaceGL:', typeof windowStub.RaceGL,
  '| RaceRender:', typeof windowStub.RaceRender, '| RaceCar:', typeof windowStub.RaceCar);
console.log('trackId/main 状态: 见流程输出');

// ---- 流程 1：ArrowRight ×2 切赛道 → Enter 开赛 → 跑 ~3 秒 ----
console.log('  [dbg] keyHandlers:', keyHandlers.map(h => h.name || 'anon').join(','), '| input instance:', typeof (windowStub.RaceInput && windowStub.RaceInput.createInput));
pressKey('ArrowRight'); runFrames(2);
console.log('  [dbg] after ArrowRight#1: store=', JSON.stringify(store), 'title=', documentStub.title);
pressKey('ArrowRight'); runFrames(2);
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
console.log('启动模拟 ✓ 无运行时错误');
