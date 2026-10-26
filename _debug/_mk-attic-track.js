/* 阁楼复刻赛道原型 v7：海龟绘图描述（F/L/R 命令）→ 折线 → 均匀重采样 → 几何校验
 * 运行：node _debug/_mk-attic-track.js
 *
 * 海龟命令保证所有衔接切线连续（弯道 = 圆弧，直道 = 线段），
 * 从构造上消除 junction 尖刺。角度：屏幕坐标 y 向下，heading 度
 * （0=东，90=南，180=西，270=北）；R=右转（heading 增），L=左转（heading 减）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const D2R = Math.PI / 180;

// ---- 海龟 ----
function turtle(start, heading) {
  const pts = [];
  let x = start[0], y = start[1], h = heading;
  pts.push([x, y]);
  return {
    F(dist) {  // 前进（每 ~30px 一个点）
      const n = Math.max(1, Math.round(dist / 30));
      for (let i = 1; i <= n; i++) {
        x += dist * Math.cos(h * D2R) / n;
        y += dist * Math.sin(h * D2R) / n;
        pts.push([x, y]);
      }
    },
    turn(delta, r) {  // 转弯（每 15° 一个点）；delta>0 右转
      const sweep = delta * D2R;
      const sgn = delta > 0 ? 1 : -1;
      // 圆心：heading + 90°·sgn 方向 r 处
      const cx = x + r * Math.cos((h + 90 * sgn) * D2R);
      const cy = y + r * Math.sin((h + 90 * sgn) * D2R);
      const a0 = Math.atan2(y - cy, x - cx);
      const n = Math.max(2, Math.ceil(Math.abs(delta) / 15));
      for (let i = 1; i <= n; i++) {
        const a = a0 + sweep * i / n;
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
      x = pts[pts.length - 1][0];
      y = pts[pts.length - 1][1];
      h = ((h + delta) % 360 + 360) % 360;
    },
    pos() { return [x, y, h]; },
    pts
  };
}

// ---- 赛道描述（旅行方向：起点直道向西；起点 = TR 弯出口）----
const T = turtle([346, -168], 180);
T.F(471);            // 东直道 + 桥面 + 西引坡 → 桥西北端
T.turn(90, 55);      // 钩 W→N 折
T.F(21);
T.turn(-90, 55);     // 钩 N→W 折
T.F(76);             // 北带
T.turn(-90, 55);     // 钩 W→S 折
T.F(93);             // 西侧下行
T.turn(-70, 70);     // 鼓包入弯（S→ESE）
T.F(100);
T.turn(110, 60);     // 鼓包出弯（ESE→SSE）
T.F(25);
T.turn(50, 45);      // S→W 接 H2 入弯腿
T.F(90);
T.turn(-180, 60);    // H2 发卡 180°
T.F(78);             // 出弯腿
T.turn(-75, 90);     // 出弯左弧（E→NNE）
T.F(257);            // 上升匝道
T.turn(75, 55);      // 桥下 U 折（NNE→E）
T.F(30);             // 横扫
T.turn(90, 55);      // SE 出口（E→S）
T.F(60);
T.turn(-90, 55);     // S→E 左弯
T.turn(90, 50);      // kink（E→S）
T.turn(90, 46);      // chicane 一连（S→W）
T.F(30);             // W 横穿
T.turn(-90, 44);     // 二连（W→S）
T.F(70);
T.turn(-90, 46);     // 三连（S→E）
T.F(341);            // 底直道
T.turn(-90, 65);     // BR 左弯（E→N）
T.F(252);            // 右侧
T.turn(-90, 120);    // TR 左弯（N→W）

const ctrlRaw = T.pts;
// 闭合处理：末点贴近首点时用末点替换首点（保留 TR 弧末段方向）
if (ctrlRaw.length > 2) {
  const f = ctrlRaw[0], l = ctrlRaw[ctrlRaw.length - 1];
  if (Math.hypot(f[0] - l[0], f[1] - l[1]) < 2) { ctrlRaw[0] = l; ctrlRaw.pop(); }
}
console.log('闭合检查: 起点', JSON.stringify(ctrlRaw[0]), '终点', JSON.stringify(ctrlRaw[ctrlRaw.length - 1]),
  '间距', Math.hypot(ctrlRaw[0][0] - ctrlRaw[ctrlRaw.length - 1][0], ctrlRaw[0][1] - ctrlRaw[ctrlRaw.length - 1][1]).toFixed(1), 'px');

// Catmull-Rom 平滑（消线/弧交接的弦切差；15° 密点下样条贴合圆弧）
const crPts = [];
{
  const m = ctrlRaw.length;
  for (let seg = 0; seg < m; seg++) {
    const p0 = ctrlRaw[(seg - 1 + m) % m], p1 = ctrlRaw[seg], p2 = ctrlRaw[(seg + 1) % m], p3 = ctrlRaw[(seg + 2) % m];
    for (let s = 0; s < 6; s++) {
      const t = s / 6, t2 = t * t, t3 = t2 * t;
      const b0 = -0.5 * t3 + t2 - 0.5 * t;
      const b1 = 1.5 * t3 - 2.5 * t2 + 1;
      const b2 = -1.5 * t3 + 2 * t2 + 0.5 * t;
      const b3 = 0.5 * t3 - 0.5 * t2;
      crPts.push([b0 * p0[0] + b1 * p1[0] + b2 * p2[0] + b3 * p3[0], b0 * p0[1] + b1 * p1[1] + b2 * p2[1] + b3 * p3[1]]);
    }
  }
}

const STEP = 2;
function resampleUniform(raw, step) {
  const pts = [];
  const count = raw.length;
  let carry = 0;
  for (let i = 0; i < count; i++) {
    const a = raw[i], b = raw[(i + 1) % count];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-9) continue;
    let sAcc = step - carry;
    while (sAcc <= len) {
      pts.push({ x: a[0] + dx * sAcc / len, y: a[1] + dy * sAcc / len });
      sAcc += step;
    }
    carry = len - (sAcc - step);
  }
  return pts;
}
let pts = resampleUniform(crPts, STEP);
for (let pass = 0; pass < 2; pass++) {
  const m = pts.length;
  const out = new Array(m);
  for (let i = 0; i < m; i++) {
    const a = pts[(i - 1 + m) % m], b = pts[i], c = pts[(i + 1) % m];
    out[i] = { x: b.x + 0.1 * (a.x + c.x - 2 * b.x), y: b.y + 0.1 * (a.y + c.y - 2 * b.y) };
  }
  pts = out;
}
const n = pts.length;

const sArr = [0];
for (let i = 1; i <= n; i++) {
  const a = pts[i - 1], b = pts[i % n];
  sArr.push(sArr[i - 1] + Math.hypot(b.x - a.x, b.y - a.y));
}
const total = sArr[n];

let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
for (const p of pts) {
  minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
  minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
}

const CREST = { x: 12, y: -167 };
let crestS = 0, crestD = 1e9;
for (let i = 0; i < n; i++) {
  const d = Math.hypot(pts[i].x - CREST.x, pts[i].y - CREST.y);
  if (d < crestD) { crestD = d; crestS = sArr[i]; }
}

function curvatureAt(pts, i) {
  const m = pts.length;
  const p0 = pts[(i - 1 + m) % m], p1 = pts[i], p2 = pts[(i + 1) % m];
  const ax = p1.x - p0.x, ay = p1.y - p0.y;
  const bx = p2.x - p1.x, by = p2.y - p1.y;
  const cross = ax * by - ay * bx;
  const denom = Math.hypot(ax, ay) * Math.hypot(bx, by) * Math.hypot(p2.x - p0.x, p2.y - p0.y);
  if (!(denom > 1e-9)) return 0;
  return cross < 0 ? -(2 * cross / denom) : (2 * cross / denom);
}

let minR = 1e9, minRAt = -1;
const tight = [];
for (let i = 0; i < n; i++) {
  const k = Math.abs(curvatureAt(pts, i));
  if (k > 1e-9) {
    tight.push({ r: 1 / k, i });
    if (1 / k < minR) { minR = 1 / k; minRAt = i; }
  }
}
tight.sort((a, b) => a.r - b.r);

function segIntersect(a, b, c, d) {
  const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
  if (t < -1e-6 || t > 1 + 1e-6 || u < -1e-6 || u > 1 + 1e-6) return null;
  return { x: a.x + rx * t, y: a.y + ry * t, t, u };
}
const dedup = [];
for (let i = 0; i < n; i++) {
  const a = pts[i], b = pts[(i + 1) % n];
  for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    const hit = segIntersect(a, b, pts[j], pts[(j + 1) % n]);
    if (hit) {
      const rec = { x: hit.x, y: hit.y, passes: [sArr[i] + hit.t * STEP, sArr[j] + hit.u * STEP] };
      const f = dedup.find(q => Math.hypot(q.x - rec.x, q.y - rec.y) < 3);
      if (f) f.passes.push(...rec.passes); else dedup.push(rec);
    }
  }
}

function arcDist(a, b) {
  const d = Math.abs(((a - b) % total + total) % total);
  return Math.min(d, total - d);
}
const BRIDGE_RAMP = 240;
const BRIDGE_HALF = 70;
const onDeckArc = (s) => arcDist(s, crestS) <= BRIDGE_RAMP;

const skip = Math.round(170 / STEP);
function radiusAt(i) { const k = Math.abs(curvatureAt(pts, i)); return k > 1e-9 ? 1 / k : 1e9; }
const pairs = [];
for (let i = 0; i < n; i += 2) {
  for (let j = i + skip; j < n; j += 2) {
    if (n - j < skip) continue;
    const p = pts[i], q = pts[j];
    const dist = Math.hypot(p.x - q.x, p.y - q.y);
    if (dist < 140) {
      const deckA = onDeckArc(sArr[i]), deckB = onDeckArc(sArr[j]);
      const whitelist = deckA !== deckB || (radiusAt(i) >= 40 && radiusAt(j) >= 40);
      pairs.push({ dist, s1: sArr[i], s2: sArr[j], p, q, whitelist });
    }
  }
}
pairs.sort((a, b) => a.dist - b.dist);

function lemniscateStats() {
  const rawL = [];
  for (let i = 0; i < 1600; i++) {
    const t = 2 * Math.PI * i / 1600;
    rawL.push({ x: 405 * Math.sin(t), y: 215 * Math.sin(2 * t) });
  }
  let minR = 1e9, totalL = 0;
  for (let i = 0; i < 1600; i++) {
    totalL += Math.hypot(rawL[(i + 1) % 1600].x - rawL[i].x, rawL[(i + 1) % 1600].y - rawL[i].y);
    const k = Math.abs(curvatureAt(rawL, i));
    if (k > 1e-9) minR = Math.min(minR, 1 / k);
  }
  return { minR, totalL };
}
const lem = lemniscateStats();

console.log('=== 阁楼复刻赛道几何报告 v7（海龟） ===');
console.log(`海龟点: ${ctrlRaw.length}  CR 点: ${crPts.length}  采样点: ${n}  采样点: ${n}  总长: ${total.toFixed(1)}px   (双纽线基准: ${lem.totalL.toFixed(1)}px)`);
console.log(`bbox: x [${minX.toFixed(0)}, ${maxX.toFixed(0)}]  y [${minY.toFixed(0)}, ${maxY.toFixed(0)}]  (${(maxX - minX).toFixed(0)} x ${(maxY - minY).toFixed(0)})`);
console.log(`crest s=${crestS.toFixed(1)}  平段 s ${((crestS - BRIDGE_HALF + total) % total).toFixed(0)} ~ ${((crestS + BRIDGE_HALF) % total).toFixed(0)}`);
console.log(`最小转弯半径: ${minR.toFixed(1)}px @ s=${sArr[minRAt].toFixed(0)} (${pts[minRAt].x.toFixed(0)}, ${pts[minRAt].y.toFixed(0)})  → 极限 ${Math.sqrt(500 * minR).toFixed(0)} px/s   (双纽线: ${lem.minR.toFixed(1)}px → ${Math.sqrt(500 * lem.minR).toFixed(0)} px/s)`);
console.log('最紧 6 处：');
for (const t of tight.slice(0, 6)) {
  console.log(`  R=${t.r.toFixed(1)}px  (${pts[t.i].x.toFixed(0)}, ${pts[t.i].y.toFixed(0)})  s=${sArr[t.i].toFixed(0)}  极限 ${Math.sqrt(500 * t.r).toFixed(0)}px/s`);
}
console.log(`中心线自交: ${dedup.length}`);
for (const d of dedup) console.log(`  (${d.x.toFixed(0)}, ${d.y.toFixed(0)})  passes: ${d.passes.map(s => s.toFixed(0)).join(', ')}`);
console.log('最近非邻接对 TOP6 (<140px):');
for (let k = 0; k < Math.min(6, pairs.length); k++) {
  const pr = pairs[k];
  console.log(`  ${pr.whitelist ? '[合法]' : '    '} ${pr.dist.toFixed(1)}px  (${pr.p.x.toFixed(0)},${pr.p.y.toFixed(0)}) s=${pr.s1.toFixed(0)}  ↔  (${pr.q.x.toFixed(0)},${pr.q.y.toFixed(0)}) s=${pr.s2.toFixed(0)}`);
}
const bad = pairs.filter(p => !p.whitelist && p.dist < 95);
console.log(`违规 (<95px, 双方同层): ${bad.length} 处`);
for (const pr of bad.slice(0, 8)) {
  console.log(`  ✗ ${pr.dist.toFixed(1)}px  (${pr.p.x.toFixed(0)},${pr.p.y.toFixed(0)}) s=${pr.s1.toFixed(0)}  ↔  (${pr.q.x.toFixed(0)},${pr.q.y.toFixed(0)}) s=${pr.s2.toFixed(0)}`);
}

let underOk = true, underChecked = 0;
for (let i = 0; i < n; i++) {
  if (onDeckArc(sArr[i]) || arcDist(sArr[i], crestS) < BRIDGE_RAMP + 80) continue;
  let bestD = 1e9, bestDeckS = -1;
  for (let j = 0; j < n; j += 2) {
    if (!onDeckArc(sArr[j])) continue;
    const dist = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
    if (dist < bestD) { bestD = dist; bestDeckS = sArr[j]; }
  }
  if (bestD < 42) {
    underChecked++;
    if (arcDist(bestDeckS, crestS) > BRIDGE_HALF + 25) {
      underOk = false;
      console.log(`  ✗ 桥下穿越净空不足: s=${sArr[i].toFixed(0)} (${pts[i].x.toFixed(0)},${pts[i].y.toFixed(0)}) 对应 deck s=${bestDeckS.toFixed(0)}`);
    }
  }
}
console.log(`桥下穿越校验: ${underChecked} 个重叠采样点, ${underOk ? '净空充足 ✓' : '存在不足 ✗'}`);

fs.writeFileSync(path.join(__dirname, '_ref', 'attic_points.json'), JSON.stringify({
  control: ctrlRaw, points: pts, step: STEP, total,
  crestS, bridgeHalf: BRIDGE_HALF, bridgeRamp: BRIDGE_RAMP,
  startAt: { x: 236, y: -168 },
  bbox: { minX, maxX, minY, maxY }
}));
console.log('JSON → _debug/_ref/attic_points.json');
