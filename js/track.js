/* 槽车赛道：双纽线（8 字，自交 1 次）中心线 + 立体交叉（一处跨线桥）+ 双槽车道（UMD：浏览器挂 window.RaceTrack，Node 走 module.exports） */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RaceTrack = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 中心线几何参数（逻辑空间 1280×720，俯视）
  // 中心线为双纽线 x = A·sin t、y = B·sin 2t，t ∈ [0, 2π)，均匀取 POINT_COUNT 个点（含 t=0，不含 t=2π）。
  // 曲线在 (0,0) 处自交一次：t=0 那一遍为上层桥面，t=π 那一遍从桥下穿过，平面位置相同。
  var LEMN_A = 405;             // 双纽线 x 幅值
  var LEMN_B = 215;             // 双纽线 y 幅值（y = B·sin 2t，故 bbox 高 2B = 430）
  var POINT_COUNT = 1600;       // 中心线采样点数（t = 2π·i / POINT_COUNT）

  var TRACK_WIDTH = 84;         // 赛道总宽
  var LANE_OFFSET = 22;         // 车道中心线相对中心线的法向距离（两槽相距 44 > 车宽 30）
  var CAR_WIDTH = 30;
  var CAR_HEIGHT = 18;
  var SEAM_SPACING = 160;       // 接缝的弧长间隔
  var SEAM_START_GAP = 80;      // 距起点这么近的接缝不生成
  var CURVATURE_STEP = 6;       // 曲率拟合的前后采样距离
  var CORNER_K = 0.0035;        // 弯道判定阈值：|曲率| 超过即算弯道（对应半径约 286px 以下）
  var CORNER_SCAN_STEP = 2;     // 提取弯道区间的弧长扫描步长
  var CORNER_REFINE = 8;        // 区间端点的二分细化次数
  var GRIP = 500;               // 弯道限速的默认抓地常数（cornerLimit 的第二参数可覆盖）

  // 立体交叉：桥中心在 s=0（t=0 那一遍），桥面 |d|<=70 处高 36，70→240 平滑落到地面
  var BRIDGE = {
    sCenter: 0,
    halfLength: 70,
    height: 36,
    clearance: 32,
    rampHalf: 240,
    deckThickness: 4
  };

  // 允许的自交点数量：双纽线自交 1 次，两个通过点在平面上重合，判重后计 1 个
  var ALLOWED_INTERSECTIONS = 1;
  var INTERSECT_EPS = 1e-6;     // 线段参数容差（允许端点接触）
  var INTERSECT_DEDUPE = 1;     // 交点判重的平面距离阈值（px）

  // 两点距离
  function dist(ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // 双纽线中心线：t 从 0 扫到 2π（不含终点），顺序即行驶方向
  function generateCenterline() {
    var pts = new Array(POINT_COUNT);
    for (var i = 0; i < POINT_COUNT; i++) {
      var t = 2 * Math.PI * i / POINT_COUNT;
      pts[i] = { x: LEMN_A * Math.sin(t), y: LEMN_B * Math.sin(2 * t) };
    }
    return pts;
  }

  // 累计弧长表：sArr[i] 为 points[i] 的弧长，sArr[n] 等于总长
  function buildArcTable(points) {
    var n = points.length;
    var sArr = new Array(n + 1);
    sArr[0] = 0;
    for (var i = 1; i <= n; i++) {
      var a = points[i - 1], b = points[i % n];
      sArr[i] = sArr[i - 1] + dist(a.x, a.y, b.x, b.y);
    }
    return { sArr: sArr, total: sArr[n] };
  }

  // 二分查找 s 所在线段下标 i（满足 sArr[i] <= s <= sArr[i+1]）
  function findSegment(sArr, s) {
    var lo = 0, hi = sArr.length - 1;
    while (lo < hi - 1) {
      var mid = (lo + hi) >> 1;
      if (sArr[mid] <= s) lo = mid; else hi = mid;
    }
    return lo;
  }

  // 弧长取模到 [0, total)
  function normalizeS(s, total) {
    if (!(total > 0)) return 0;
    var v = Number(s);
    if (!isFinite(v)) return 0;
    v = v % total;
    if (v < 0) v += total;
    return v;
  }

  // 两条线段求交（含端点接触）：返回交点与两个线段参数，平行/不相交返回 null
  function segmentIntersection(a, b, c, d) {
    var rx = b.x - a.x, ry = b.y - a.y;
    var sx = d.x - c.x, sy = d.y - c.y;
    var denom = rx * sy - ry * sx;
    if (!(Math.abs(denom) > 1e-9)) return null;   // 平行或退化
    var qx = c.x - a.x, qy = c.y - a.y;
    var t = (qx * sy - qy * sx) / denom;
    var u = (qx * ry - qy * rx) / denom;
    if (t < -INTERSECT_EPS || t > 1 + INTERSECT_EPS) return null;
    if (u < -INTERSECT_EPS || u > 1 + INTERSECT_EPS) return null;
    return { x: a.x + rx * t, y: a.y + ry * t, t: t, u: u };
  }

  // 中心线自交检测：非相邻线段两两求交，按平面位置判重后返回 [{ x, y, passes }]
  // passes 记录每个通过点的弧长（每条命中的线段一个），供桥面范围校验
  function findCenterlineIntersections(points, sArr, total) {
    var n = points.length;
    var hits = [];
    for (var i = 0; i < n; i++) {
      var a = points[i], b = points[(i + 1) % n];
      for (var j = i + 1; j < n; j++) {
        // 跳过相邻线段（共用一个顶点）与首尾相邻
        if (j === i + 1 || (i === 0 && j === n - 1)) continue;
        var c = points[j], d = points[(j + 1) % n];
        var hit = segmentIntersection(a, b, c, d);
        if (!hit) continue;
        var segI = sArr[i + 1] - sArr[i];
        var segJ = sArr[j + 1] - sArr[j];
        hits.push({
          x: hit.x, y: hit.y,
          passes: [
            normalizeS(sArr[i] + hit.t * segI, total),
            normalizeS(sArr[j] + hit.u * segJ, total)
          ]
        });
      }
    }

    // 判重：同一平面位置只留一条记录，passes 合并
    var merged = [];
    for (var h = 0; h < hits.length; h++) {
      var p = hits[h], found = null;
      for (var m = 0; m < merged.length; m++) {
        if (dist(p.x, p.y, merged[m].x, merged[m].y) <= INTERSECT_DEDUPE) { found = merged[m]; break; }
      }
      if (found) {
        for (var q = 0; q < p.passes.length; q++) found.passes.push(p.passes[q]);
      } else {
        merged.push({ x: p.x, y: p.y, passes: p.passes.slice() });
      }
    }
    return merged;
  }

  // 中心线自交断言：允许恰好 1 个交点，且该交点必须落在桥面范围内（一遍在桥上、另一遍从桥下穿过）
  function assertCenterlineIntersections(points, sArr, total) {
    var list = findCenterlineIntersections(points, sArr, total);
    if (list.length !== ALLOWED_INTERSECTIONS) {
      throw new Error('赛道中心线自交数为 ' + list.length + '，应恰好为 ' + ALLOWED_INTERSECTIONS +
        '（双纽线在 (0,0) 处自交一次）');
    }
    var x = list[0].x, y = list[0].y;
    var half = total / 2;
    var onDeck = 0, underDeck = 0;
    for (var i = 0; i < list[0].passes.length; i++) {
      var s = list[0].passes[i];
      var d = s - BRIDGE.sCenter;
      if (d > half) d -= total;
      if (d < -half) d += total;
      if (Math.abs(d) <= BRIDGE.halfLength) onDeck += 1;
      else if (Math.abs(Math.abs(d) - half) <= BRIDGE.halfLength) underDeck += 1;
    }
    if (onDeck < 1) {
      throw new Error('中心线交点 (' + x.toFixed(2) + ', ' + y.toFixed(2) + ') 不在桥面范围内（|s| > ' +
        BRIDGE.halfLength + '）');
    }
    if (underDeck < 1) {
      throw new Error('中心线交点 (' + x.toFixed(2) + ', ' + y.toFixed(2) + ') 缺少桥下的另一遍（s≈total/2）');
    }
  }

  // 生成赛道对象（中心线、车道、接缝、出生点、立体交叉、采样查询）
  function createTrack() {
    var points = generateCenterline();
    var table = buildArcTable(points);
    var sArr = table.sArr;
    var totalLength = table.total;
    var n = points.length;

    assertCenterlineIntersections(points, sArr, totalLength);

    // 起跑线弧长：t=π/2 对应的点下标（t = 2π·i/N）
    var startIdx = Math.round(POINT_COUNT * 0.25);
    var START_S = sArr[startIdx];

    // 归一化弧长处的中心点采样，切线为单位向量
    function sampleRaw(s) {
      var i = findSegment(sArr, s);
      var a = points[i], b = points[(i + 1) % n];
      var base = sArr[i], span = sArr[i + 1] - base;
      var t = span > 0 ? (s - base) / span : 0;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      var tx = b.x - a.x, ty = b.y - a.y;
      var len = Math.sqrt(tx * tx + ty * ty);
      if (len > 0) { tx = tx / len; ty = ty / len; } else { tx = 1; ty = 0; }
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, tx: tx, ty: ty };
    }

    // 任意弧长处的中心点与单位切线
    function sampleAt(s) {
      var p = sampleRaw(normalizeS(s, totalLength));
      return { x: p.x, y: p.y, tx: p.tx, ty: p.ty };
    }

    // 中心点沿法向 (-ty, tx) 偏移 lane × 22 后的位置
    function pointAt(s, lane) {
      var p = sampleRaw(normalizeS(s, totalLength));
      var off = (lane === undefined ? 0 : Number(lane) || 0) * LANE_OFFSET;
      return { x: p.x - p.ty * off, y: p.y + p.tx * off };
    }

    // 带符号曲率（1/px）：前后各取 6px 三点拟合，符号由叉积决定
    function curvatureAt(s) {
      var base = normalizeS(s, totalLength);
      var p0 = sampleRaw(normalizeS(base - CURVATURE_STEP, totalLength));
      var p1 = sampleRaw(base);
      var p2 = sampleRaw(normalizeS(base + CURVATURE_STEP, totalLength));
      var ax = p1.x - p0.x, ay = p1.y - p0.y;
      var bx = p2.x - p1.x, by = p2.y - p1.y;
      var cross = ax * by - ay * bx;
      var denom = Math.sqrt(ax * ax + ay * ay) * Math.sqrt(bx * bx + by * by) *
        dist(p0.x, p0.y, p2.x, p2.y);
      if (!(denom > 0)) return 0;
      var k = 2 * Math.abs(cross) / denom; // 4 × 三角形面积 / (三边乘积)
      return cross < 0 ? -k : k;
    }

    // 弯道限速：由向心加速度 a=GRIP 反推 v = sqrt(GRIP / |k|)；直道不限速返回 Infinity
    // grip 省略时取默认 GRIP = 500
    function cornerLimit(s, grip) {
      var g = (grip === undefined || grip === null) ? GRIP : Number(grip);
      if (!(g > 0)) g = GRIP;
      var k = Math.abs(curvatureAt(s));
      return k > 1e-6 ? Math.sqrt(g / k) : Infinity;
    }

    // 到桥中心 s=0 的最短带符号弧长距离（环绕取模，结果落在 (-total/2, total/2]）
    function bridgeDelta(s) {
      var d = normalizeS(s, totalLength) - BRIDGE.sCenter;
      var half = totalLength / 2;
      if (d > half) d -= totalLength;
      if (d < -half) d += totalLength;
      return d;
    }

    // 立体交叉高度：桥面 |d| <= 70 为 36；70→240 用 smoothstep 平滑落回 0
    function elevationAt(s) {
      var d = Math.abs(bridgeDelta(s));
      if (d <= BRIDGE.halfLength) return BRIDGE.height;
      if (d >= BRIDGE.rampHalf) return 0;
      var u = (d - BRIDGE.halfLength) / (BRIDGE.rampHalf - BRIDGE.halfLength);
      var sm = u * u * (3 - 2 * u);
      return BRIDGE.height * (1 - sm);
    }

    // 纵向坡度：中心差分 elevationAt(s+0.5) - elevationAt(s-0.5)
    function slopeAt(s) {
      return elevationAt(s + 0.5) - elevationAt(s - 0.5);
    }

    // 弯道区间：沿弧长扫描 |curvatureAt(s)| > CORNER_K 的连续段，记为 { s0, s1, side }
    // side = +1 左转（曲率正）/ -1 右转（曲率负）；跨越 s=0 的弯道在 s=total 处断开
    function buildCorners() {
      var m = Math.max(2, Math.ceil(totalLength / CORNER_SCAN_STEP));
      var ds = totalLength / m;
      var list = [];
      var runStart = -1;  // 当前区间起始采样下标
      var runSign = 0;    // 区间内曲率符号累加，用多数符号定 side
      var i, k;

      // 二分求阈值穿越的弧长：lo 在区间外、hi 在区间内（顺序不限）
      function refineEdge(lo, hi) {
        for (var t = 0; t < CORNER_REFINE; t++) {
          var mid = (lo + hi) / 2;
          if (Math.abs(curvatureAt(mid)) > CORNER_K) hi = mid; else lo = mid;
        }
        return (lo + hi) / 2;
      }

      function closeRun(endIdx) {
        var s0 = runStart === 0 ? 0 : refineEdge((runStart - 1) * ds, runStart * ds);
        var s1 = endIdx >= m ? totalLength : refineEdge(endIdx * ds, (endIdx - 1) * ds);
        if (s1 > s0 + 0.01) list.push({ s0: s0, s1: s1, side: runSign > 0 ? 1 : -1 });
      }

      for (i = 0; i < m; i++) {
        k = curvatureAt(i * ds);
        if (Math.abs(k) > CORNER_K) {
          if (runStart < 0) { runStart = i; runSign = 0; }
          runSign += k > 0 ? 1 : -1;
        } else if (runStart >= 0) {
          closeRun(i);
          runStart = -1;
        }
      }
      // 收尾：区间一直延伸到 total，说明弯道被 s=0 / total 边界切断，终点取 total
      if (runStart >= 0) closeRun(m);
      return list;
    }

    // 最近点弧长：遍历所有线段做点投影，取距离最小处
    function nearestS(x, y) {
      var bestD2 = Infinity, bestS = 0;
      for (var i = 0; i < n; i++) {
        var a = points[i], b = points[(i + 1) % n];
        var dx = b.x - a.x, dy = b.y - a.y;
        var len2 = dx * dx + dy * dy;
        var t = len2 > 0 ? ((x - a.x) * dx + (y - a.y) * dy) / len2 : 0;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        var px = a.x + dx * t, py = a.y + dy * t;
        var ex = x - px, ey = y - py;
        var d2 = ex * ex + ey * ey;
        if (d2 < bestD2) {
          bestD2 = d2;
          bestS = sArr[i] + t * (sArr[i + 1] - sArr[i]);
        }
      }
      return normalizeS(bestS, totalLength);
    }

    // 弯道区间（红白路肩与刹车提示用）
    var corners = buildCorners();

    // 接缝：沿弧长每 160px 一个，跳过距起点 80px 内的（含环回侧）
    var seams = [];
    for (var seamS = SEAM_SPACING; seamS < totalLength; seamS += SEAM_SPACING) {
      var nearStart = Math.min(seamS, totalLength - seamS);
      if (nearStart < SEAM_START_GAP) continue;
      var sp = sampleRaw(seamS);
      // 接缝线垂直于赛道，angle 为法向 (-ty, tx) 的方向角
      seams.push({ x: sp.x, y: sp.y, angle: Math.atan2(sp.tx, -sp.ty) });
    }

    // 出生点：起跑线前 60px / 120px 各一辆，分居两侧车道
    var spawnDefs = [{ back: 60, lane: 1 }, { back: 120, lane: -1 }];
    var spawns = [];
    for (var k = 0; k < spawnDefs.length; k++) {
      var def = spawnDefs[k];
      var ps = normalizeS(START_S - def.back, totalLength);
      var p = sampleRaw(ps);
      var off = def.lane * LANE_OFFSET;
      spawns.push({
        x: p.x - p.ty * off,
        y: p.y + p.tx * off,
        angle: Math.atan2(p.ty, p.tx),
        lane: def.lane
      });
    }

    // 起跑线中心点，angle 为法向方向角（黑白格沿该方向横跨赛道）
    var startSample = sampleRaw(normalizeS(START_S, totalLength));
    var startLine = {
      x: startSample.x,
      y: startSample.y,
      angle: Math.atan2(startSample.tx, -startSample.ty)
    };

    return {
      points: points,
      laneOffset: LANE_OFFSET,
      width: TRACK_WIDTH,
      carWidth: CAR_WIDTH,
      carHeight: CAR_HEIGHT,
      totalLength: totalLength,
      seams: seams,
      corners: corners,
      startS: START_S,
      spawns: spawns,
      bridge: {
        sCenter: BRIDGE.sCenter,
        halfLength: BRIDGE.halfLength,
        height: BRIDGE.height,
        clearance: BRIDGE.clearance,
        rampHalf: BRIDGE.rampHalf,
        deckThickness: BRIDGE.deckThickness
      },
      sampleAt: sampleAt,
      pointAt: pointAt,
      curvatureAt: curvatureAt,
      cornerLimit: cornerLimit,
      nearestS: nearestS,
      elevationAt: elevationAt,
      slopeAt: slopeAt,
      startLine: startLine
    };
  }

  return {
    createTrack: createTrack,
    carWidth: CAR_WIDTH,
    carHeight: CAR_HEIGHT,
    laneOffset: LANE_OFFSET,
    width: TRACK_WIDTH,
    grip: GRIP
  };
});
