/* 槽车赛道：多赛道注册表 + 中心线管线 + 立体交叉 + 双槽车道
 * （UMD：浏览器挂 window.RaceTrack，Node 走 module.exports）
 *
 * 赛道定义（TRACK_DEFS）：
 *  - figure8  双纽线 8 字（参数化生成，自交 1 次，桥在交点）
 *  - attic    阁楼复刻（线段+圆弧描述，无中心线自交，桥下扫掠道穿过桥面走廊）
 *
 * 每条赛道由 buildPoints() 给出中心线折线（含行进方向），其余
 * （弧长表、采样、曲率、弯道、接缝、出生点）走统一管线；
 * 桥参数（crest/halfLength/height/rampHalf）按赛道配置。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    var util;
    try { util = require('./util.js'); } catch (e) { util = null; }
    module.exports = factory(util);
  } else root.RaceTrack = factory(root.RaceUtil);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (RaceUtil) {
  'use strict';

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

  var INTERSECT_EPS = 1e-6;     // 线段参数容差（允许端点接触）
  var INTERSECT_DEDUPE = 1;     // 交点判重的平面距离阈值（px）

  function dist(ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // ---- 赛道定义 ----
  var TRACK_DEFS = [
    {
      id: 'figure8',
      name: '8 字环道',
      desc: '双纽线 · 中央立交',
      startLineStyle: 'grid',
      bridge: { sCenter: 0, halfLength: 70, height: 36, clearance: 32, rampHalf: 240, deckThickness: 4, railSpan: 70 },
      buildPoints: function () {
        // 双纽线 x = A·sin t、y = B·sin 2t，t ∈ [0, 2π)，均匀采样（含 t=0 不含 2π）
        // 曲线在 (0,0) 处自交一次：t=0 一遍为上层桥面，t=π 一遍从桥下穿过
        var A = 405, B = 215, COUNT = 1600;
        var pts = new Array(COUNT);
        for (var i = 0; i < COUNT; i++) {
          var t = 2 * Math.PI * i / COUNT;
          pts[i] = { x: A * Math.sin(t), y: B * Math.sin(2 * t) };
        }
        return pts;
      },
      // 断言：恰好 1 个自交，一遍在桥上、另一遍从桥下穿过（s≈total/2）
      assert: function (points, sArr, total, bridge) {
        var list = findCenterlineIntersections(points, sArr, total);
        if (list.length !== 1) {
          throw new Error('8 字赛道中心线自交数为 ' + list.length + '，应恰好为 1');
        }
        var half = total / 2;
        var onDeck = 0, underDeck = 0;
        for (var i = 0; i < list[0].passes.length; i++) {
          var d = normDelta(list[0].passes[i], bridge.sCenter, total);
          if (Math.abs(d) <= bridge.halfLength) onDeck += 1;
          else if (Math.abs(Math.abs(d) - half) <= bridge.halfLength) underDeck += 1;
        }
        if (onDeck < 1) throw new Error('8 字赛道交点缺少桥面上的一遍');
        if (underDeck < 1) throw new Error('8 字赛道交点缺少桥下的一遍（s≈total/2）');
      },
      pickStartS: function (points, sArr) {
        // t=π/2 对应的点下标
        return sArr[Math.round(1600 * 0.25)];
      }
    },
    {
      id: 'attic',
      name: '阁楼复刻',
      desc: '原版布局 · S 弯 + 中央高架',
      startLineStyle: 'lines',
      bridge: {
        crest: { x: 12, y: -167 },          // 桥面平段中点（sCenter 取最近采样点弧长）
        halfLength: 70, height: 36, clearance: 32, rampHalf: 280, deckThickness: 4,
        railSpan: 170                        // 黄护栏覆盖平段+大部分引桥（对照参考图）
      },
      startAt: { x: 236, y: -168 },          // 起跑线（顶直道，行进方向向西）
      buildPoints: function () {
        // 海龟绘图描述（对照参考图逆向；旅行方向：起点直道向西）
        // 命令：['F', dist] 前进；['R', deg, r] 右转；['L', deg, r] 左转
        var CMDS = [
          ['F', 471],
          ['R', 90, 56], ['F', 16], ['L', 90, 56], ['F', 76],
          ['L', 90, 56], ['F', 80],
          ['L', 70, 74], ['F', 100], ['R', 110, 62], ['F', 25], ['R', 50, 60], ['F', 90],
          ['L', 180, 70], ['F', 145], ['L', 75, 90], ['F', 257],
          ['R', 75, 58], ['F', 30], ['R', 90, 58], ['F', 40],
          ['L', 90, 58], ['F', 16], ['R', 90, 60], ['R', 90, 60], ['F', 30],
          ['L', 90, 58], ['F', 14], ['L', 90, 58], ['F', 261.61],
          ['L', 90, 70], ['F', 248.5], ['L', 90, 120]
        ];
        return buildTurtlePoints([346, -168], 180, CMDS);
      },
      // 断言：每个中心线自交都必须是"桥下穿越"——一遍在桥面平段（高程 ≥30）、
      // 另一遍在地面且平面位置落在桥面路基范围内；走廊重叠段须在平段 ±45 弧长内（净空 ≥7px）
      assert: function (points, sArr, total, bridge) {
        var sc = bridge.sCenter;
        var n = points.length;
        var halfW = TRACK_WIDTH / 2;
        function elevAt(s) {
          var d = Math.abs(normDelta(s, sc, total));
          if (d <= bridge.halfLength) return bridge.height;
          if (d >= bridge.rampHalf) return 0;
          var u = (d - bridge.halfLength) / (bridge.rampHalf - bridge.halfLength);
          return bridge.height * (1 - u * u * (3 - 2 * u));
        }
        var list = findCenterlineIntersections(points, sArr, total);
        for (var v = 0; v < list.length; v++) {
          var ix = list[v];
          var onDeck = 0, onGround = 0;
          for (var w = 0; w < ix.passes.length; w++) {
            if (elevAt(ix.passes[w]) >= 30) onDeck += 1;
            else if (elevAt(ix.passes[w]) < 1) onGround += 1;
          }
          if (!(onDeck >= 1 && onGround >= 1 && ix.passes.length >= 2)) {
            throw new Error('阁楼赛道自交点 (' + ix.x.toFixed(0) + ',' + ix.y.toFixed(0) + ') 不是合法的桥下穿越');
          }
        }
        for (var i = 0; i < n; i += 3) {
          var s = sArr[i];
          if (elevAt(s) > 1) continue;                                            // 自己在桥上
          if (Math.abs(normDelta(s, sc, total)) < bridge.rampHalf + 80) continue; // 同车道引坡衔接
          var bestD = Infinity, bestS2 = -1;
          for (var j = 0; j < n; j += 3) {
            var s2 = sArr[j];
            if (Math.abs(normDelta(s2, sc, total)) > bridge.rampHalf) continue;
            var dd = dist(points[i].x, points[i].y, points[j].x, points[j].y);
            if (dd < bestD) { bestD = dd; bestS2 = s2; }
          }
          if (bestD < halfW && Math.abs(normDelta(bestS2, sc, total)) > bridge.halfLength + 60) {
            throw new Error('阁楼赛道桥下穿越超出平段范围（净空不足）：s=' + s.toFixed(0));
          }
        }
      },
      pickStartS: function (points, sArr, def) {
        // 起跑线取离 startAt 最近的采样点
        var best = 0, bd = Infinity;
        for (var i = 0; i < points.length; i++) {
          var d = dist(points[i].x, points[i].y, def.startAt.x, def.startAt.y);
          if (d < bd) { bd = d; best = i; }
        }
        return sArr[best];
      }
    }
  ];

  // ---- 海龟命令 → 中心线折线（含 CR 平滑 + 均匀重采样 + 轻 fairing）----
  function buildTurtlePoints(start, heading, cmds) {
    var D2R = Math.PI / 180;
    var pts = [];
    var x = start[0], y = start[1], h = heading;
    pts.push([x, y]);
    for (var c = 0; c < cmds.length; c++) {
      var cmd = cmds[c];
      if (cmd[0] === 'F') {
        var n = Math.max(1, Math.round(cmd[1] / 30));
        for (var i = 1; i <= n; i++) {
          x += cmd[1] * Math.cos(h * D2R) / n;
          y += cmd[1] * Math.sin(h * D2R) / n;
          pts.push([x, y]);
        }
      } else {
        var delta = (cmd[0] === 'L' ? -1 : 1) * cmd[1], r = cmd[2];
        var sgn = delta > 0 ? 1 : -1;
        var cx = x + r * Math.cos((h + 90 * sgn) * D2R);
        var cy = y + r * Math.sin((h + 90 * sgn) * D2R);
        var a0 = Math.atan2(y - cy, x - cx);
        var sweep = delta * D2R;
        var m = Math.max(2, Math.ceil(Math.abs(delta) / 15));
        for (var j = 1; j <= m; j++) {
          var a = a0 + sweep * j / m;
          pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
        }
        x = pts[pts.length - 1][0];
        y = pts[pts.length - 1][1];
        h = ((h + delta) % 360 + 360) % 360;
      }
    }
    // 闭合：末点贴近首点时用末点替换首点（保留末段方向）
    if (pts.length > 2) {
      var f = pts[0], l = pts[pts.length - 1];
      if (dist(f[0], f[1], l[0], l[1]) < 2) { pts[0] = l; pts.pop(); }
    }

    // Catmull-Rom 平滑（消线/弧交接的弦切差；15° 密点下样条贴合圆弧）
    var cr = [];
    var cnt = pts.length;
    for (var seg = 0; seg < cnt; seg++) {
      var p0 = pts[(seg - 1 + cnt) % cnt], p1 = pts[seg], p2 = pts[(seg + 1) % cnt], p3 = pts[(seg + 2) % cnt];
      for (var t = 0; t < 6; t++) {
        var u = t / 6, u2 = u * u, u3 = u2 * u;
        var b0 = -0.5 * u3 + u2 - 0.5 * u;
        var b1 = 1.5 * u3 - 2.5 * u2 + 1;
        var b2 = -1.5 * u3 + 2 * u2 + 0.5 * u;
        var b3 = 0.5 * u3 - 0.5 * u2;
        cr.push({ x: b0 * p0[0] + b1 * p1[0] + b2 * p2[0] + b3 * p3[0], y: b0 * p0[1] + b1 * p1[1] + b2 * p2[1] + b3 * p3[1] });
      }
    }

    // 均匀重采样（2px）
    var res = [];
    var carry = 0;
    for (var q = 0; q < cr.length; q++) {
      var a = cr[q], b = cr[(q + 1) % cr.length];
      var dx = b.x - a.x, dy = b.y - a.y;
      var len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1e-9) continue;
      var sAcc = 2 - carry;
      while (sAcc <= len) {
        res.push({ x: a.x + dx * sAcc / len, y: a.y + dy * sAcc / len });
        sAcc += 2;
      }
      carry = len - (sAcc - 2);
    }

    // 3 遍轻 fairing（2px 重采样下标准圆弧半径变化 <1%，只磨线/弧交接处的曲率尖峰）
    for (var p2 = 0; p2 < 3; p2++) {
      var m2 = res.length;
      var fo = new Array(m2);
      for (var fi = 0; fi < m2; fi++) {
        var fa = res[(fi - 1 + m2) % m2], fb = res[fi], fc = res[(fi + 1) % m2];
        fo[fi] = { x: fb.x + 0.12 * (fa.x + fc.x - 2 * fb.x), y: fb.y + 0.12 * (fa.y + fc.y - 2 * fb.y) };
      }
      res = fo;
    }
    return res;
  }

  // 带符号弧长差（环绕取模，落在 (-total/2, total/2]）
  function normDelta(s, s0, total) {
    var d = s - s0;
    var half = total / 2;
    if (d > half) d -= total;
    if (d < -half) d += total;
    return d;
  }

  // 两条线段求交（含端点接触）
  function segmentIntersection(a, b, c, d) {
    var rx = b.x - a.x, ry = b.y - a.y;
    var sx = d.x - c.x, sy = d.y - c.y;
    var denom = rx * sy - ry * sx;
    if (!(Math.abs(denom) > 1e-9)) return null;
    var qx = c.x - a.x, qy = c.y - a.y;
    var t = (qx * sy - qy * sx) / denom;
    var u = (qx * ry - qy * rx) / denom;
    if (t < -INTERSECT_EPS || t > 1 + INTERSECT_EPS) return null;
    if (u < -INTERSECT_EPS || u > 1 + INTERSECT_EPS) return null;
    return { x: a.x + rx * t, y: a.y + ry * t, t: t, u: u };
  }

  // 中心线自交检测：按平面位置判重，返回 [{ x, y, passes }]
  function findCenterlineIntersections(points, sArr, total) {
    var n = points.length;
    var hits = [];
    for (var i = 0; i < n; i++) {
      var a = points[i], b = points[(i + 1) % n];
      for (var j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        var c = points[j], d = points[(j + 1) % n];
        var hit = segmentIntersection(a, b, c, d);
        if (!hit) continue;
        var segI = sArr[i + 1] - sArr[i];
        var segJ = sArr[j + 1] - sArr[j];
        hits.push({
          x: hit.x, y: hit.y,
          passes: [
            normDelta(sArr[i] + hit.t * segI, 0, total),
            normDelta(sArr[j] + hit.u * segJ, 0, total)
          ]
        });
      }
    }
    // 判重：同一平面位置只留一条记录，passes 合并
    var merged = [];
    for (var h = 0; h < hits.length; h++) {
      var found = null;
      for (var m = 0; m < merged.length; m++) {
        if (dist(hits[h].x, hits[h].y, merged[m].x, merged[m].y) <= INTERSECT_DEDUPE) { found = merged[m]; break; }
      }
      if (found) {
        for (var q = 0; q < hits[h].passes.length; q++) found.passes.push(hits[h].passes[q]);
      } else {
        merged.push({ x: hits[h].x, y: hits[h].y, passes: hits[h].passes.slice() });
      }
    }
    return merged;
  }

  // 折线按弧长均匀重采样
  function resampleUniform(raw, step) {
    var pts = [];
    var count = raw.length;
    var carry = 0;
    for (var i = 0; i < count; i++) {
      var a = raw[i], b = raw[(i + 1) % count];
      var dx = b.x - a.x, dy = b.y - a.y;
      var len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1e-9) continue;
      var sAcc = step - carry;
      while (sAcc <= len) {
        pts.push({ x: a.x + dx * sAcc / len, y: a.y + dy * sAcc / len });
        sAcc += step;
      }
      carry = len - (sAcc - step);
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

  // 二分查找 s 所在线段下标
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

  // 生成赛道对象
  function createTrack(id) {
    var def = null;
    for (var i = 0; i < TRACK_DEFS.length; i++) {
      if (TRACK_DEFS[i].id === id) { def = TRACK_DEFS[i]; break; }
    }
    if (!def) def = TRACK_DEFS[0];

    var segPoints = def.buildPoints();
    // 密控制点过 Catmull-Rom：弧线贴合、线/弧交接的微小切线差被平滑掉
    var smoothed = (RaceUtil && typeof RaceUtil.catmullRomClosed === 'function')
      ? RaceUtil.catmullRomClosed(segPoints, 6)
      : segPoints;
    var points = resampleUniform(smoothed, 2);
    // 2 遍轻 fairing：消残余折角
    for (var f = 0; f < 2; f++) {
      var m2 = points.length;
      var fo = new Array(m2);
      for (var fi = 0; fi < m2; fi++) {
        var fa = points[(fi - 1 + m2) % m2], fb = points[fi], fc = points[(fi + 1) % m2];
        fo[fi] = { x: fb.x + 0.1 * (fa.x + fc.x - 2 * fb.x), y: fb.y + 0.1 * (fa.y + fc.y - 2 * fb.y) };
      }
      points = fo;
    }
    var table = buildArcTable(points);
    var sArr = table.sArr;
    var totalLength = table.total;
    var n = points.length;

    // 桥参数：sCenter 取 crest 最近采样点弧长（未配置 crest 的用定义值）
    var bridge = {
      sCenter: def.bridge.sCenter !== undefined ? def.bridge.sCenter : 0,
      halfLength: def.bridge.halfLength,
      height: def.bridge.height,
      clearance: def.bridge.clearance,
      rampHalf: def.bridge.rampHalf,
      deckThickness: def.bridge.deckThickness,
      railSpan: def.bridge.railSpan || 70
    };
    if (def.bridge.crest) {
      var bd = Infinity, bi = 0;
      for (var c = 0; c < n; c++) {
        var cd = dist(points[c].x, points[c].y, def.bridge.crest.x, def.bridge.crest.y);
        if (cd < bd) { bd = cd; bi = c; }
      }
      bridge.sCenter = sArr[bi];
    }

    def.assert(points, sArr, totalLength, bridge);

    // 起跑线弧长
    var START_S = normalizeS(def.pickStartS(points, sArr, def), totalLength);

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

    function sampleAt(s) {
      var p = sampleRaw(normalizeS(s, totalLength));
      return { x: p.x, y: p.y, tx: p.tx, ty: p.ty };
    }

    function pointAt(s, lane) {
      var p = sampleRaw(normalizeS(s, totalLength));
      var off = (lane === undefined ? 0 : Number(lane) || 0) * LANE_OFFSET;
      return { x: p.x - p.ty * off, y: p.y + p.tx * off };
    }

    // 带符号曲率（1/px）
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
      var k = 2 * Math.abs(cross) / denom;
      return cross < 0 ? -k : k;
    }

    function cornerLimit(s, grip) {
      var g = (grip === undefined || grip === null) ? GRIP : Number(grip);
      if (!(g > 0)) g = GRIP;
      var k = Math.abs(curvatureAt(s));
      return k > 1e-6 ? Math.sqrt(g / k) : Infinity;
    }

    // 到桥中心的带符号弧长距离
    function bridgeDelta(s) {
      return normDelta(normalizeS(s, totalLength), bridge.sCenter, totalLength);
    }

    // 立体交叉高度：平段 |d| <= halfLength 为 height；→ rampHalf 平滑落回 0
    function elevationAt(s) {
      var d = Math.abs(bridgeDelta(s));
      if (d <= bridge.halfLength) return bridge.height;
      if (d >= bridge.rampHalf) return 0;
      var u = (d - bridge.halfLength) / (bridge.rampHalf - bridge.halfLength);
      var sm = u * u * (3 - 2 * u);
      return bridge.height * (1 - sm);
    }

    function slopeAt(s) {
      return elevationAt(s + 0.5) - elevationAt(s - 0.5);
    }

    // 弯道区间（红白路肩与刹车提示用）
    function buildCorners() {
      var m = Math.max(2, Math.ceil(totalLength / CORNER_SCAN_STEP));
      var ds = totalLength / m;
      var list = [];
      var runStart = -1, runSign = 0;
      var i, k;

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
      if (runStart >= 0) closeRun(m);
      // 合并间距过小的同侧区间（线/弧衔接处的曲率跳变会把弯道切碎）
      var merged = [];
      for (i = 0; i < list.length; i++) {
        var last = merged[merged.length - 1];
        if (last && list[i].side === last.side && list[i].s0 - last.s1 < 30) {
          last.s1 = list[i].s1;
        } else {
          merged.push({ s0: list[i].s0, s1: list[i].s1, side: list[i].side });
        }
      }
      return merged;
    }

    // 最近点弧长
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

    var corners = buildCorners();

    // 接缝：沿弧长每 160px 一个，跳过距起点 80px 内的
    var seams = [];
    for (var seamS = SEAM_SPACING; seamS < totalLength; seamS += SEAM_SPACING) {
      var nearStart = Math.min(seamS, totalLength - seamS);
      if (nearStart < SEAM_START_GAP) continue;
      var sp = sampleRaw(seamS);
      seams.push({ x: sp.x, y: sp.y, angle: Math.atan2(sp.tx, -sp.ty) });
    }

    // 出生点：起跑线前 60px / 120px 各一辆，分居两侧车道
    var spawnDefs = [{ back: 60, lane: 1 }, { back: 120, lane: -1 }];
    var spawns = [];
    for (var k = 0; k < spawnDefs.length; k++) {
      var sdef = spawnDefs[k];
      var ps = normalizeS(START_S - sdef.back, totalLength);
      var pp = sampleRaw(ps);
      var off = sdef.lane * LANE_OFFSET;
      spawns.push({
        x: pp.x - pp.ty * off,
        y: pp.y + pp.tx * off,
        angle: Math.atan2(pp.ty, pp.tx),
        lane: sdef.lane
      });
    }

    // 起跑线中心点
    var startSample = sampleRaw(START_S);
    var startLine = {
      x: startSample.x,
      y: startSample.y,
      angle: Math.atan2(startSample.tx, -startSample.ty)
    };

    return {
      id: def.id,
      name: def.name,
      desc: def.desc,
      startLineStyle: def.startLineStyle || 'grid',
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
      bridge: bridge,
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

  // 赛道列表（标题选择用）
  function listTracks() {
    var list = [];
    for (var i = 0; i < TRACK_DEFS.length; i++) {
      list.push({ id: TRACK_DEFS[i].id, name: TRACK_DEFS[i].name, desc: TRACK_DEFS[i].desc });
    }
    return list;
  }

  return {
    createTrack: createTrack,
    listTracks: listTracks,
    carWidth: CAR_WIDTH,
    carHeight: CAR_HEIGHT,
    laneOffset: LANE_OFFSET,
    width: TRACK_WIDTH,
    grip: GRIP
  };
});
