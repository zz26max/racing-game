/* 段间切线连续性审计（调试工具）
 * 运行：node _debug/_seg-audit.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const D2R = Math.PI / 180;

// 与 track.js 相同的段构建器
function L(x1, y1, x2, y2) { return { type: 'L', x1, y1, x2, y2 }; }
function A(cx, cy, r, a0, a1) { return { type: 'A', cx, cy, r, a0, a1 }; }

// 与 track.js 的 attic 定义保持一致（手工同步；仅调试用）
const SEG = [
  L(346, -168, -125, -167),
  A(-125, -222, 55, 90, 180),
  L(-180, -222, -180, -243),
  A(-235, -243, 55, 0, -90),
  L(-235, -298, -311, -298),
  A(-311, -243, 55, 270, 180),
  L(-366, -243, -366, -150),
  A(-296, -150, 70, 180, 90),
  A(-296, -20, 60, 270, 360),
  L(-236, -20, -236, 65),
  A(-281, 65, 45, 0, 90),
  L(-281, 110, -368, 146),
  A(-368, 206, 60, 270, 90),
  L(-368, 266, -290, 266),
  A(-290, 176, 90, 90, 15),
  L(-203, 199, -30, -95),
  A(25, -95, 55, 180, 270),
  L(25, -150, 55, -151),
  A(55, -96, 55, 270, 360),
  L(110, -96, 114, -35),
  A(169, -35, 55, 180, 90),
  A(169, 70, 50, 270, 360),
  L(219, 70, 219, 105),
  A(173, 105, 46, 0, 90),
  L(173, 151, 94, 151),
  A(94, 195, 44, 270, 180),
  L(50, 195, 50, 218),
  A(96, 218, 46, 180, 90),
  L(96, 264, 401, 266),
  A(401, 201, 65, 90, 0),
  L(466, 201, 466, -48),
  A(346, -48, 120, 0, -90)
];

function tangentAt(seg, end) {
  if (seg.type === 'L') return Math.atan2(seg.y2 - seg.y1, seg.x2 - seg.x1);
  const a = (end ? seg.a1 : seg.a0) * D2R;
  const sgn = (seg.a1 - seg.a0) > 0 ? 1 : -1;
  return Math.atan2(sgn * Math.cos(a), -sgn * Math.sin(a));
}
function startPoint(seg) {
  return seg.type === 'L' ? [seg.x1, seg.y1] : [seg.cx + seg.r * Math.cos(seg.a0 * D2R), seg.cy + seg.r * Math.sin(seg.a0 * D2R)];
}
function endPoint(seg) {
  return seg.type === 'L' ? [seg.x2, seg.y2] : [seg.cx + seg.r * Math.cos(seg.a1 * D2R), seg.cy + seg.r * Math.sin(seg.a1 * D2R)];
}

let issues = 0;
for (let i = 0; i < SEG.length; i++) {
  const cur = SEG[i], nxt = SEG[(i + 1) % SEG.length];
  const e = endPoint(cur), s = startPoint(nxt);
  const gap = Math.hypot(e[0] - s[0], e[1] - s[1]);
  const tOut = tangentAt(cur, true), tIn = tangentAt(nxt, false);
  let dT = (tIn - tOut) * 180 / Math.PI;
  while (dT > 180) dT -= 360;
  while (dT < -180) dT += 360;
  if (gap > 1 || Math.abs(dT) > 3) {
    issues++;
    console.log('seg#' + i + '(' + cur.type + ')→#' + ((i + 1) % SEG.length) + '(' + nxt.type + ')',
      'gap=' + gap.toFixed(1) + 'px  Δt=' + dT.toFixed(1) + '°  at (' + e[0].toFixed(0) + ',' + e[1].toFixed(0) + ')');
  }
}
console.log('问题 junction:', issues, '/', SEG.length);
