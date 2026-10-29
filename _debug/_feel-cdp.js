/* 真机体感探针：用本机 Chrome（headless CDP）实际跑游戏，采集帧率 / 脱轨时序 / 震动 / 圈速。
 * 用法（先在仓库根目录起静态服务器：node -e "…listen(8123)" 或 npx serve .）：
 *   node _debug/_feel-cdp.js baseline [attic|figure8] [秒数]     全油门基线
 *   node _debug/_feel-cdp.js auto     [attic|figure8] [秒数]     页面内自动驾驶（松油过弯）验证零脱轨
 *   node _debug/_feel-cdp.js snap     [attic|figure8] ff1,ff2..  冻帧截图（?ff=&freeze=1）
 * 输出：_debug/feel-<mode>.json + _debug/feel-snap-*.jpg
 * 环境变量：CHROME_PATH 覆盖浏览器路径；BASE_URL 覆盖静态服务器地址；CDP_PORT 覆盖调试端口。 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const CDP_PORT = Number(process.env.CDP_PORT) || 9223;
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8123';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHttp(url, tries) {
  for (let i = 0; i < (tries || 60); i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch (e) { /* 还没起来 */ }
    await sleep(150);
  }
  throw new Error('devtools 未就绪: ' + url);
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect failed: ' + wsUrl)); });
    const c = new Cdp(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && c.pending.has(msg.id)) {
        const p = c.pending.get(msg.id);
        c.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.method + ' ' + msg.error.message));
        else p.resolve(msg.result);
      } else if (msg.method) {
        const hs = c.handlers.get(msg.method) || [];
        for (const h of hs) h(msg.params);
      }
    };
    return c;
  }
  on(method, cb) {
    const a = this.handlers.get(method) || [];
    a.push(cb);
    this.handlers.set(method, a);
  }
  send(method, params) {
    const id = ++this.id;
    const p = new Promise((res, rej) => this.pending.set(id, { resolve: res, reject: rej }));
    this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    return p;
  }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

// 注入到页面的探针：捕获 race / gl 实例，逐帧采样，提供驾驶辅助与汇总
const PROBE_SRC = `(function () {
  if (window.__PROBE__) return;
  var S = window.__PROBE__ = { race: null, gl: null, shake: [], frames: [], hookErr: [] };
  function hook(name, fn) {
    var val;
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        get: function () { return val; },
        set: function (v) { val = v; try { fn(v); } catch (e) { S.hookErr.push('set ' + name + ': ' + (e && e.stack || e)); } }
      });
    } catch (e) { S.hookErr.push('define ' + name + ': ' + e); }
  }
  hook('RaceRace', function (v) {
    if (!v || v.__probed || typeof v.createRace !== 'function') return;
    v.__probed = 1;
    var o = v.createRace;
    v.createRace = function () { var r = o.apply(this, arguments); S.race = r; return r; };
  });
  hook('RaceGL', function (v) {
    if (!v || v.__probed || typeof v.create !== 'function') return;
    v.__probed = 1;
    var o = v.create;
    v.create = function () {
      var g = o.apply(this, arguments);
      S.gl = g;
      if (g && typeof g.shake === 'function') {
        var os = g.shake;
        g.shake = function (p) { S.shake.push([Math.round(performance.now()), p]); return os.apply(this, arguments); };
      }
      return g;
    };
  });
  var last = 0;
  function sample(now) {
    var dt = last ? (now - last) : 0;
    last = now;
    if (S.race && S.race.entries) {
      var row = { t: +(now / 1000).toFixed(2), dt: +dt.toFixed(1), ph: S.race.phase, el: +(S.race.elapsed || 0).toFixed(2), cars: [], cam: null };
      for (var i = 0; i < S.race.entries.length; i++) {
        var e = S.race.entries[i], c = e && e.car;
        if (!c) { row.cars.push(null); continue; }
        row.cars.push({
          sp: Math.round(c.speed || 0), th: +(c.throttle || 0).toFixed(2), sl: +(c.slip || 0).toFixed(2),
          gu: +(c.gripUse || 0).toFixed(2), de: !!c.derailed, dtm: +(c.derailT || 0).toFixed(2),
          of: Math.round(c.offset || 0), lap: e.lap, sv: !!c.saveWindow
        });
      }
      if (S.gl && S.gl.camera) row.cam = [+S.gl.camera.position.x.toFixed(2), +S.gl.camera.position.y.toFixed(2), +S.gl.camera.position.z.toFixed(2)];
      S.frames.push(row);
      if (S.frames.length > 40000) S.frames.shift();
    }
    requestAnimationFrame(sample);
  }
  requestAnimationFrame(sample);

  window.__KEY = function (code, down) {
    var key = code === 'KeyW' ? 'w' : code === 'Space' ? ' ' : code === 'ArrowUp' ? 'ArrowUp' : code;
    window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code: code, key: key, bubbles: true }));
  };

  // 页面内自动驾驶：按前方曲率估计允许速度，提前收油（模拟"收油过弯"的熟练玩家）
  var AUTO = window.__AUTO__ = { on: false, keys: [false, false], lifts: 0 };
  function setKey(ci, on) {
    if (AUTO.keys[ci] === on) return;
    AUTO.keys[ci] = on;
    if (!on) AUTO.lifts++;
    window.__KEY(ci === 0 ? 'Space' : 'ArrowUp', on);
  }
  function autoLoop() {
    var S2 = window.__PROBE__;
    if (AUTO.on && S2.race) {
      var running = S2.race.phase === 'running';
      for (var ci = 0; ci < 2; ci++) {
        var e = S2.race.entries[ci], c = e && e.car, tk = S2.race.track;
        var on = false;
        if (running && c && !c.derailed && tk && typeof tk.curvatureAt === 'function') {
          var sp = Number(c.speed) || 0;
          // 沿前方按刹停距离采样曲率：v² = vCorner² + 2a·d（无刹车键，松油减速 240 px/s²）
          var horizon = 60 + sp * sp / 480 * 1.25 + sp * 0.1;
          var vMax = Infinity;
          for (var j = 0; j <= 10; j++) {
            var d = horizon * j / 10;
            var kk = Math.abs(tk.curvatureAt((Number(c.s) || 0) + d));
            var vCorner = Math.sqrt(950 * 0.8 / Math.max(kk, 1e-9));
            var vHere = Math.sqrt(vCorner * vCorner + 480 * d);
            if (vHere < vMax) vMax = vHere;
          }
          on = sp < vMax && (Number(c.gripUse) || 0) < 0.88 && (Number(c.slip) || 0) < 0.05;
        }
        setKey(ci, !!on);
      }
    } else if (AUTO.on) {
      setKey(0, false);
      setKey(1, false);
    }
    requestAnimationFrame(autoLoop);
  }
  requestAnimationFrame(autoLoop);

  // 收油阈值实验：gripUse 达到阈值才松油，看"黄区收油 / 红区收油"是否救得回来
  var LIFT = window.__LIFTBOT__ = { on: false, threshold: 1.0, keys: [false, false], lifting: [false, false], lifts: 0 };
  function liftSetKey(ci, on) {
    if (LIFT.keys[ci] === on) return;
    LIFT.keys[ci] = on;
    if (!on) LIFT.lifts++;
    window.__KEY(ci === 0 ? 'Space' : 'ArrowUp', on);
  }
  function liftLoop() {
    var S2 = window.__PROBE__;
    if (LIFT.on && S2.race) {
      for (var ci = 0; ci < 2; ci++) {
        var e = S2.race.entries[ci], c = e && e.car;
        var on = false;
        if (S2.race.phase === 'running' && c) {
          if (c.derailed) LIFT.lifting[ci] = false;
          else if (!LIFT.lifting[ci] && (Number(c.gripUse) || 0) >= LIFT.threshold) LIFT.lifting[ci] = true;
          else if (LIFT.lifting[ci] && (Number(c.gripUse) || 0) < 0.55 && (Number(c.speed) || 0) < 230) LIFT.lifting[ci] = false;
          on = !LIFT.lifting[ci];
        }
        liftSetKey(ci, !!on);
      }
    }
    requestAnimationFrame(liftLoop);
  }
  requestAnimationFrame(liftLoop);

  window.__PROBE_ANALYZE__ = function () {
    var S3 = window.__PROBE__;
    var all = S3.frames;
    var running = [];
    for (var i = 0; i < all.length; i++) if (all[i].ph === 'running') running.push(all[i]);
    var dts = [];
    var sum = 0, maxDt = 0, slow = 0;
    for (i = 0; i < running.length; i++) {
      var d = running[i].dt;
      if (d > 0) { dts.push(d); sum += d; if (d > maxDt) maxDt = d; if (d > 33.4) slow++; }
    }
    var sorted = dts.slice().sort(function (a, b) { return a - b; });
    var p95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0;
    var fps = dts.length ? 1000 / (sum / dts.length) : 0;

    var events = [], carsOut = [];
    for (var ci = 0; ci < 2; ci++) {
      var de = false, start = null, maxSlip = 0, maxOff = 0, prevC = null;
      var speeds = [], slipPeak = 0, guPeak = 0, overT = null, yellowT = null, warnLead = null, warnLeadYellow = null;
      for (var k = 0; k < running.length; k++) {
        var c = running[k].cars[ci];
        if (!c) continue;
        speeds.push(c.sp);
        if (c.sl > slipPeak) slipPeak = c.sl;
        if (c.gu > guPeak) guPeak = c.gu;
        // 超限起点：gripUse 首次 >= 1（红区）/ >= 0.55（黄区）——收油窗口的起点
        if (!c.de && c.gu >= 1 && overT === null) overT = running[k].t;
        if (!c.de && c.gu >= 0.55 && yellowT === null) yellowT = running[k].t;
        if (!c.de && c.gu < 0.98) overT = null;
        if (!c.de && c.gu < 0.5) yellowT = null;
        if (c.de && !de) {
          start = { t: running[k].t, el: running[k].el, sp: prevC ? prevC.sp : c.sp, sl: (prevC ? prevC.sl : c.sl), of: (prevC ? prevC.of : c.of), lap: c.lap };
          warnLead = overT !== null ? +(start.t - overT).toFixed(2) : null;
          warnLeadYellow = yellowT !== null ? +(start.t - yellowT).toFixed(2) : null;
          overT = null; yellowT = null;
          de = true; maxSlip = start.sl; maxOff = start.of;
        }
        else if (c.de) { if (c.sl > maxSlip) maxSlip = c.sl; if (Math.abs(c.of) > Math.abs(maxOff)) maxOff = c.of; }
        else if (de) {
          events.push({ car: ci, tStart: start.t, elStart: start.el, tEnd: running[k].t, dur: +(running[k].t - start.t).toFixed(2), speedAtDerail: start.sp, slipMax: maxSlip, offsetMax: maxOff, lap: start.lap, warnLead: warnLead, warnLeadYellow: warnLeadYellow });
          de = false; start = null;
        }
        prevC = c;
      }
      if (de) events.push({ car: ci, tStart: start.t, elStart: start.el, dur: null, speedAtDerail: start.sp, slipMax: maxSlip, offsetMax: maxOff, lap: start.lap, warnLead: warnLead, warnLeadYellow: warnLeadYellow });
      var avg = 0;
      for (i = 0; i < speeds.length; i++) avg += speeds[i];
      carsOut.push({ speedAvg: speeds.length ? Math.round(avg / speeds.length) : 0, speedMax: speeds.length ? Math.max.apply(null, speeds) : 0, slipPeak: slipPeak, gripPeak: guPeak });
    }

    var laps = [];
    if (S3.race) {
      for (var l = 0; l < S3.race.entries.length; l++) {
        var en = S3.race.entries[l];
        var times = [];
        for (var q = 0; q < en.lapTimes.length; q++) times.push(+en.lapTimes[q].toFixed(2));
        laps.push({ car: l, lap: en.lap, times: times, finished: !!en.finished, finishTime: en.finishTime === null ? null : +en.finishTime.toFixed(2) });
      }
    }

    var shakeCalls = [];
    for (i = 0; i < S3.shake.length; i++) shakeCalls.push({ t: +(S3.shake[i][0] / 1000).toFixed(2), power: S3.shake[i][1] });

    var camDev = [], maxCam = 0;
    for (i = 0; i < all.length; i++) {
      var cam = all[i].cam;
      if (!cam) continue;
      var dx = cam[0], dy = cam[1] - 620, dz = cam[2] - 900;
      var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > maxCam) maxCam = dist;
      if (dist > 0.3 && camDev.length < 400) camDev.push({ t: all[i].t, d: +dist.toFixed(2) });
    }

    var webgl = 'none';
    try {
      var cv = document.getElementById('game');
      var g = cv && (cv.getContext('webgl') || cv.getContext('webgl2'));
      if (g) {
        var ext = g.getExtension('WEBGL_debug_renderer_info');
        webgl = ext ? g.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
      }
    } catch (err) { webgl = 'err'; }

    return {
      phase: S3.race ? S3.race.phase : null,
      elapsed: S3.race ? +S3.race.elapsed.toFixed(2) : 0,
      fps: +fps.toFixed(1), p95: +p95.toFixed(1), maxDt: +maxDt.toFixed(1), slowFrames: slow, frames: running.length,
      events: events, cars: carsOut, laps: laps,
      shakeCalls: shakeCalls, maxCamDev: +maxCam.toFixed(2), camDevSamples: camDev.slice(0, 400),
      autoLifts: AUTO.lifts,
      liftLifts: LIFT.lifts, liftThreshold: LIFT.threshold,
      hookErr: S3.hookErr, errors: (window.__ERRORS__ || []).slice(0, 5),
      glError: (window.__DBG__ && window.__DBG__.glError) || null, webgl: webgl,
      build: 'v19'
    };
  };
})();`;

async function launchChrome() {
  const profile = path.join(os.tmpdir(), 'slotrace-feel-' + process.pid);
  const args = [
    '--headless=new',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
    '--window-size=1280,720', '--hide-scrollbars', '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--enable-gpu', '--use-angle=d3d11',
    'about:blank'
  ];
  const child = spawn(CHROME, args, { stdio: 'ignore' });
  child.on('error', (e) => console.error('[chrome] ' + e.message));
  await waitHttp('http://127.0.0.1:' + CDP_PORT + '/json/version', 80);
  const list = await waitHttp('http://127.0.0.1:' + CDP_PORT + '/json/list', 20);
  const page = (list || []).find((t) => t.type === 'page');
  if (!page) throw new Error('没有 page target');
  return { child, page };
}

async function evalJs(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    const ex = r.exceptionDetails.exception;
    throw new Error('page eval: ' + r.exceptionDetails.text + ' ' + ((ex && ex.description) || ''));
  }
  return r.result ? r.result.value : undefined;
}

async function waitPhase(cdp, phases, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    let ph = null;
    try { ph = await evalJs(cdp, 'window.__PROBE__ && window.__PROBE__.race ? window.__PROBE__.race.phase : null'); } catch (e) { /* 页面还没加载完 */ }
    if (ph && phases.indexOf(ph) >= 0) return ph;
    await sleep(120);
  }
  throw new Error('等待阶段 ' + phases.join('/') + ' 超时');
}

async function key(cdp, code, down) {
  const map = { KeyW: 87, Space: 32, ArrowUp: 38 };
  await cdp.send('Input.dispatchKeyEvent', {
    type: down ? 'keyDown' : 'keyUp',
    code: code,
    key: code === 'KeyW' ? 'w' : code === 'Space' ? ' ' : code === 'ArrowUp' ? 'ArrowUp' : code,
    windowsVirtualKeyCode: map[code] || 0,
    nativeVirtualKeyCode: map[code] || 0
  });
}

async function shot(cdp, file, clip) {
  const params = { format: 'jpeg', quality: 82 };
  if (clip) params.clip = clip;
  const r = await cdp.send('Page.captureScreenshot', params);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
}

// 车在屏幕上的位置（供局部放大截图取景）：优先用车模 Group 的真实位置
const CAR_SCREEN_POS = `(function () {
  var S = window.__PROBE__, cam = S && S.gl && S.gl.camera;
  if (!S || !cam || !window.THREE) return null;
  var carG = null;
  var kids = (S.gl.scene && S.gl.scene.children) || [];
  for (var i = 0; i < kids.length; i++) {
    var o = kids[i];
    if (o && o.userData && o.userData.wheels) { carG = o; break; }
  }
  var x = 0, y = 10, z = 0;
  if (carG) { x = carG.position.x; y = carG.position.y + 9; z = carG.position.z; }
  else if (S.race && S.race.entries) {
    var car = S.race.entries[0].car, p = S.race.track.pointAt(car.s, car.lane);
    x = p.x; y = 12; z = p.y;
  }
  var v = new THREE.Vector3(x, y, z); v.project(cam);
  var rect = document.getElementById('game').getBoundingClientRect();
  return {
    sx: rect.left + (v.x * 0.5 + 0.5) * rect.width,
    sy: rect.top + (-v.y * 0.5 + 0.5) * rect.height,
    ndcZ: v.z, w: rect.width, h: rect.height
  };
})()`;

async function waitDocument(cdp) {
  for (let i = 0; i < 80; i++) {
    try {
      const st = await evalJs(cdp, 'document.readyState');
      if (st === 'complete') return;
    } catch (e) { /* ignore */ }
    await sleep(100);
  }
}

async function main() {
  const mode = process.argv[2] || 'baseline';
  const track = process.argv[3] || 'attic';
  const arg4 = process.argv[4];
  const { child, page } = await launchChrome();
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  const cleanup = () => { try { cdp.close(); } catch (e) { /* ignore */ } try { child.kill(); } catch (e) { /* ignore */ } };
  process.on('exit', cleanup);
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE_SRC });

    if (mode === 'inspect') {
      // 车模零件体检：把车 Group 复位到原点/无旋转，打印每个子件的局部包围盒
      const ff = Number(arg4 || 1);
      await cdp.send('Page.navigate', { url: BASE + '/index.html?demo=1&track=' + track + '&ff=' + ff + '&freeze=1' });
      await waitDocument(cdp);
      await sleep(700);
      const info = await evalJs(cdp, `(function(){
        var S = window.__PROBE__;
        if (!S || !S.gl) return { err: 'no gl' };
        var cars = S.gl.scene.children.filter(function (o) { return o.userData && o.userData.wheels; });
        if (!cars.length) return { err: 'no car' };
        var c = cars[0];
        var keepP = c.position.clone(), keepR = c.rotation.clone(), keepS = c.scale.clone();
        c.position.set(0, 0, 0); c.rotation.set(0, 0, 0); c.scale.set(1, 1, 1);
        c.updateMatrixWorld(true);
        var box = new THREE.Box3(), sz = new THREE.Vector3();
        var out = [];
        c.children.forEach(function (o, i) {
          box.setFromObject(o); box.getSize(sz);
          out.push({
            i: i, type: o.type,
            geo: o.geometry ? o.geometry.type : null,
            color: (o.material && o.material.color) ? '#' + o.material.color.getHexString() : null,
            map: !!(o.material && o.material.map),
            min: [ +box.min.x.toFixed(2), +box.min.y.toFixed(2), +box.min.z.toFixed(2) ],
            max: [ +box.max.x.toFixed(2), +box.max.y.toFixed(2), +box.max.z.toFixed(2) ],
            size: [ +sz.x.toFixed(2), +sz.y.toFixed(2), +sz.z.toFixed(2) ]
          });
        });
        c.position.copy(keepP); c.rotation.copy(keepR); c.scale.copy(keepS); c.updateMatrixWorld(true);
        return { n: c.children.length, children: out };
      })()`);
      console.log(JSON.stringify(info));
      return;
    }

    if (mode === 'beauty') {
      // 车模检视：冻结比赛后换成诊断相机，绕 P1 拍俯视 / 前 3/4 / 侧后 3/4
      const ff = Number(arg4 || 1);
      await cdp.send('Page.navigate', { url: BASE + '/index.html?demo=1&track=' + track + '&ff=' + ff + '&freeze=1' });
      await waitDocument(cdp);
      await sleep(700);
      const onlyView = process.env.VIEW || '';
      const views = [
        { name: 'side', dx: 2, dy: 26, dz: 108 },
        { name: 'front', dx: 92, dy: 30, dz: 62 },
        { name: 'rear', dx: -92, dy: 30, dz: 62 },
        { name: 'top', dx: 26, dy: 96, dz: 52 }
      ].filter((v) => !onlyView || v.name === onlyView);
      for (const v of views) {
        await evalJs(cdp, `(function(){
          var S = window.__PROBE__, gl = S.gl;
          var cars = gl.scene.children.filter(function (o) { return o.userData && o.userData.wheels; });
          var car = cars[0];
          var p = car ? car.position.clone() : new THREE.Vector3(0, 10, 0);
          var yaw = car ? car.rotation.y : 0;
          // 车头是 +X：把相机偏移旋到车体坐标系，换赛道/朝向也能拍同一角度
          window.__BEAUTY__ = { p: p, yaw: yaw, dx: ${v.dx}, dy: ${v.dy}, dz: ${v.dz} };
          if (!window.__BEAUTY_ON__) {
            window.__BEAUTY_ON__ = true;
            gl.render = function () {
              var b = window.__BEAUTY__, q = b.p;
              var c = Math.cos(b.yaw), s = Math.sin(b.yaw);
              var ox = b.dx * c + b.dz * s;
              var oz = -b.dx * s + b.dz * c;
              gl.camera.position.set(q.x + ox, q.y + b.dy, q.z + oz);
              gl.camera.lookAt(q.x, q.y + 7, q.z);
              gl.renderer.render(gl.scene, gl.camera);
            };
          }
          return 1;
        })()`);
        await sleep(250);
        const file = path.join(__dirname, 'feel-car-' + track + '-' + v.name + '.jpg');
        let clip;
        const pos = await evalJs(cdp, CAR_SCREEN_POS);
        if (pos && isFinite(pos.sx)) {
          const cw = Number(process.env.CLIP_W || 520), ch = Number(process.env.CLIP_H || 400);
          const ox = Number(process.env.CLIP_DX || 0), oy = Number(process.env.CLIP_DY || 0);
          clip = {
            x: Math.max(0, Math.min(pos.w - cw, pos.sx + ox - cw / 2)),
            y: Math.max(0, Math.min(pos.h - ch, pos.sy + oy - ch / 2)),
            width: cw, height: ch, scale: Number(process.env.CLIP_SCALE || 2)
          };
        }
        await shot(cdp, file, clip);
        console.log('beauty ' + v.name + ' -> ' + path.basename(file));
      }
      return;
    }

    if (mode === 'snap') {
      const ffs = (arg4 || '2').split(',').map(Number).filter((v) => v > 0);
      const live = process.env.LIVE === '1';   // 不冻帧：让尾迹按真实 dt 生长，截图才代表实机观感
      for (const ff of ffs) {
        await cdp.send('Page.navigate', { url: BASE + '/index.html?demo=1&track=' + track + '&ff=' + ff + (live ? '' : '&freeze=1') });
        await waitDocument(cdp);
        if (live) {
          // 实机观感截图：保持双车全油门，否则松油后尾迹消失
          await evalJs(cdp, "(window.__KEY('Space', true), window.__KEY('ArrowUp', true), 1)");
        }
        await sleep(live ? Number(process.env.LIVE_MS || 900) : 700);
        if (process.env.DUST_TINT === '1') {
          // 诊断：把尾迹染成品红并关闭深度测试，一眼看出"有没有渲染、渲染在哪"
          await evalJs(cdp, `(function () {
            var S = window.__PROBE__;
            S.gl.scene.traverse(function (o) {
              if (o.geometry && o.geometry.type === 'CircleGeometry') {
                o.material.color.setHex(0xff00ff); o.material.depthTest = false; o.renderOrder = 999;
                if (${process.env.DUST_SOLID === '1'}) { o.material.transparent = false; o.material.opacity = 1; o.material.needsUpdate = true; }
              }
            });
            return 1;
          })()`);
          await sleep(150);
        }
        const state = await evalJs(cdp, '(function(){var S=window.__PROBE__,r=S&&S.race;if(!r)return null;var tk=S.gl&&S.gl.track;var cars=S.gl&&S.gl.scene&&S.gl.scene.children.filter(function(o){return o.type==="Group"&&o.userData&&o.userData.wheels&&o.userData.wheels.length});return {phase:r.phase,elapsed:+r.elapsed.toFixed(2),cars:r.entries.map(function(e,i){var c=e.car,g=cars&&cars[i];return {speed:Math.round(c.speed||0),derailed:!!c.derailed,derailT:+(c.derailT||0).toFixed(2),slip:+(c.slip||0).toFixed(2),gripUse:+(c.gripUse||0).toFixed(2),offset:Math.round(c.offset||0),s:+((c.s||0).toFixed(1)),elev:+(tk&&tk.elevationAt?(tk.elevationAt(c.s)||0).toFixed(1):0),slope:+(tk&&tk.slopeAt?(tk.slopeAt(c.s)||0).toFixed(3):0),rotZ:g?+(g.rotation.z.toFixed(3)):null,posY:g?+(g.position.y.toFixed(1)):null}})}})()');
        const file = path.join(__dirname, 'feel-snap-' + track + '-' + String(ff).replace('.', 'p') + '.jpg');
        await shot(cdp, file);
        const pos = await evalJs(cdp, CAR_SCREEN_POS);
        if (pos && isFinite(pos.sx)) {
          const cw = Number(process.env.CLIP_W || 440), ch = Number(process.env.CLIP_H || 280);
          const clip = {
            x: Math.max(0, Math.min(pos.w - cw, pos.sx - cw / 2)),
            y: Math.max(0, Math.min(pos.h - ch, pos.sy - ch / 2)),
            width: cw, height: ch, scale: Number(process.env.CLIP_SCALE || 2.5)
          };
          const zfile = path.join(__dirname, 'feel-zoom-' + track + '-' + String(ff).replace('.', 'p') + '.jpg');
          await shot(cdp, zfile, clip);
        }
        console.log('snap ff=' + ff + ' -> ' + path.basename(file) + '  ' + JSON.stringify(state));
        if (process.env.DUST_DEBUG === '1') {
          const dust = await evalJs(cdp, `(function () {
            var S = window.__PROBE__, out = [], cam = S.gl.camera;
            var rect = document.getElementById('game').getBoundingClientRect();
            S.gl.scene.traverse(function (o) {
              if (o.geometry && o.geometry.type === 'CircleGeometry') {
                var v = new THREE.Vector3(o.position.x, o.position.y, o.position.z);
                v.project(cam);
                out.push({
                  v: o.visible, op: +(o.material.opacity || 0).toFixed(3), y: +o.position.y.toFixed(2),
                  x: +o.position.x.toFixed(1), z: +o.position.z.toFixed(1), sc: +o.scale.x.toFixed(2),
                  col: o.material.color.getHexString(), dt: o.material.depthTest,
                  sx: Math.round(rect.left + (v.x * 0.5 + 0.5) * rect.width),
                  sy: Math.round(rect.top + (-v.y * 0.5 + 0.5) * rect.height)
                });
              }
            });
            return out.slice(0, 12);
          })()`);
          console.log('dust:' + JSON.stringify(dust));
        }
      }
      return;
    }

    const seconds = Number(arg4) || (mode === 'auto' || mode === 'lift' ? 100 : 12);
    await cdp.send('Page.navigate', { url: BASE + '/index.html?demo=1&track=' + track });
    await waitDocument(cdp);
    await waitPhase(cdp, ['running'], 15000);

    if (mode === 'auto' || mode === 'lift') {
      if (mode === 'auto') {
        await evalJs(cdp, 'window.__AUTO__.on = true');
      } else {
        const thr = Number(process.argv[5]) || 1.0;
        await evalJs(cdp, 'window.__LIFTBOT__.threshold = ' + thr + '; window.__LIFTBOT__.on = true');
      }
      const t0 = Date.now();
      while (Date.now() - t0 < seconds * 1000) {
        const ph = await evalJs(cdp, 'window.__PROBE__.race.phase');
        if (ph === 'finished') break;
        await sleep(400);
      }
      await evalJs(cdp, 'window.__AUTO__.on = false; window.__LIFTBOT__.on = false');
      await sleep(100);
    } else {
      await key(cdp, 'KeyW', true);
      await key(cdp, 'ArrowUp', true);
      await sleep(seconds * 1000);
      await key(cdp, 'KeyW', false);
      await key(cdp, 'ArrowUp', false);
      await sleep(120);
    }

    const raw = await evalJs(cdp, 'JSON.stringify(window.__PROBE_ANALYZE__())');
    const data = JSON.parse(raw);
    const out = path.join(__dirname, 'feel-' + mode + '-' + track + '.json');
    fs.writeFileSync(out, JSON.stringify(data, null, 2));
    console.log(JSON.stringify(data, null, 2));
    console.log('\n写入 ' + out);
  } finally {
    cleanup();
  }
}

main().catch((e) => {
  console.error('[feel-cdp] ' + (e && e.stack || e));
  process.exitCode = 1;
});
