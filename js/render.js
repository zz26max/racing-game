/* 画面入口与画车：底图 + 两辆车（UMD：浏览器挂 window.RaceRender，Node 走 module.exports） */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    var util = null;
    try { util = require('./util.js'); } catch (e) { util = null; }
    module.exports = factory(util);
  } else {
    root.RaceRender = factory(root.RaceUtil);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (RaceUtil) {
  'use strict';

  var W = 1280;             // 逻辑宽
  var H = 720;              // 逻辑高
  var CAR_W = 42;           // 底盘宽
  var CAR_H = 26;           // 底盘高
  var CAR_R = 5;            // 底盘圆角
  var BODY_W = 38;          // 车壳宽
  var BODY_H = 22;          // 车壳高
  var BODY_R = 7;           // 车壳圆角
  var WHEEL_W = 10;         // 车轮宽
  var WHEEL_H = 5;          // 车轮高
  var WHEEL_X = 17;         // 车轮中心横向偏移
  var WHEEL_Y = 9;          // 车轮中心纵向偏移
  var SHADOW_OFF = 3;       // 影子偏移
  var BLINK_PERIOD = 0.12;  // 复位闪烁周期（秒）
  var DERAIL_TIME = 0.9;    // 脱轨旋转总时长（与 car.js DERAIL_TIME 一致）
  var DERAIL_SPIN = 540;    // 脱轨期间额外旋转角度（度）
  var DERAIL_SCALE = 1.15;  // 脱轨放大倍数
  var JITTER = 1.5;         // 打滑抖动幅度（px）
  var SLIP_THRESHOLD = 0.6; // 触发抖动的 slip 阈值
  var SPEED_LINE_MIN = 16;  // 速度线最短长度
  var SPEED_LINE_MAX = 36;  // 速度线最长长度
  var SPEED_LINE_GAP = 22;  // 速度线起点距车尾的距离
  var FONT = '"Microsoft YaHei","PingFang SC",sans-serif'; // 界面字体栈
  var HUD_Y = 24;           // 玩家面板上边距
  var HUD_W = 280;          // 玩家面板宽
  var HUD_H = 76;           // 玩家面板高（两列：左 P/速度条，右 圈数/上圈）
  var HUD_R = 16;           // 玩家面板圆角
  var P2_X = 968;           // P2 面板左边（镜像到右侧）
  var SPEED_BAR_W = 130;    // 速度条宽
  var SPEED_BAR_H = 7;      // 速度条高
  var SPEED_MAX = 400;      // 速度条对应满速
  var COUNTDOWN_GO = 0.8;   // 倒计时最后 0.8 秒显示 GO!
  var DEFAULT_LAPS = 3;     // 未取到 race.laps 时的圈数

  // 标题选择器两侧箭头的点击命中矩形（逻辑坐标，drawTitle 每帧记录）
  var titleArrowHits = { left: null, right: null };
  // 标题选择器整行的命中区（逻辑坐标，drawTitle 每帧记录；未绘制过为 null）
  var titleRowHit = null;
  var TITLE_ROW_HALF_H = 44;   // 选择器基线上下各 44px 内算命中整行
  var TITLE_ROW_PAD_X = 60;    // 名称左右边缘各外扩 60px（再放宽到纸卡横向范围，见 drawTitle）

  var COL = {
    ink: '#2B2320',
    seat: '#3A4A57',
    text: '#E9DCC4',
    p1: '#E8503A',
    p2: '#2F8FD6'
  };

  var INK_SHADOW = 'rgba(43,35,32,.35)';
  var PAPER_HL = 'rgba(233,220,196,.6)';
  var PAPER_LINE = 'rgba(233,220,196,.5)';
  var PANEL_SHADOW = 'rgba(43,35,32,.18)';
  var TRACK_15 = 'rgba(43,35,32,.15)';
  var DIM_RESULT = 'rgba(27,23,20,.55)';
  var DIM_TITLE = 'rgba(27,23,20,.45)';
  var GOLD = '#FFC83D';
  var PAPER = '#E9DCC4';

  // 限制到 [a, b]
  function clamp(v, a, b) {
    if (RaceUtil && typeof RaceUtil.clamp === 'function') return RaceUtil.clamp(v, a, b);
    if (v < a) return a;
    if (v > b) return b;
    return v;
  }

  // 统一字体：调用方只给字重与字号
  function setFont(ctx, weight, px) {
    ctx.font = weight + ' ' + px + 'px ' + FONT;
  }

  // 总成绩文本：优先 RaceUtil.formatTime
  function fmtTime(v) {
    if (RaceUtil && typeof RaceUtil.formatTime === 'function') return RaceUtil.formatTime(v);
    var ms = Math.round(Number(v) * 1000);
    if (!isFinite(ms) || ms < 0) ms = 0;
    var total = Math.floor(ms / 1000);
    var mmm = ms - total * 1000;
    var mm = Math.floor(total / 60);
    var ss = total - mm * 60;
    return mm + ':' + (ss < 10 ? '0' + ss : String(ss)) + '.' + (mmm < 10 ? '00' + mmm : (mmm < 100 ? '0' + mmm : String(mmm)));
  }

  // 单圈成绩文本：优先 RaceUtil.formatLap
  function fmtLap(v) {
    if (RaceUtil && typeof RaceUtil.formatLap === 'function') return RaceUtil.formatLap(v);
    var ms = Math.round(Number(v) * 1000);
    if (!isFinite(ms) || ms < 0) ms = 0;
    var total = Math.floor(ms / 1000);
    var mmm = ms - total * 1000;
    return (total < 10 ? '0' + total : String(total)) + '.' + (mmm < 10 ? '00' + mmm : (mmm < 100 ? '0' + mmm : String(mmm)));
  }

  // 玩家面板：P1 在左（文字左对齐），P2 镜像到右（文字右对齐）
  function drawPlayerPanel(ctx, race, index, mirrored, best) {
    var x = mirrored ? P2_X : 32;
    var y = HUD_Y;
    var entry = race && race.entries ? race.entries[index] : null;
    var car = entry && entry.car ? entry.car : null;
    var laps = race && race.laps > 0 ? Math.floor(race.laps) : DEFAULT_LAPS;
    var barColor = index === 1 ? COL.p2 : COL.p1;

    // 影子 + 面板 + 2px 描边
    roundRectPath(ctx, x + 3, y + 3, HUD_W, HUD_H, HUD_R);
    ctx.fillStyle = PANEL_SHADOW;
    ctx.fill();
    roundRectPath(ctx, x, y, HUD_W, HUD_H, HUD_R);
    ctx.fillStyle = PAPER;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = COL.ink;
    ctx.stroke();

    var leftX = x + 20;           // 左列起点
    var rightX = x + HUD_W - 20;  // 右列终点（右对齐）
    ctx.textBaseline = 'middle';

    // 左列第 1 行：车手名
    ctx.textAlign = 'left';
    setFont(ctx, 'bold', 20);
    ctx.fillStyle = COL.ink;
    ctx.fillText('P' + (index + 1), leftX, y + 28);

    // 左列第 2 行：速度条（底色 + 按 speed/400 的比例填充队伍色）
    var barY = y + 42;
    roundRectPath(ctx, leftX, barY, SPEED_BAR_W, SPEED_BAR_H, SPEED_BAR_H / 2);
    ctx.fillStyle = TRACK_15;
    ctx.fill();
    var speed = car ? Number(car.speed) || 0 : 0;
    var ratio = clamp(speed / SPEED_MAX, 0, 1);
    var fw = Math.round(SPEED_BAR_W * ratio);
    if (fw > 0) {
      roundRectPath(ctx, leftX, barY, fw, SPEED_BAR_H, Math.min(SPEED_BAR_H / 2, fw / 2));
      ctx.fillStyle = barColor;
      ctx.fill();
    }

    // 速度条下方：油门量条（y+56，130×5，深墨半透明以在纸色面板上可辨）
    var thrUse = car ? clamp(Number(car.throttle) || 0, 0, 1) : 0;
    fillMiniBar(ctx, leftX, y + 56, thrUse, 'rgba(43,35,32,.72)', 5);

    // 再下方：抓地条（y+63，130×4，按 gripUse 分档着色）
    var gripUse = car ? Math.max(Number(car.gripUse) || 0, 0) : 0;
    var gripColor = barColor;
    if (gripUse > 1) gripColor = COL.p1;
    else if (gripUse >= 0.75) gripColor = GOLD;
    fillMiniBar(ctx, leftX, y + 63, clamp(gripUse, 0, 1), gripColor);

    // 右列：圈数（第 1 行）与上一圈用时（第 2 行），统一右对齐到面板内侧
    var lapNow = entry ? (entry.finished ? laps : Math.min(entry.lap + 1, laps)) : 1;
    ctx.textAlign = 'right';
    setFont(ctx, 'normal', 14);
    ctx.fillStyle = COL.ink;
    ctx.fillText('圈 ' + lapNow + '/' + laps, rightX, y + 31);

    var lapTxt = '--';
    if (entry && entry.lapTimes && entry.lapTimes.length) {
      lapTxt = fmtLap(entry.lapTimes[entry.lapTimes.length - 1]);
    }
    setFont(ctx, 'normal', 11);
    ctx.fillStyle = 'rgba(43,35,32,.65)';
    ctx.fillText('上圈 ' + lapTxt, rightX, y + 46);

    // 右上角提示：抓地透支且已松油到可救区间
    if (car && car.saveWindow) {
      setFont(ctx, 'normal', 11);
      ctx.fillStyle = COL.p1;
      ctx.fillText('松油可救', rightX, y + 18);
    }
  }

  // 面板内细指示条：130×4（可传 h 覆写高度），底色 + 按比例填充
  function fillMiniBar(ctx, x, y, ratio, color, h) {
    var W_BAR = SPEED_BAR_W;
    var H_BAR = h || 4;
    roundRectPath(ctx, x, y, W_BAR, H_BAR, H_BAR / 2);
    ctx.fillStyle = TRACK_15;
    ctx.fill();
    var fw = Math.round(W_BAR * clamp(ratio, 0, 1));
    if (fw > 0) {
      roundRectPath(ctx, x, y, fw, H_BAR, Math.min(2, fw / 2));
      ctx.fillStyle = color;
      ctx.fill();
    }
  }

  // 中上：总计时 + 当前圈（倒计时期间计时显示占位）
  function drawCenterHUD(ctx, race, phase) {
    var laps = race && race.laps > 0 ? Math.floor(race.laps) : DEFAULT_LAPS;
    var entries = race && race.entries ? race.entries : [];
    var leader = 0;
    for (var i = 0; i < entries.length; i++) {
      var lp = entries[i] && entries[i].lap ? entries[i].lap : 0;
      if (lp > leader) leader = lp;
    }
    var lapNow = Math.min(leader + 1, laps);
    var timeTxt = phase === 'countdown' ? '--:--' : fmtTime(race ? race.elapsed : 0);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    setFont(ctx, 'bold', 28);
    // 纸色描边 + 深墨填充：深色底图上仍可读
    ctx.lineWidth = 5;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = COL.text;
    ctx.strokeText(timeTxt, W / 2, 56);
    ctx.fillStyle = COL.ink;
    ctx.fillText(timeTxt, W / 2, 56);

    // 圈数行同样纸色描边，填充用半透明深墨
    setFont(ctx, 'normal', 13);
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = COL.text;
    ctx.strokeText('第 ' + lapNow + ' 圈 / ' + laps, W / 2, 82);
    ctx.fillStyle = 'rgba(43,35,32,.75)';
    ctx.fillText('第 ' + lapNow + ' 圈 / ' + laps, W / 2, 82);
  }

  // 倒计时：3.2 → 3；最后 0.8 秒显示 GO!
  function drawCountdown(ctx, s) {
    var rem = Number(s.countdownT);
    if (!isFinite(rem) || rem <= 0) return;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    setFont(ctx, 'bold', 160);
    ctx.lineWidth = 8;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = COL.ink;

    if (rem > COUNTDOWN_GO) {
      var n = Math.ceil(rem - COUNTDOWN_GO);
      var txt = String(n);
      ctx.strokeText(txt, W / 2, 360);
      ctx.fillStyle = PAPER;
      ctx.fillText(txt, W / 2, 360);
    } else {
      ctx.strokeText('GO!', W / 2, 360);
      ctx.fillStyle = GOLD;
      ctx.fillText('GO!', W / 2, 360);
    }
  }

  // 结算面板：胜者标题 + 每位玩家的总时间与最佳圈
  function drawResult(ctx, s) {
    var race = s.race;
    var entries = race && race.entries ? race.entries : [];
    var winner = race ? race.winner : null;

    ctx.fillStyle = DIM_RESULT;
    ctx.fillRect(0, 0, W, H);

    var px = 280, py = 140, pw = 720, ph = 440;
    roundRectPath(ctx, px, py, pw, ph, HUD_R);
    ctx.fillStyle = PAPER;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = COL.ink;
    ctx.stroke();

    // 胜者名：优先车名，缺省回退 P1/P2
    var wName = winner && winner.car && winner.car.name ? String(winner.car.name) : '';
    if (!wName && entries.length) {
      var wi = entries.indexOf(winner);
      wName = 'P' + ((wi < 0 ? 0 : wi) + 1);
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    setFont(ctx, 'bold', 56);
    ctx.fillStyle = COL.ink;
    ctx.fillText((wName || 'P1') + ' 获胜！', W / 2, 226);

    // 表头：玩家 / 总时间 / 最佳圈（与下方数据行同一组列锚点）
    setFont(ctx, 'normal', 14);
    ctx.fillStyle = 'rgba(43,35,32,.6)';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText('玩家', px + 40, 286);
    ctx.textAlign = 'right';
    ctx.fillText('总时间', px + 360, 286);
    ctx.fillText('最佳圈', px + 660, 286);

    // 每位玩家一行，行高 40
    var rowY = 320;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var name = e && e.car && e.car.name ? String(e.car.name) : 'P' + (i + 1);
      var totalTxt = e && e.finishTime !== null && e.finishTime !== undefined
        ? fmtTime(e.finishTime)
        : (e && e.finished ? fmtTime(race.elapsed) : '未完赛');
      var bestTxt = e && e.bestLap !== null && e.bestLap !== undefined ? fmtLap(e.bestLap) : '—';

      ctx.textBaseline = 'middle';
      setFont(ctx, 'bold', 24);
      ctx.textAlign = 'left';
      ctx.fillStyle = i === 1 ? COL.p2 : COL.p1;
      ctx.fillText(name, px + 40, rowY);

      setFont(ctx, 'normal', 24);
      ctx.textAlign = 'right';
      ctx.fillStyle = COL.ink;
      ctx.fillText(totalTxt, px + 360, rowY);
      ctx.fillText(bestTxt, px + 660, rowY);

      rowY += 40;
    }

    // 分圈记录：每位玩家一行，最多显示最近 3 圈
    var lapY = py + 330;
    for (var k = 0; k < entries.length; k++) {
      var entry = entries[k];
      var lapTxt = '—';
      if (entry && entry.lapTimes && entry.lapTimes.length) {
        var recent = entry.lapTimes.slice(-3);
        var parts = [];
        for (var n = 0; n < recent.length; n++) parts.push(fmtLap(recent[n]));
        lapTxt = parts.join(' · ');
      }
      setFont(ctx, 'normal', 13);
      ctx.textAlign = 'left';
      ctx.fillStyle = COL.ink;
      ctx.fillText('P' + (k + 1) + ' 分圈  ' + lapTxt, px + 40, lapY);
      lapY += 20;
    }

    // 分圈与底部提示之间的细分隔线
    ctx.fillStyle = 'rgba(43,35,32,.12)';
    ctx.fillRect(px + 40, py + 380, pw - 80, 2);

    // 底部提示
    setFont(ctx, 'normal', 18);
    ctx.textAlign = 'center';
    ctx.fillStyle = COL.ink;
    ctx.fillText('按 R 再来一局 · Esc 返回标题', W / 2, 540);
  }

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

  // 车辆序号：draw 遍历时传入；单独调用时从 entry / car 上推断（P2 也可按车名识别）
  function entryIndex(entry) {
    var i = entry ? entry.index : undefined;
    if (i === undefined && entry) i = entry.playerIndex;
    if (i === undefined && entry && entry.car) i = entry.car.index;
    if (i === undefined) {
      var name = (entry && entry.name) || (entry && entry.car && entry.car.name) || '';
      return /2/.test(String(name)) ? 1 : 0;
    }
    i = Number(i);
    return isFinite(i) ? i : 0;
  }

  // 队伍色：0 号为 P1（红），1 号为 P2（蓝）
  function teamColor(index) {
    return index === 1 ? COL.p2 : COL.p1;
  }

  // 车尾速度线：油门大且速度快时，3 条 3px 线，长度随速度
  function drawSpeedLines(ctx, speed) {
    var t = clamp((speed - 150) / 250, 0, 1);
    var len = SPEED_LINE_MIN + t * (SPEED_LINE_MAX - SPEED_LINE_MIN);
    var x0 = -SPEED_LINE_GAP;
    var x1 = x0 - len;
    ctx.strokeStyle = PAPER_LINE;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (var i = -1; i <= 1; i++) {
      var y = i * 7;
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
    }
    ctx.stroke();
  }

  // 画一辆车：entry = { car, lane, ... }，time 为秒（抖动/闪烁用）
  function drawCarImpl(ctx, track, entry, time, index) {
    var car = entry && entry.car ? entry.car : entry;
    if (!ctx || !track || !car || typeof track.pointAt !== 'function') return;

    var lane = car.lane !== undefined ? car.lane : entry.lane;
    var p = track.pointAt(car.s, lane);
    if (!p) return;

    // 切线：pointAt 只返回位置，方向取自 sampleAt
    var tx = 1, ty = 0;
    if (typeof track.sampleAt === 'function') {
      var tan = track.sampleAt(car.s);
      if (tan) { tx = tan.tx; ty = tan.ty; }
    }

    // 法向 (-ty, tx)：打滑时沿滑向偏移
    var off = Number(car.offset) || 0;
    if (off > 0) {
      var side = car.slideSide === -1 ? -1 : 1;
      p.x += -ty * off * side;
      p.y += tx * off * side;
    }

    // 打滑抖动
    var jx = 0, jy = 0;
    var slip = Number(car.slip) || 0;
    if (slip > SLIP_THRESHOLD) {
      var tSec = Number(time) || 0;
      jx = Math.sin(tSec * 90) * JITTER;
      jy = Math.cos(tSec * 77) * JITTER;
    }

    var a = Math.atan2(ty, tx);
    var derailed = !!car.derailed;
    var rot = a;
    var scale = 1;
    if (derailed) {
      var dt = clamp(Number(car.derailT) || 0, 0, DERAIL_TIME);
      rot += (1 - dt / DERAIL_TIME) * (DERAIL_SPIN * Math.PI / 180);
      scale = DERAIL_SCALE;
    }

    var color = teamColor(index);
    var label = index === 1 ? '2' : '1';

    ctx.save();
    ctx.translate(p.x + jx, p.y + jy);

    // 影子不随车旋转：先画在 (+3, +3)
    ctx.save();
    ctx.translate(SHADOW_OFF, SHADOW_OFF);
    roundRectPath(ctx, -CAR_W / 2, -CAR_H / 2, CAR_W, CAR_H, CAR_R);
    ctx.fillStyle = INK_SHADOW;
    ctx.fill();
    ctx.restore();

    ctx.rotate(rot);
    if (scale !== 1) ctx.scale(scale, scale);

    // 复位闪烁：每 120ms 在 1 / 0.3 之间切换
    var blinkT = Number(car.blinkT) || 0;
    if (blinkT > 0) {
      var phase = Math.floor((Number(time) || 0) / BLINK_PERIOD);
      ctx.globalAlpha = (phase % 2 === 0) ? 1 : 0.3;
    }

    // 底盘
    roundRectPath(ctx, -CAR_W / 2, -CAR_H / 2, CAR_W, CAR_H, CAR_R);
    ctx.fillStyle = COL.ink;
    ctx.fill();

    // 四轮：10×5，位于 ±17, ±9
    var i;
    for (i = -1; i <= 1; i += 2) {
      for (var j = -1; j <= 1; j += 2) {
        roundRectPath(ctx, i * WHEEL_X - WHEEL_W / 2, j * WHEEL_Y - WHEEL_H / 2, WHEEL_W, WHEEL_H, WHEEL_H / 2);
        ctx.fillStyle = COL.ink;
        ctx.fill();
      }
    }

    // 车壳：队伍色 + 2px 描边
    roundRectPath(ctx, -BODY_W / 2, -BODY_H / 2, BODY_W, BODY_H, BODY_R);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = COL.ink;
    ctx.stroke();

    // 座舱：深色 + 2px 纸色高光（12×10，略前移）
    roundRectPath(ctx, -4, -5, 12, 10, 3.5);
    ctx.fillStyle = COL.seat;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = PAPER_HL;
    ctx.stroke();

    // 车号
    ctx.fillStyle = COL.text;
    setFont(ctx, 'bold', 11);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 0, 0.5);

    // P1：车头三角楔形尖头；P2：车尾 8×4 横条尾翼
    if (index === 1) {
      roundRectPath(ctx, -25, -2, 8, 4, 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = COL.ink;
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(BODY_W / 2 - 1, -8);
      ctx.lineTo(BODY_W / 2 + 9, 0);
      ctx.lineTo(BODY_W / 2 - 1, 8);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = COL.ink;
      ctx.stroke();
    }

    // 速度线：油门 > 0.6 且速度 > 150
    var throttle = Number(car.throttle) || 0;
    var speed = Number(car.speed) || 0;
    if (throttle > 0.6 && speed > 150) drawSpeedLines(ctx, speed);

    ctx.restore();
  }

  // 对外：画一辆车（单独调用时序号取 entry.index）
  function drawCar(ctx, track, entry, time) {
    drawCarImpl(ctx, track, entry, time, entryIndex(entry));
  }

  // HUD：两块玩家面板 + 中上计时；倒计时数字与结算面板按阶段附加
  function drawHUD(ctx, s) {
    if (!ctx || !s) return;
    var phase = s.phase;
    if (phase !== 'countdown' && phase !== 'running' && phase !== 'finished') return;
    var race = s.race || null;

    ctx.save();
    drawPlayerPanel(ctx, race, 0, false, s.best);
    drawPlayerPanel(ctx, race, 1, true, s.best);
    drawCenterHUD(ctx, race, phase);
    if (phase === 'countdown') drawCountdown(ctx, s);
    if (phase === 'finished') drawResult(ctx, s);
    ctx.restore();
  }

  // 粗估文本宽度：measureText 不可用时按每字 1em 估（CJK 全角近似）
  function textWidth(ctx, text, em) {
    text = String(text === null || text === undefined ? '' : text);
    if (!text) return 0;
    var m = null;
    try { m = ctx.measureText ? ctx.measureText(text) : null; } catch (err) { m = null; }
    if (m && isFinite(m.width) && m.width > 0) return m.width;
    return text.length * em;
  }

  // 记录单个箭头的命中矩形：宽 96、高 64，以箭头中心为基准，垂直中心对齐选择器基线
  function setArrowHit(side, cx, cy) {
    titleArrowHits[side] = { x: cx - 48, y: cy - 32, w: 96, h: 64 };
  }

  // 标题界面箭头命中测试：命中返回 'left' / 'right'，否则 null（逻辑坐标）
  function hitTestTitleArrow(x, y) {
    var px = Number(x), py = Number(y);
    if (!isFinite(px) || !isFinite(py)) return null;
    var l = titleArrowHits.left, r = titleArrowHits.right;
    if (l && px >= l.x && px <= l.x + l.w && py >= l.y && py <= l.y + l.h) return 'left';
    if (r && px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return 'right';
    return null;
  }

  // 标题界面整行命中测试：落在选择器那一行（基线上下 44px）就按名称中心分左右半平面，
  // 命中返回 'left' / 'right'，否则 null；未绘制过标题或只有一条赛道时返回 null
  function hitTestTitleRow(x, y) {
    var px = Number(x), py = Number(y);
    if (!isFinite(px) || !isFinite(py)) return null;
    var row = titleRowHit;
    if (!row || row.trackCount < 2) return null;
    if (py < row.baseY - TITLE_ROW_HALF_H || py > row.baseY + TITLE_ROW_HALF_H) return null;
    if (px < row.minX || px > row.maxX) return null;
    return px < row.nameCx ? 'left' : 'right';
  }

  // 标题界面：压暗底图 + 标题 / 副标题 / 操作提示 / 呼吸闪烁的开始提示
  function drawTitle(ctx, s) {
    if (!ctx || !s) return;
    var t = Number(s.time) || 0;
    titleArrowHits.left = null;
    titleArrowHits.right = null;
    titleRowHit = null;

    ctx.save();
    ctx.fillStyle = DIM_TITLE;
    ctx.fillRect(0, 0, W, H);

    // 纸卡：760×330 居中，避免标题压在赛道上
    var cardX = 260, cardY = 150, cardW = 760, cardH = 330;
    roundRectPath(ctx, cardX + 4, cardY + 4, cardW, cardH, 16);
    ctx.fillStyle = 'rgba(43,35,32,.25)';
    ctx.fill();
    roundRectPath(ctx, cardX, cardY, cardW, cardH, 16);
    ctx.fillStyle = 'rgba(233,220,196,.94)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = COL.ink;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    setFont(ctx, 'bold', 88);
    ctx.fillStyle = COL.ink;
    ctx.fillText('轨道赛车', W / 2, 268);

    setFont(ctx, 'normal', 24);
    ctx.fillStyle = 'rgba(43,35,32,.75)';
    ctx.fillText('《双人成行》阁楼小游戏 · 程序化复刻', W / 2, 330);

    // 赛道选择器：◀  名称  ▶（方向键 / A·D / 点击箭头切换，localStorage 记忆）
    var trackCount = Number(s.trackCount) || 0;
    if (trackCount > 1) {
      setFont(ctx, 'bold', 20);
      ctx.fillStyle = COL.ink;
      var name = String(s.trackName || '');
      var arrowLW = textWidth(ctx, '◀', 20);
      var arrowRW = textWidth(ctx, '▶', 20);
      var nameW = textWidth(ctx, name, 20);
      var gap = 28;                                  // 箭头与名称的间距
      var baseY = 368;
      var startX = W / 2 - (arrowLW + gap + nameW + gap + arrowRW) / 2;
      var leftCx = startX + arrowLW / 2;
      var nameCx = startX + arrowLW + gap + nameW / 2;
      var rightCx = startX + arrowLW + gap + nameW + gap + arrowRW / 2;
      ctx.fillText('◀', leftCx, baseY);
      ctx.fillText(name, nameCx, baseY);
      ctx.fillText('▶', rightCx, baseY);
      setArrowHit('left', leftCx, baseY);
      setArrowHit('right', rightCx, baseY);
      // 整行命中：名称左右边缘各外扩 60px，并放宽到纸卡横向范围（侧边栏缩放后整行都好点）
      titleRowHit = {
        baseY: baseY,
        nameCx: nameCx,
        minX: Math.min(nameCx - nameW / 2 - TITLE_ROW_PAD_X, cardX),
        maxX: Math.max(nameCx + nameW / 2 + TITLE_ROW_PAD_X, cardX + cardW),
        trackCount: trackCount
      };
      setFont(ctx, 'normal', 13);
      ctx.fillStyle = 'rgba(43,35,32,.6)';
      ctx.fillText(s.trackDesc || '', W / 2, 392);
    }

    setFont(ctx, 'normal', 17);
    ctx.fillStyle = COL.ink;
    ctx.fillText('P1：W 或空格 油门　　P2：↑ / Enter / 右 Shift 油门', W / 2, 420);
    ctx.fillText((trackCount > 1 ? '←/→ 或 A/D 或点击箭头切赛道　' : '') + 'P 暂停　M 静音　R 重开', W / 2, 446);

    // 1Hz 呼吸闪烁（0.45~1，纸卡上不用金色）
    setFont(ctx, 'bold', 22);
    ctx.fillStyle = COL.ink;
    ctx.globalAlpha = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * Math.PI * 2));
    ctx.fillText('点击页面后按 Enter 开始', W / 2, 470);
    ctx.globalAlpha = 1;

    ctx.restore();
  }

  // 粒子发射与推进：下一阶段补充
  function emit() {
    return;
  }

  function updateParticles() {
    return;
  }

  // 画面入口：底图 → 全部车辆 → HUD
  function draw(ctx, s) {
    if (!ctx || !s) return;
    var scene = s.scene;
    if (scene) {
      try {
        ctx.drawImage(scene, 0, 0, W, H);
      } catch (e) {
        scene = null;
      }
    }

    var race = s.race;
    var track = s.track || (race && race.track) || null;
    var time = Number(s.time) || 0;
    if (race && race.entries && race.entries.length) {
      for (var i = 0; i < race.entries.length; i++) {
        drawCarImpl(ctx, track, race.entries[i], time, i);
      }
    }

    if (s.phase === 'title') drawTitle(ctx, s);
    else drawHUD(ctx, s);
  }

  return {
    draw: draw,
    drawCar: drawCar,
    drawHUD: drawHUD,
    drawTitle: drawTitle,
    hitTestTitleArrow: hitTestTitleArrow,
    hitTestTitleRow: hitTestTitleRow,
    emit: emit,
    updateParticles: updateParticles,
    width: W,
    height: H
  };
});
