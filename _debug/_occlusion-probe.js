/* 遮挡验证：从固定相机 (0,620,900) 向桥下赛道的车身包围盒角点发射线，
 * 检测是否被桥面（路面抬高段）/ 黄护栏 / 桥墩遮挡。Node 直接跑：node _debug/_occlusion-probe.js */
'use strict';
var trackMod = require('../js/track.js');
var track = trackMod.createTrack();
var HALF_W = trackMod.width / 2;   // 42

// ---- 基础几何 ----
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function norm(a) { var l = Math.sqrt(dot(a, a)); return [a[0] / l, a[1] / l, a[2] / l]; }

// Möller–Trumbore：射线与三角形相交，命中返回 t>eps
function rayTri(o, d, v0, v1, v2) {
  var e1 = sub(v1, v0), e2 = sub(v2, v0);
  var p = cross(d, e2);
  var det = dot(e1, p);
  if (det > -1e-9 && det < 1e-9) return -1;
  var inv = 1 / det;
  var t = sub(o, v0);
  var u = dot(t, p) * inv;
  if (u < 0 || u > 1) return -1;
  var q = cross(t, e1);
  var v = dot(d, q) * inv;
  if (v < 0 || u + v > 1) return -1;
  var tt = dot(e2, q) * inv;
  return tt > 0.01 ? tt : -1;
}

var tris = [];   // 所有遮挡三角形（世界坐标 X=x, Y=up, Z=y）
function addQuad(a, b, c, d) { tris.push([a, b, c], [a, c, d]); }

// ---- 1. 桥面：gl.js buildSurface 的路面抬高段（s ∈ [-260, 260]，y = 1 + elev）----
(function () {
  var prev = null;
  for (var s = -260; s <= 260; s += 4) {
    var p = track.sampleAt(s);
    var e = 1 + track.elevationAt(s);
    if (e <= 1.0001 && Math.abs(s) > 10) { prev = null; continue; }  // 只保留抬高段
    var nx = -p.ty, nz = p.tx;
    var cur = {
      L: [p.x + nx * HALF_W, e, p.y + nz * HALF_W],
      R: [p.x - nx * HALF_W, e, p.y - nz * HALF_W]
    };
    if (prev) addQuad(prev.L, cur.L, cur.R, prev.R);
    prev = cur;
  }
})();

// ---- 2. 黄护栏：gl.js buildBridge，s ∈ [-70,70] 每 5px，偏移 ±44，3 宽 16 高 ----
(function () {
  var WALL_THICK = 3, WALL_H = 16, RAIL_GAP = 2;
  var sides = [1, -1];
  for (var si = 0; si < sides.length; si++) {
    for (var s = -70; s < 70; s += 5) {
      var p0 = track.sampleAt(s), p1 = track.sampleAt(s + 5);
      var off0 = (HALF_W + RAIL_GAP) * sides[si], off1 = (HALF_W + RAIL_GAP + WALL_THICK) * sides[si];
      var y0 = 1 + track.elevationAt(s), y1 = y0 + WALL_H;
      function corner(pp, off, y) {
        return [pp.x - pp.ty * off, y, pp.y + pp.tx * off];
      }
      var a = corner(p0, off0, y0), b = corner(p1, off0, y0);
      var c = corner(p1, off1, y0), d = corner(p0, off1, y0);
      var a2 = [a[0], y1, a[2]], b2 = [b[0], y1, b[2]], c2 = [c[0], y1, c[2]], d2 = [d[0], y1, d[2]];
      addQuad(a, b, b2, a2);      // 内立面
      addQuad(d, c, c2, d2);      // 外立面
      addQuad(a2, b2, c2, d2);    // 顶面
    }
  }
})();

// ---- 3. 桥墩：s ∈ [-180,180] 每 60，±42 偏移，8×8 方柱 ----
(function () {
  for (var s = -180; s <= 180; s += 60) {
    var h = track.elevationAt(s);
    if (!(h > 0)) continue;
    var p = track.sampleAt(s);
    [1, -1].forEach(function (side) {
      var off = HALF_W * side;
      var cx = p.x - p.ty * off, cz = p.y + p.tx * off;
      var x0 = cx - 4, x1 = cx + 4, z0 = cz - 4, z1 = cz + 4;
      addQuad([x0, 0, z0], [x1, 0, z0], [x1, h, z0], [x0, h, z0]);
      addQuad([x0, 0, z1], [x1, 0, z1], [x1, h, z1], [x0, h, z1]);
      addQuad([x0, 0, z0], [x0, h, z0], [x0, h, z1], [x0, 0, z1]);
      addQuad([x1, 0, z0], [x1, h, z0], [x1, h, z1], [x1, 0, z1]);
    });
  }
})();

console.log('遮挡三角形数:', tris.length);

// ---- 相机与车包围盒可见性 ----
var CAM = [0, 620, 900];
function visibleFromCam(pt) {
  var dir = norm(sub(pt, CAM));
  for (var i = 0; i < tris.length; i++) {
    var t = rayTri(CAM, dir, tris[i][0], tris[i][1], tris[i][2]);
    if (t > 0) return false;   // 命中遮挡物
  }
  return true;
}

// 车身包围盒：44(长,沿切线) × 14(高) × 26(宽)，中心 y=8
function carCorners(s, lane) {
  var p = track.pointAt(s, lane);
  var t = track.sampleAt(s);
  var tx = t.tx, tz = t.ty;      // 世界 X=x, Z=y
  var nx = -tz, nz = tx;
  var cx = p.x, cz = p.y, cy = 8;
  var corners = [];
  [1, -1].forEach(function (su) {
    [1, -1].forEach(function (sv) {
      [1, -1].forEach(function (sy) {
        corners.push([
          cx + tx * 22 * su + nx * 13 * sv,
          cy + 7 * sy,
          cz + tz * 22 * su + nz * 13 * sv
        ]);
      });
    });
  });
  return corners;
}

// 找桥下穿越段：地面高度(elev≈0)且平面位置接近原点（自交点）的 s
var total = track.totalLength;
var underZone = [];
for (var s = 0; s < total; s += 4) {
  var e = track.elevationAt(s);
  var p = track.sampleAt(s);
  var r = Math.sqrt(p.x * p.x + p.y * p.y);
  if (e < 0.5 && r < 120) underZone.push(s);
}
console.log('桥下穿越段 s 范围: [' + underZone[0] + ', ' + underZone[underZone.length - 1] +
  ']（中心 ≈ ' + underZone[Math.floor(underZone.length / 2)] + '，总长 ' + total.toFixed(0) + '）');

// 逐 s 统计两条槽的包围盒角点可见性
var fullyHidden = [], partial = [];
for (var ui = 0; ui < underZone.length; ui++) {
  var s2 = underZone[ui];
  var visCount = 0, totalCorners = 0;
  [1, -1].forEach(function (lane) {
    var corners = carCorners(s2, lane);
    for (var ci = 0; ci < corners.length; ci++) {
      totalCorners++;
      if (visibleFromCam(corners[ci])) visCount++;
    }
  });
  var ratio = visCount / totalCorners;
  if (ratio === 0) fullyHidden.push(s2);
  else if (ratio < 0.75) partial.push(s2);
}

function fmt(arr) {
  if (!arr.length) return '无';
  var runs = [], start = arr[0], prev = arr[0];
  for (var i = 1; i <= arr.length; i++) {
    if (i === arr.length || arr[i] - prev > 8) { runs.push('[' + start.toFixed(0) + ',' + prev.toFixed(0) + ']'); start = arr[i]; }
    prev = arr[i];
  }
  return runs.join(' ');
}
console.log('完全不可见的槽位 s:', fmt(fullyHidden));
console.log('大部分被遮挡(>25%角点被挡)的槽位 s:', fmt(partial));
console.log('完全不可见区段总长:', fullyHidden.length * 4, 'px；复位速度 120px/s 下约隐身',
  (fullyHidden.length * 4 / 120).toFixed(2), '秒');

// 正常行驶每圈也会穿过该区段：顺带报告
console.log('\n对照：桥上段 s∈[-70,70]（车在桥面，应完全可见）');
var sOn = 0;
var cornersOn = carCorners(sOn, 1);
var visOn = 0;
for (var k = 0; k < cornersOn.length; k++) if (visibleFromCam(cornersOn[k])) visOn++;
console.log('  s=0 桥面 P1 槽：', visOn + '/' + cornersOn.length, '角点可见');
