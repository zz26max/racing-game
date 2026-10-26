/* 飞行物理验证（新版）：Node 下加载 cannon.min.js + flight-physics.js，
 * 校验：①桥面脱轨不再穿桥面 ②地面脱轨留在护栏走廊内 ③坡面承力板倾斜正确 ④翻滚幅度。
 * node _debug/_flight-probe.js */
'use strict';
globalThis.CANNON = require('../vendor/cannon.min.js');
var fp = require('../js/flight-physics.js');
var trackMod = require('../js/track.js');
var track = trackMod.createTrack();
var HALF_W = trackMod.width / 2;   // 42

if (!fp) { console.log('flight-physics 加载失败'); process.exit(1); }

// 距赛道中心线的横向偏移与最近弧长
function offCenter(x, z) {
  var s = track.nearestS(x, z);
  var p = track.sampleAt(s);
  return { s: s, off: Math.hypot(x - p.x, z - p.y) };
}

// 桥面足迹内（水平投影落在抬高段路面范围内）
function overDeck(x, z) {
  var c = offCenter(x, z);
  var d = Math.abs(c.s - track.bridge.sCenter);
  if (c.s > track.totalLength / 2) d = track.totalLength - d;   // 环形距离
  return { on: c.off < HALF_W + 6 && d < track.bridge.rampHalf, s: c.s, off: c.off, d: d };
}

function simulate(label, s0, speed, offsetVel) {
  var car = {
    lane: 1, s: s0, speed: speed, offsetVel: offsetVel || 0,
    flyVLat: 0, slideSide: 1, worldActive: false,
    worldX: 0, worldY: 0, worldZ: 0, quat: null
  };
  var sim = fp.create();
  sim.begin(car, track);

  var e0 = track.elevationAt(s0);
  var p0 = track.pointAt(s0, 1);
  var maxOff = 0, apexAbove = 0, sankBelowDeck = false, rot = 0, lastQ = car.quat;
  var t = 0, frames = 120 * 4;
  for (var i = 0; i < frames; i++) {
    sim.step(car, 1 / 120);
    t += 1 / 120;
    var od = overDeck(car.worldX, car.worldZ);
    maxOff = Math.max(maxOff, od.off);
    apexAbove = Math.max(apexAbove, car.worldY - (1 + track.elevationAt(od.s)));
    // 桥面/坡面在抬高段被穿透：投影在抬高段路面上方范围内，但中心已沉到该处路面 -3 以下
    var surf = 1 + track.elevationAt(od.s);
    if (od.on && od.off < HALF_W + 4 && track.elevationAt(od.s) > 2 && car.worldY < surf - 3) sankBelowDeck = true;
    if (car.quat && lastQ) rot += quaternionDelta(lastQ, car.quat);
    lastQ = car.quat;
    if (!car.worldActive) break;
  }
  var odEnd = overDeck(car.worldX, car.worldZ);
  console.log('=== ' + label + ' (s=' + s0 + ', v=' + speed + ', 侧滑=' + (offsetVel || 0) + ', 起始elev=' + e0.toFixed(0) + ') ===');
  console.log('  飞行时长: ' + t.toFixed(2) + 's（worldActive=' + car.worldActive + '）');
  console.log('  离中心线最远: ' + maxOff.toFixed(0) + 'px（护栏在 ' + (HALF_W + 3) + '~' + (HALF_W + 6) + 'px）');
  console.log('  相对路面最大爬升: ' + apexAbove.toFixed(1) + 'px');
  console.log('  穿入抬高段路面下方: ' + (sankBelowDeck ? '是 ←— 穿模！' : '否'));
  console.log('  累计翻滚角: ' + (rot / Math.PI * 180 / 360).toFixed(2) + ' 圈');
  console.log('  结束位置: 中心线偏移 ' + odEnd.off.toFixed(0) + 'px, y=' + car.worldY.toFixed(1) + ', 该处路面 y=' + (1 + track.elevationAt(odEnd.s)).toFixed(1));
  console.log('');
}

// 四元数夹角（rad）
function quaternionDelta(a, b) {
  var d = Math.abs(a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z);
  if (d > 1) d = 1;
  return 2 * Math.acos(d);
}

simulate('桥面中央脱轨', 0, 350, 120);
simulate('桥面低中速脱轨', 30, 200, 70);
simulate('引桥坡面脱轨', 120, 300, 100);
simulate('地面弯道脱轨', 600, 350, 120);
simulate('地面低速脱轨', 600, 180, 60);
simulate('桥下穿越段脱轨(s=1256,隐形死角)', 1256, 300, 100);
