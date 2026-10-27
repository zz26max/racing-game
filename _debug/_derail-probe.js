/* 脱轨手感与归位可见性回归探针（多赛道版）
 * 用真实驾驶循环在每条赛道上连跑 20 次脱轨，量化：起跳是否嵌入护栏、甩出横向位移、
 * 飞行时长、落地回弹、单帧位移（瞬移）、归位目标是否落在桥下遮挡死角、归位跳段幅度、
 * 归位后状态是否干净。
 * 用法：node _debug/_derail-probe.js [all|figure8|attic]
 * 退出码：任一赛道有失败样本 → 1；全通过 → 0；未知赛道 id → 2。 */
'use strict';
globalThis.CANNON = require('../vendor/cannon.min.js');
var carMod = require('../js/car.js');
var trackMod = require('../js/track.js');
var fp = require('../js/flight-physics.js');

var DT = 1 / 120;
var CAR_HALF_W = 13;        // 车体 Box 半宽（飞行刚体）
var MAX_STEP_LIMIT = 14;    // 单帧最大位移（px）
var N = 20;                 // 每条赛道的有效样本目标数
var MOVE_WARN = 200;        // 归位跳段软警告阈值（px）

function finite(v) { return typeof v === 'number' && isFinite(v); }
function pad(v, w) { v = String(v); w = w || 7; while (v.length < w) v = ' ' + v; return v; }

// 归位目标 s 与脱轨 s 的最短弧差，落在 (-total/2, total/2]
function wrapDelta(d, total) {
  var h = total / 2;
  while (d > h) d -= total;
  while (d <= -h) d += total;
  return d;
}

// 跑一次脱轨样本：从 s0 全油门加速 → 脱轨 → 推进到完全归位
function runSample(track, railInner, idx) {
  var s0 = idx * track.totalLength / N;
  var car = carMod.createCar({ lane: 1, name: 'P' });
  car.s = s0;
  car.speed = Math.min(400, 40 + 18 * idx);
  var res = { idx: idx, ok: false, why: [] };
  var preSpeed = 0, derailS, side = 1, t = 0;
  var ox = 0, oz = 0, outX = 0, outZ = 0, tanX = 0, tanZ = 0, lat0 = 0, hasOrigin = false;
  var maxLatOut = 0, maxFwd = 0, maxStep = 0, maxVStep = 0;
  var lastX = 0, lastZ = 0, lastY = 0, prevY = 0, prevPrevY = 0;
  var rebounds = 0, maxRebound = 0, lowY = null, seenFloor = false;
  var phases = [], tFly = 0, tRest = 0, returnS = null, underDeck = null, tRestSeen = 0;
  var maxFrames = Math.round(6 / DT);
  var i;

  // 阶段一：加速到脱轨
  for (i = 0; i < maxFrames; i++) {
    var was = car.derailed;
    preSpeed = car.speed;
    carMod.update(car, DT, { throttle: 1 }, track);
    t += DT;
    if (!was && car.derailed) {
      derailS = car.s; side = Number(car.slideSide) || 1;
      var p0 = track.sampleAt(derailS);
      ox = car.worldX; oz = car.worldZ;
      tanX = p0.tx; tanZ = p0.ty;
      outX = tanZ * side; outZ = -tanX * side;         // 外法线 (ty,-tx)×side
      lat0 = (ox - p0.x) * -tanZ + (oz - p0.y) * tanX; // n=(-ty,tx) 方向的有符号坐标
      hasOrigin = true; lastX = ox; lastZ = oz; lastY = car.worldY;
      phases.push('fly'); i++; break;
    }
  }
  if (!hasOrigin) { res.why.push('6s 内未脱轨'); return res; }
  res.derailS = derailS; res.preSpeed = preSpeed; res.side = side;
  res.lat0 = lat0; res.outerEdge = Math.abs(lat0) + CAR_HALF_W;

  // 阶段二：推进到完全归位
  var startT = t;
  for (; i < maxFrames * 4; i++) {
    carMod.update(car, DT, { throttle: 1 }, track);
    t += DT;
    if (car.derailPhase && phases[phases.length - 1] !== car.derailPhase) phases.push(car.derailPhase);
    if (car.derailPhase === 'rest' && tFly === 0) tFly = t - startT;
    if (car.derailPhase === 'return') {
      if (returnS === null) {
        returnS = car.s;
        underDeck = (typeof carMod.slotUnderDeck === 'function') ? carMod.slotUnderDeck(track, returnS) : null;
      }
      if (!tRestSeen) { tRestSeen = 1; tRest = t - startT - tFly; }
    }
    var dx = car.worldX - lastX, dz = car.worldZ - lastZ;
    var stepH = Math.sqrt(dx * dx + dz * dz), stepV = Math.abs(car.worldY - lastY);
    if (stepH > maxStep) maxStep = stepH;
    if (stepV > maxVStep) maxVStep = stepV;
    lastX = car.worldX; lastZ = car.worldZ; lastY = car.worldY;
    if (car.derailPhase === 'fly') {
      var lat = (car.worldX - ox) * outX + (car.worldZ - oz) * outZ;
      var fwd = (car.worldX - ox) * tanX + (car.worldZ - oz) * tanZ;
      if (lat > maxLatOut) maxLatOut = lat;
      if (fwd > maxFwd) maxFwd = fwd;
      // 回弹：三帧局部极小记触底高度，随后的局部极大减触底高度即回弹量（只计 >3px）
      if (prevPrevY > prevY && car.worldY > prevY) { seenFloor = true; lowY = prevY; }
      else if (prevPrevY < prevY && car.worldY < prevY && seenFloor && lowY !== null) {
        var h = prevY - lowY;
        if (h > 3) { rebounds += 1; if (h > maxRebound) maxRebound = h; }
        lowY = null;
      }
      prevPrevY = prevY; prevY = car.worldY;
    }
    if (!car.derailed) break;
  }

  var dRet = (returnS === null) ? null : wrapDelta(returnS - derailS, track.totalLength);
  res.maxLatOut = maxLatOut; res.maxFwd = maxFwd; res.rebounds = rebounds; res.maxRebound = maxRebound;
  res.maxStep = maxStep; res.maxVStep = maxVStep;
  res.phases = phases; res.returnS = returnS; res.returnDelta = dRet;
  res.respawnMoved = dRet === null ? null : Math.abs(dRet);
  res.underDeck = underDeck; res.total = t - startT; res.tFly = tFly; res.tRest = tRest;
  res.derailed = car.derailed; res.offset = car.offset; res.worldActive = car.worldActive;
  res.nan = !(finite(car.worldX) && finite(car.worldY) && finite(car.worldZ) && finite(car.s) &&
    (car.quat === null || (finite(car.quat.x) && finite(car.quat.y) &&
      finite(car.quat.z) && finite(car.quat.w))));

  if (res.outerEdge > railInner + 0.05) res.why.push('起跳外沿 ' + res.outerEdge.toFixed(2) + ' > ' + railInner);
  if (maxStep > MAX_STEP_LIMIT) res.why.push('单帧位移 ' + maxStep.toFixed(1) + ' > ' + MAX_STEP_LIMIT);
  if (underDeck === true) res.why.push('归位目标在桥下死角 s=' + returnS);
  if (phases.join('>') !== 'fly>rest>return') res.why.push('阶段顺序 ' + phases.join('>'));
  if (car.derailed) res.why.push('4s 内未归位');
  if (res.nan) res.why.push('出现 NaN');
  if (car.derailed === false && (Math.abs(res.offset) > 1e-6 || car.worldActive)) res.why.push('归位后状态不干净');
  if (dRet !== null && Math.abs(dRet) > track.totalLength / 2) res.why.push('归位跳段异常 ' + dRet.toFixed(0));
  res.ok = res.why.length === 0;
  return res;
}

function stat(valid, key, fmt) {
  var vals = valid.map(function (r) { return r[key]; }).filter(function (v) { return typeof v === 'number'; });
  if (!vals.length) return '-';
  vals.sort(function (a, b) { return a - b; });
  var mean = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
  return 'min ' + vals[0].toFixed(fmt) + ' / 均值 ' + mean.toFixed(fmt) + ' / max ' + vals[vals.length - 1].toFixed(fmt);
}

// 跑一条赛道：独立 createTrack + 独立 flightHooks（避免跨赛道残留 world）
function runTrack(trackId) {
  var track = trackMod.createTrack(trackId);
  carMod.setFlightHooks(fp.create());
  var railInner = track.width / 2 + 3;   // 护栏内壁到中心线距离（halfW + 墙厚 3）
  console.log('=== 赛道 ' + track.id + '（' + track.name + '）total=' + track.totalLength.toFixed(1) +
    ' 护栏内壁=' + railInner + ' bridge.sCenter=' + (track.bridge ? track.bridge.sCenter.toFixed(1) : '-') +
    ' rampHalf=' + (track.bridge ? track.bridge.rampHalf : '-') + ' ===');
  var list = [], tried = 0;
  while (list.length < N && tried < 40) { list.push(runSample(track, railInner, tried)); tried++; }
  var valid = list.filter(function (r) { return r.derailS !== undefined; });
  var passes = 0, fails = [];
  console.log('idx   s0    v0   lat0  外沿  maxLatOut fwdMax 回弹 maxStep  阶段       retS   Δret  死角 总时长');
  list.forEach(function (r) {
    if (r.derailS === undefined) { console.log(pad(r.idx) + ' 未脱轨'); fails.push(r); return; }
    if (r.ok) passes++; else fails.push(r);
    var moved = (r.respawnMoved !== null && r.respawnMoved > MOVE_WARN) ? ' [跨段退出]' : '';
    console.log(pad(r.idx) + pad(r.derailS.toFixed(0)) + pad(r.preSpeed.toFixed(0)) + pad(r.lat0.toFixed(1)) +
      pad(r.outerEdge.toFixed(1)) + pad(r.maxLatOut.toFixed(1)) + pad(r.maxFwd.toFixed(0)) + pad(r.rebounds) +
      pad(r.maxStep.toFixed(1)) + ' ' + r.phases.join('>') +
      pad(r.returnS === null ? '-' : r.returnS.toFixed(0)) +
      pad(r.returnDelta === null ? '-' : (r.returnDelta > 0 ? '+' : '') + r.returnDelta.toFixed(0)) +
      pad(String(r.underDeck)) + pad(r.total.toFixed(2)) +
      (r.ok ? '' : '  << ' + r.why.join('; ')) + moved);
  });
  console.log('  有效 ' + valid.length + '｜通过 ' + passes + ' / 失败 ' + (list.length - passes));
  console.log('  起跳外沿（内壁 ' + railInner + '）：' + stat(valid, 'outerEdge', 2));
  console.log('  甩出横向位移 maxLatOut：' + stat(valid, 'maxLatOut', 1));
  console.log('  飞行 fly：' + stat(valid, 'tFly', 2) + 's ｜总时长：' + stat(valid, 'total', 2) + 's');
  console.log('  单帧最大位移：' + stat(valid, 'maxStep', 1) + 'px ｜竖直：' + stat(valid, 'maxVStep', 1) + 'px');
  console.log('  回弹（>3px）：' + stat(valid, 'rebounds', 0) + ' ｜最大回弹：' + stat(valid, 'maxRebound', 1) + 'px');
  console.log('  归位跳段 respawnMoved：' + stat(valid, 'respawnMoved', 1) + 'px');
  if (fails.length) console.log('  失败样本：' + fails.map(function (r) {
    return '#' + r.idx + '(' + (r.why.join('/') || '未脱轨') + ')';
  }).join(' '));
  console.log('');
  return { id: trackId, valid: valid.length, passes: passes, fails: fails.length };
}

var want = process.argv[2] || 'all';
var ids = trackMod.listTracks().map(function (t) { return t.id; });
if (want !== 'all') {
  if (ids.indexOf(want) < 0) { console.log('未知赛道 id: ' + want + '，可用：' + ids.join(', ')); process.exit(2); }
  ids = [want];
}
var summary = ids.map(runTrack);
console.log('总汇总：' + summary.map(function (s) {
  return s.id + ' ' + s.passes + '/' + (s.passes + s.fails) + ' 通过';
}).join('；'));
var anyFail = summary.some(function (s) { return s.fails > 0; });
process.exit(anyFail ? 1 : 0);
