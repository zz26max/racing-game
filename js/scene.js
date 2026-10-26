/* 场景底图：一次性离屏绘制墙面 / 木地板 / 地毯 / 光池 / 赛道 / 槽线（UMD：浏览器挂 window.RaceScene，Node 走 module.exports） */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./util'));
  else root.RaceScene = factory(root.RaceUtil);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (RaceUtil) {
  'use strict';

  var W = 1280;             // 逻辑宽
  var H = 720;              // 逻辑高
  var WALL_H = 48;          // 墙高
  var PLANK_W = 40;         // 木板宽度
  var PLANK_L = 240;        // 木板长度（相邻列端缝错开一半）
  var SEAM_STAGGER = 120;   // 相邻列端缝错位量
  var FLOOR_DOTS = 400;     // 地板亮点数量
  var RUG_W = 1040;         // 地毯宽
  var RUG_H = 560;          // 地毯高
  var RUG_R = 24;           // 地毯圆角
  var RUG_INSET = 16;       // 地毯内边框内缩
  var RUG_BORDER = 4;       // 地毯内边框宽度
  var POOL_X = 640;         // 光池圆心 x
  var POOL_Y = 300;         // 光池圆心 y
  var POOL_R = 520;         // 光池半径
  var SHADOW_OFF = 12;      // 赛道长影偏移
  var TRACK_OUTER_EXTRA = 4; // 外描边比路面宽出的总量（每侧 2px）
  var SLOT_STEP = 8;        // 槽线采样间隔
  var SLOT_W = 4;           // 槽线宽度
  var SLOT_ALPHA = 0.85;    // 槽线不透明度
  var RAIL_OFFSET = 4;      // 导电轨距槽线中心的法向距离
  var RAIL_W = 1;           // 导电轨宽度
  var SEAM_W = 2;           // 接缝线宽
  var CLASP_W = 6;          // 接缝卡扣宽
  var CLASP_H = 4;          // 接缝卡扣高
  var CLASP_R = 2;          // 接缝卡扣圆角
  var START_CELL = 12;      // 起点格边长
  var START_COLS = 2;       // 起点格列数（沿法向）
  var START_ROWS = 3;       // 起点格行数（沿切向）
  var START_EDGE = 2;       // 起点白边宽度

  var COL = {
    ink: '#2B2320',         // 描边 / 阴影
    paper: '#E9DCC4',       // 墙与纸底
    wood: '#C98B55',        // 木地板
    rug: '#7A3E3A',         // 地毯
    asphalt: '#3A3F47'      // 赛道路面
  };

  // RGB 字面量拼装，避免重复写 rgba 字符串
  function rgba(r, g, b, a) { return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')'; }

  var INK_30 = rgba(43, 35, 32, 0.3);
  var INK_22 = rgba(43, 35, 32, 0.22);
  var INK_18 = rgba(43, 35, 32, 0.18);
  var INK_45 = rgba(43, 35, 32, 0.45);
  var RAIL = rgba(140, 150, 163, 0.55);
  var START_WHITE = '#FFFFFF';
  var PAPER_35 = rgba(233, 220, 196, 0.35);
  var PAPER_15 = rgba(233, 220, 196, 0.15);
  var PAPER_06 = rgba(233, 220, 196, 0.06);
  var PAPER_00 = rgba(233, 220, 196, 0);
  var INK_00 = rgba(43, 35, 32, 0);

  // 圆角矩形路径（不依赖 ctx.roundRect，兼容旧内核）
  function roundRectPath(ctx, x, y, w, h, r) {
    var rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.arcTo(x + w, y, x + w, y + rr, rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
    ctx.lineTo(x + rr, y + h);
    ctx.arcTo(x, y + h, x, y + h - rr, rr);
    ctx.lineTo(x, y + rr);
    ctx.arcTo(x, y, x + rr, y, rr);
    ctx.closePath();
  }

  // 第 1 层：墙面（顶部纸色墙带 + 底部投影）
  function drawWall(ctx) {
    ctx.fillStyle = COL.paper;
    ctx.fillRect(0, 0, W, WALL_H);
    ctx.fillStyle = INK_30;
    ctx.fillRect(0, WALL_H - 6, W, 6);
  }

  // 第 2 层：木地板（竖缝 + 错缝端头 + 随机亮点）
  // 顶部 WALL_H 留给墙面，否则「整屏」会把第 1 层完全盖住
  function drawFloor(ctx) {
    var top = WALL_H;
    var h = H - top;
    ctx.fillStyle = COL.wood;
    ctx.fillRect(0, top, W, h);

    var x, y, col;
    // 竖缝：每 40px 一条 2px
    ctx.fillStyle = INK_22;
    for (x = 0; x <= W; x += PLANK_W) {
      ctx.fillRect(x - 1, top, 2, h);
    }
    // 端缝：奇偶列错开 120px，每 240px 一条横缝
    for (col = 0, x = 0; x < W; col++, x += PLANK_W) {
      var startY = top + (col % 2) * SEAM_STAGGER;
      for (y = startY; y < H; y += PLANK_L) {
        if (y <= top) continue;
        ctx.fillRect(x, y - 1, PLANK_W, 2);
      }
    }

    // 亮点：固定种子，保证每次构建结果一致
    var rnd = RaceUtil ? RaceUtil.mulberry32(7) : null;
    if (rnd) {
      ctx.fillStyle = PAPER_06;
      for (var i = 0; i < FLOOR_DOTS; i++) {
        var px = Math.floor(rnd() * W);
        var py = top + Math.floor(rnd() * h);
        ctx.fillRect(px, py, 1, 1);
      }
    }
  }

  // 第 3 层：地毯（圆角主体 + 内缩边框）
  function drawRug(ctx) {
    var x = Math.round((W - RUG_W) / 2);
    var y = Math.round((H - RUG_H) / 2);

    roundRectPath(ctx, x, y, RUG_W, RUG_H, RUG_R);
    ctx.fillStyle = COL.rug;
    ctx.fill();

    roundRectPath(
      ctx,
      x + RUG_INSET, y + RUG_INSET,
      RUG_W - RUG_INSET * 2, RUG_H - RUG_INSET * 2,
      Math.max(0, RUG_R - RUG_INSET)
    );
    ctx.lineWidth = RUG_BORDER;
    ctx.strokeStyle = PAPER_35;
    ctx.stroke();
  }

  // 第 4 层：光池 + 四角暗角
  function drawLight(ctx) {
    var pool = ctx.createRadialGradient(POOL_X, POOL_Y, 0, POOL_X, POOL_Y, POOL_R);
    pool.addColorStop(0, PAPER_15);
    pool.addColorStop(1, PAPER_00);
    ctx.fillStyle = pool;
    ctx.fillRect(0, 0, W, H);

    var corners = [[0, 0], [W, 0], [0, H], [W, H]];
    var r = Math.round(POOL_R * 0.88);
    for (var i = 0; i < corners.length; i++) {
      var cx = corners[i][0], cy = corners[i][1];
      var vig = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      vig.addColorStop(0, INK_22);
      vig.addColorStop(1, INK_00);
      ctx.fillStyle = vig;
      ctx.fillRect(0, 0, W, H);
    }
  }

  // 中心线点集 → 闭合路径
  function traceTrack(ctx, points) {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (var i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.closePath();
  }

  // 第 5 层：赛道（长影 + 外描边 + 路面），宽度全部取自 track.width
  function drawTrack(ctx, track) {
    var points = track.points;
    var trackW = Number(track.width);
    if (!(trackW > 0)) return;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // 长影：整体平移后同宽描一遍
    ctx.save();
    ctx.translate(SHADOW_OFF, SHADOW_OFF);
    traceTrack(ctx, points);
    ctx.lineWidth = trackW;
    ctx.strokeStyle = INK_18;
    ctx.stroke();
    ctx.restore();

    traceTrack(ctx, points);
    ctx.lineWidth = trackW + TRACK_OUTER_EXTRA;
    ctx.strokeStyle = COL.ink;
    ctx.stroke();

    ctx.lineWidth = trackW;
    ctx.strokeStyle = COL.asphalt;
    ctx.stroke();
  }

  // 沿某条槽的采样点连成闭合路径（每 SLOT_STEP 一个点）
  function traceSlot(ctx, track, lane, total) {
    var p = track.pointAt(0, lane);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    for (var s = SLOT_STEP; s < total; s += SLOT_STEP) {
      p = track.pointAt(s, lane);
      ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
  }

  // 槽线两侧各 RAIL_OFFSET 处的 1px 导电轨（沿法向偏移）
  function traceRail(ctx, track, lane, side, total) {
    var p, n, off;
    ctx.beginPath();
    for (var s = 0; s < total; s += SLOT_STEP) {
      p = track.pointAt(s, lane);
      n = track.sampleAt(s);
      off = side * RAIL_OFFSET;
      var x = p.x - n.ty * off;
      var y = p.y + n.tx * off;
      if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
  }

  // 第 6 层：两条槽线 + 每条两侧各两条导电轨
  function drawSlots(ctx, track) {
    var total = Number(track.totalLength);
    if (!(total > 0) || typeof track.sampleAt !== 'function') return;
    var lanes = [1, -1];
    var i;

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // 导电轨先画，压在槽线下方
    ctx.strokeStyle = RAIL;
    ctx.lineWidth = RAIL_W;
    for (i = 0; i < lanes.length; i++) {
      traceRail(ctx, track, lanes[i], 1, total);
      ctx.stroke();
      traceRail(ctx, track, lanes[i], -1, total);
      ctx.stroke();
    }

    // 槽线本体
    ctx.save();
    ctx.globalAlpha = SLOT_ALPHA;
    ctx.strokeStyle = COL.ink;
    ctx.lineWidth = SLOT_W;
    for (i = 0; i < lanes.length; i++) {
      traceSlot(ctx, track, lanes[i], total);
      ctx.stroke();
    }
    ctx.restore();
  }

  // 第 7 层：接缝（垂直赛道的 2px 线 + 两端 6×4 圆角卡扣）
  function drawSeams(ctx, track) {
    var seams = track.seams;
    var trackW = Number(track.width);
    if (!seams || !seams.length || !(trackW > 0)) return;
    var half = trackW / 2;

    for (var i = 0; i < seams.length; i++) {
      var sm = seams[i];
      ctx.save();
      ctx.translate(sm.x, sm.y);
      ctx.rotate(sm.angle);

      ctx.beginPath();
      ctx.moveTo(-half, 0);
      ctx.lineTo(half, 0);
      ctx.lineWidth = SEAM_W;
      ctx.strokeStyle = INK_45;
      ctx.stroke();

      ctx.fillStyle = COL.ink;
      var ends = [-half, half];
      for (var e = 0; e < ends.length; e++) {
        roundRectPath(ctx, ends[e] - CLASP_W / 2, -CLASP_H / 2, CLASP_W, CLASP_H, CLASP_R);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  // 第 8 层：起点黑白格（2 列 × 3 行，每格 12px，沿法向铺开）+ 2px 白边
  function drawStartLine(ctx, track) {
    var st = track.startLine;
    if (!st) return;
    var gridW = START_COLS * START_CELL;
    var gridH = START_ROWS * START_CELL;
    var x0 = -gridW / 2;
    var y0 = -gridH / 2;

    ctx.save();
    ctx.translate(st.x, st.y);
    ctx.rotate(st.angle);

    for (var col = 0; col < START_COLS; col++) {
      for (var row = 0; row < START_ROWS; row++) {
        ctx.fillStyle = ((col + row) % 2 === 0) ? COL.ink : START_WHITE;
        ctx.fillRect(x0 + col * START_CELL, y0 + row * START_CELL, START_CELL, START_CELL);
      }
    }

    ctx.lineWidth = START_EDGE;
    ctx.strokeStyle = START_WHITE;
    ctx.strokeRect(x0, y0, gridW, gridH);
    ctx.restore();
  }

  // 构建 1280×720 场景底图，返回 { canvas, width, height }；canvas 为 DPR 物理像素
  function build(track) {
    var dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2);
    var canvas = document.createElement('canvas');
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    drawWall(ctx);
    drawFloor(ctx);
    drawRug(ctx);
    drawLight(ctx);

    if (track && track.points && track.points.length > 1) {
      drawTrack(ctx, track);
      if (typeof track.pointAt === 'function') drawSlots(ctx, track);
      drawSeams(ctx, track);
      drawStartLine(ctx, track);
    }

    return { canvas: canvas, width: W, height: H };
  }

  return { build: build, width: W, height: H };
});
