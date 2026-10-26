/* 通用工具集合（UMD：浏览器挂 window.RaceUtil，Node 走 module.exports） */
(function (root, factory) { var api = factory(); if (typeof module === 'object' && module.exports) module.exports = api; else root.RaceUtil = api; })(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var api = {};
  var PI = Math.PI;
  var TWO_PI = PI * 2;

  // 限制在 [a, b]
  api.clamp = function (v, a, b) {
    if (v < a) return a;
    if (v > b) return b;
    return v;
  };

  // 线性插值，t 不裁剪
  api.lerp = function (a, b, t) { return a + (b - a) * t; };

  // 角度归一到 [-PI, PI)
  api.wrapAngle = function (a) {
    var r = (a + PI) % TWO_PI;
    if (r < 0) r += TWO_PI;
    return r - PI;
  };

  // 沿最短弧插值，结果同样落在 [-PI, PI)
  api.angleLerp = function (a, b, t) { return api.wrapAngle(a + api.wrapAngle(b - a) * t); };

  // 三次方减速缓动
  api.easeOutCubic = function (t) { var u = 1 - t; return 1 - u * u * u; };

  // 二次方先加速后减速
  api.easeInOutQuad = function (t) {
    if (t < 0.5) return 2 * t * t;
    var u = 1 - t;
    return 1 - 2 * u * u;
  };

  // mulberry32：同一 seed 得到同一随机序列，输出 [0, 1)
  api.mulberry32 = function (seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
      t = (t ^ (t + (Math.imul(t ^ (t >>> 7), t | 61) >>> 0))) >>> 0;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  // 取坐标，兼容 {x, y} 与 [x, y]
  function readPoint(p) {
    if (!p) return { x: 0, y: 0 };
    if (typeof p.x === 'number' && typeof p.y === 'number') return { x: p.x, y: p.y };
    return { x: p[0], y: p[1] };
  }

  // 闭合 Catmull-Rom 采样：每段取 samplesPerSegment 点，首尾不重复
  api.catmullRomClosed = function (points, samplesPerSegment) {
    var n = points ? points.length : 0;
    var out = [];
    var i;
    if (n < 3) {
      for (i = 0; i < n; i++) out.push(readPoint(points[i]));
      return out;
    }
    var per = samplesPerSegment === undefined ? 12 : Math.max(1, Math.floor(samplesPerSegment));
    var p = [];
    for (i = 0; i < n; i++) p.push(readPoint(points[i]));
    for (var seg = 0; seg < n; seg++) {
      var p0 = p[(seg - 1 + n) % n], p1 = p[seg], p2 = p[(seg + 1) % n], p3 = p[(seg + 2) % n];
      for (var s = 0; s < per; s++) {
        var t = s / per, t2 = t * t, t3 = t2 * t;
        // 张力 0.5 的标准基函数
        var b0 = -0.5 * t3 + t2 - 0.5 * t;
        var b1 = 1.5 * t3 - 2.5 * t2 + 1;
        var b2 = -1.5 * t3 + 2 * t2 + 0.5 * t;
        var b3 = 0.5 * t3 - 0.5 * t2;
        out.push({
          x: b0 * p0.x + b1 * p1.x + b2 * p2.x + b3 * p3.x,
          y: b0 * p0.y + b1 * p1.y + b2 * p2.y + b3 * p3.y
        });
      }
    }
    return out;
  };

  // 折线长度，closed 默认 true（补上末点到首点）
  api.polylineLength = function (pts, closed) {
    var n = pts ? pts.length : 0;
    if (n < 2) return 0;
    var isClosed = closed === undefined ? true : !!closed;
    var total = 0, a, b, dx, dy;
    for (var i = 1; i < n; i++) {
      a = readPoint(pts[i - 1]); b = readPoint(pts[i]);
      dx = b.x - a.x; dy = b.y - a.y;
      total += Math.sqrt(dx * dx + dy * dy);
    }
    if (isClosed) {
      a = readPoint(pts[n - 1]); b = readPoint(pts[0]);
      dx = b.x - a.x; dy = b.y - a.y;
      total += Math.sqrt(dx * dx + dy * dy);
    }
    return total;
  };

  // 射线法判断点是否在多边形内，边界点结果不保证
  api.pointInPolygon = function (px, py, poly) {
    var n = poly ? poly.length : 0;
    if (n < 3) return false;
    var inside = false;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var a = readPoint(poly[i]), b = readPoint(poly[j]);
      if ((a.y > py) !== (b.y > py)) {
        var xCross = a.x + (py - a.y) * (b.x - a.x) / (b.y - a.y);
        if (px < xCross) inside = !inside;
      }
    }
    return inside;
  };

  // 毫秒补三位
  function pad3(v) {
    if (v < 10) return '00' + v;
    if (v < 100) return '0' + v;
    return String(v);
  }

  // 秒转整数毫秒，四舍五入到毫秒
  function toMs(s) {
    var ms = Math.round(Number(s) * 1000);
    if (!isFinite(ms) || ms < 0) ms = 0;
    return ms;
  }

  // 总成绩 → m:ss.mmm
  api.formatTime = function (s) {
    var ms = toMs(s);
    var total = Math.floor(ms / 1000);
    var mmm = ms - total * 1000;
    var mm = Math.floor(total / 60);
    var ss = total - mm * 60;
    return mm + ':' + (ss < 10 ? '0' + ss : String(ss)) + '.' + pad3(mmm);
  };

  // 单圈成绩 → ss.mmm
  api.formatLap = function (s) {
    var ms = toMs(s);
    var total = Math.floor(ms / 1000);
    var mmm = ms - total * 1000;
    return (total < 10 ? '0' + total : String(total)) + '.' + pad3(mmm);
  };

  return api;
});
