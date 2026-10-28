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
  // 赛道坐标（原点在赛道中心）→ 画布坐标的平移量；底图的赛道层与车辆必须用同一个
  var ORIGIN_X = W / 2;
  var ORIGIN_Y = H / 2;
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

  // ---- 桌游纸卡 UI 令牌（风格 A：奶油纸卡片 + 墨色描边 + 实色硬投影）----
  // 触控目标 ≥44 逻辑像素（Apple HIG 44pt / Material 48dp）；可视图形可以比命中区小
  var CHIP_H = 44;           // 芯片高（触控下限）
  var CHIP_W = 46;           // 图标芯片宽
  var CHIP_R = 12;           // 芯片圆角
  var CHIP_BORDER = 2.5;     // 墨色描边宽
  var CHIP_DROP = 4;         // 硬投影偏移（按下时视觉间隙收成 1px）
  var UI_SHADOW = 'rgba(43,35,32,.35)';
  var UI_WOOD = '#C98B55';       // 主操作芯片面（木色）
  var UI_WOOD_PRESS = '#A9743C'; // 按下时木色加深
  var UI_PAPER = 'rgba(233,220,196,.96)';
  var CHIP_ROW_Y = 24;       // 比赛阶段芯片行（与玩家面板同排）
  var CHIP_PAUSE_X = 828;    // 暂停芯片：828..874（中上计时与 P2 面板之间）
  var CHIP_MUTE_X = 884;     // 静音芯片：884..930（距 P2 面板 38px）

  // 屏上按钮命中注册：每帧由 drawTitle / drawHUD 重建，检测时从最上层（最后注册）往回找
  var uiHits = [];
  function uiBeginFrame() { uiHits.length = 0; }
  function registerUI(id, x, y, w, h) { uiHits.push({ id: id, x: x, y: y, w: w, h: h }); }
  // 逻辑坐标命中测试：命中返回按钮 id（'pause'/'mute'/'resume'/…），否则 null
  function hitTestUI(x, y) {
    var px = Number(x), py = Number(y);
    if (!isFinite(px) || !isFinite(py)) return null;
    for (var i = uiHits.length - 1; i >= 0; i--) {
      var b = uiHits[i];
      if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) return b.id;
    }
    return null;
  }
  // 快照里的按下集合（pointerId → 按钮 id 归并去重）里是否含某按钮
  function isPressed(s, id) {
    return !!(s && s.pressed && s.pressed.indexOf(id) >= 0);
  }

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

  // ---- 桌游纸卡按钮 ----
  // 芯片：实色硬投影（无模糊）+ 墨描边圆角面；按下时整体下沉 3px、投影间隙收成 1px，
  // 像按下一块积木。btn = { id, x, y, w, h, label, icon, iconOn, face, pressed }
  // face：'wood' 主操作（木色面 + 纸色字），'paper' 次操作（纸面 + 墨字）
  function drawChip(ctx, btn) {
    var press = btn.pressed ? 1 : 0;
    var y = btn.y + press * (CHIP_DROP - 1);
    var textColor = btn.face === 'wood' ? COL.text : COL.ink;

    // 硬投影：贴着原始位置，不随下沉移动（间隙收窄即"按下去"）
    roundRectPath(ctx, btn.x + 2, btn.y + CHIP_DROP, btn.w, btn.h, CHIP_R);
    ctx.fillStyle = UI_SHADOW;
    ctx.fill();

    roundRectPath(ctx, btn.x, y, btn.w, btn.h, CHIP_R);
    ctx.fillStyle = btn.face === 'wood' ? (press ? UI_WOOD_PRESS : UI_WOOD) : UI_PAPER;
    ctx.fill();
    ctx.lineWidth = CHIP_BORDER;
    ctx.strokeStyle = COL.ink;
    ctx.stroke();

    var cx = btn.x + btn.w / 2, cy = y + btn.h / 2;
    if (btn.icon === 'pause') drawPauseIcon(ctx, cx, cy, textColor);
    else if (btn.icon === 'sound') drawSoundIcon(ctx, cx, cy, btn.iconOn === false, textColor);
    if (btn.label) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      setFont(ctx, 'bold', 20);
      ctx.fillStyle = textColor;
      ctx.fillText(btn.label, cx, cy + 1);
    }
  }

  // 暂停图标：两根圆头竖条
  function drawPauseIcon(ctx, cx, cy, color) {
    ctx.fillStyle = color;
    roundRectPath(ctx, cx - 9, cy - 8, 6, 16, 3);
    ctx.fill();
    roundRectPath(ctx, cx + 3, cy - 8, 6, 16, 3);
    ctx.fill();
  }

  // 喇叭图标：纸卡线条风；muted 时画斜杠，否则两道弧
  function drawSoundIcon(ctx, cx, cy, muted, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(cx - 10, cy - 4);
    ctx.lineTo(cx - 4, cy - 4);
    ctx.lineTo(cx + 2, cy - 10);
    ctx.lineTo(cx + 2, cy + 10);
    ctx.lineTo(cx - 4, cy + 4);
    ctx.lineTo(cx - 10, cy + 4);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    if (muted) {
      ctx.beginPath();
      ctx.moveTo(cx + 6, cy - 6);
      ctx.lineTo(cx + 14, cy + 6);
      ctx.moveTo(cx + 14, cy - 6);
      ctx.lineTo(cx + 6, cy + 6);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(cx + 3, cy, 5.5, -0.9, 0.9);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx + 3, cy, 9.5, -0.8, 0.8);
      ctx.stroke();
    }
  }

  // 比赛阶段右上芯片组：暂停 + 静音（先于半屏油门消费点击，见 main.onPointerDown）
  function drawRaceChips(ctx, s) {
    drawChip(ctx, {
      id: 'pause', x: CHIP_PAUSE_X, y: CHIP_ROW_Y, w: CHIP_W, h: CHIP_H,
      icon: 'pause', face: 'paper', pressed: isPressed(s, 'pause')
    });
    registerUI('pause', CHIP_PAUSE_X, CHIP_ROW_Y, CHIP_W, CHIP_H);
    drawChip(ctx, {
      id: 'mute', x: CHIP_MUTE_X, y: CHIP_ROW_Y, w: CHIP_W, h: CHIP_H,
      icon: 'sound', iconOn: !s.muted, face: 'paper', pressed: isPressed(s, 'mute')
    });
    registerUI('mute', CHIP_MUTE_X, CHIP_ROW_Y, CHIP_W, CHIP_H);
  }

  // 暂停面板：压暗 + 纸卡 + 三枚芯片（继续 / 重开 / 回标题）
  function drawPausePanel(ctx, s) {
    ctx.fillStyle = 'rgba(27,23,20,.45)';
    ctx.fillRect(0, 0, W, H);

    var pw = 560, ph = 240;
    var px = (W - pw) / 2, py = (H - ph) / 2 - 20;
    roundRectPath(ctx, px + 4, py + 4, pw, ph, 16);
    ctx.fillStyle = UI_SHADOW;
    ctx.fill();
    roundRectPath(ctx, px, py, pw, ph, 16);
    ctx.fillStyle = UI_PAPER;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = COL.ink;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    setFont(ctx, 'bold', 34);
    ctx.fillStyle = COL.ink;
    ctx.fillText('暂停', W / 2, py + 62);

    var defs = [
      { id: 'resume', label: '继续', face: 'wood' },
      { id: 'restart', label: '重开', face: 'paper' },
      { id: 'back', label: '回标题', face: 'paper' }
    ];
    var bw = 150, gap = 20;
    var by = py + 122, bh = 48;
    var bx = px + (pw - (defs.length * bw + (defs.length - 1) * gap)) / 2;
    for (var i = 0; i < defs.length; i++) {
      drawChip(ctx, {
        id: defs[i].id, x: bx, y: by, w: bw, h: bh,
        label: defs[i].label, face: defs[i].face, pressed: isPressed(s, defs[i].id)
      });
      registerUI(defs[i].id, bx, by, bw, bh);
      bx += bw + gap;
    }

    setFont(ctx, 'normal', 12);
    ctx.fillStyle = 'rgba(43,35,32,.55)';
    ctx.fillText('P 继续 · R 重开 · Esc 回标题', W / 2, py + ph - 26);
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

    var px = 280, py = 140, pw = 720, ph = 470;
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

    // 分圈与按钮之间的细分隔线
    ctx.fillStyle = 'rgba(43,35,32,.12)';
    ctx.fillRect(px + 40, py + 380, pw - 80, 2);

    // 底部按钮：再来一局（主操作）/ 回标题；键盘 R / Esc 同义
    var defs = [
      { id: 'again', label: '再来一局', face: 'wood' },
      { id: 'back', label: '回标题', face: 'paper' }
    ];
    var bw = 190, gap = 24;
    var by = py + 394, bh = 48;
    var bx = px + (pw - (defs.length * bw + (defs.length - 1) * gap)) / 2;
    for (var b = 0; b < defs.length; b++) {
      drawChip(ctx, {
        id: defs[b].id, x: bx, y: by, w: bw, h: bh,
        label: defs[b].label, face: defs[b].face, pressed: isPressed(s, defs[b].id)
      });
      registerUI(defs[b].id, bx, by, bw, bh);
      bx += bw + gap;
    }

    setFont(ctx, 'normal', 12);
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(43,35,32,.55)';
    ctx.fillText('R 再来一局 · Esc 返回标题', W / 2, py + ph - 12);
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

  // HUD：两块玩家面板 + 中上计时；倒计时 / 暂停 / 结算按阶段附加；芯片组注册屏上按钮
  function drawHUD(ctx, s) {
    if (!ctx || !s) return;
    var phase = s.phase;
    if (phase !== 'countdown' && phase !== 'running' && phase !== 'paused' && phase !== 'finished') return;
    uiBeginFrame();
    var race = s.race || null;

    ctx.save();
    drawPlayerPanel(ctx, race, 0, false, s.best);
    drawPlayerPanel(ctx, race, 1, true, s.best);
    if (phase === 'paused') {
      drawPausePanel(ctx, s);
    } else {
      drawCenterHUD(ctx, race, phase);
      if (phase === 'countdown') {
        drawCountdown(ctx, s);
        ctx.save();
        setFont(ctx, 'normal', 14);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(233,220,196,.6)';
        ctx.fillText('按住左半屏 = P1 油门　按住右半屏 = P2 油门', W / 2, H - 36);
        ctx.restore();
      }
      if (phase === 'countdown' || phase === 'running') drawRaceChips(ctx, s);
    }
    if (phase === 'finished') drawResult(ctx, s);
    if (s.portrait) drawPortraitHint(ctx, s);
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

  // 竖屏提示：盖一层半透明遮罩提醒旋转设备；点按任意处可关掉继续竖屏玩（本会话内不再弹）
  // 注册成全屏按钮：命中优先级最高（最后注册），竖屏下的第一要点掉遮罩，之后才能点到芯片
  function drawPortraitHint(ctx, s) {
    if (s && s.portraitHint === false) return;
    ctx.save();
    ctx.fillStyle = 'rgba(27,23,20,.55)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    setFont(ctx, 'bold', 26);
    ctx.fillStyle = 'rgba(233,220,196,.95)';
    ctx.fillText('建议横屏游玩', W / 2, H / 2 - 26);
    setFont(ctx, 'normal', 16);
    ctx.fillStyle = 'rgba(233,220,196,.75)';
    ctx.fillText('旋转设备后继续', W / 2, H / 2 + 12);
    ctx.fillText('点按任意处继续（竖屏也能玩）', W / 2, H / 2 + 40);
    ctx.restore();
    registerUI('portraitDismiss', 0, 0, W, H);
  }

  // 键帽：圆角小块 + 墨描边（桌游棋子感）；返回宽度
  function drawKeycap(ctx, cx, cy, label, fs) {
    var w = textWidth(ctx, label, fs) + 14;
    var h = fs + 10;
    roundRectPath(ctx, cx - w / 2, cy - h / 2, w, h, 5);
    ctx.fillStyle = 'rgba(233,220,196,.92)';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(43,35,32,.8)';
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    setFont(ctx, 'bold', fs);
    ctx.fillStyle = COL.ink;
    ctx.fillText(label, cx, cy + 0.5);
    return w;
  }

  // 键帽行：parts = {k:'键'} 键帽 / {t:'文字'} 素文本 / {g:像素} 加大间距；整行按 cx 居中
  function drawKeyRow(ctx, cx, y, parts, fs) {
    var GAP = 8;
    var widths = [];
    var total = 0;
    var i, w;
    for (i = 0; i < parts.length; i++) {
      var pt = parts[i];
      if (pt.g) { w = pt.g; }
      else if (pt.k) { w = textWidth(ctx, pt.k, fs) + 14; }
      else { w = textWidth(ctx, pt.t, fs); }
      widths.push(w);
      total += w + (i < parts.length - 1 ? GAP : 0);
    }
    var x = cx - total / 2;
    for (i = 0; i < parts.length; i++) {
      var p2 = parts[i];
      if (p2.g) { x += widths[i] + GAP; continue; }
      if (p2.k) {
        drawKeycap(ctx, x + widths[i] / 2, y, p2.k, fs);
      } else {
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        setFont(ctx, 'normal', fs);
        ctx.fillStyle = 'rgba(233,220,196,.72)';
        ctx.fillText(p2.t, x, y + 0.5);
      }
      x += widths[i] + GAP;
    }
  }

  // 赛道预览：毯红底小卡 + 缩放路基带 + 起点双白线（对照 2D 场景的赛道画法）
  function drawTrackPreview(ctx, x, y, w, h, track) {
    roundRectPath(ctx, x + 3, y + 3, w, h, 14);
    ctx.fillStyle = 'rgba(43,35,32,.25)';
    ctx.fill();
    roundRectPath(ctx, x, y, w, h, 14);
    ctx.fillStyle = '#7A3E3A';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = COL.ink;
    ctx.stroke();

    var pts = track && track.points;
    if (!pts || pts.length < 2) return;

    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < pts.length; i++) {
      var q = pts[i];
      if (q.x < minX) minX = q.x;
      if (q.x > maxX) maxX = q.x;
      if (q.y < minY) minY = q.y;
      if (q.y > maxY) maxY = q.y;
    }
    var PAD = 26;
    var sx = (w - PAD * 2) / Math.max(1, maxX - minX);
    var sy = (h - PAD * 2) / Math.max(1, maxY - minY);
    var sc = Math.min(sx, sy);
    var ox = x + w / 2 - (minX + maxX) / 2 * sc;
    var oy = y + h / 2 - (minY + maxY) / 2 * sc;

    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(sc, sc);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = COL.ink;
    ctx.lineWidth = 84 + 6;          // 外描边（路基 84 + 描边 6，同 scene.js）
    ctx.stroke();
    ctx.strokeStyle = '#3A3F47';
    ctx.lineWidth = 84;
    ctx.stroke();
    ctx.restore();

    // 起点双白线（起跑线样式）
    var st = track.startLine;
    if (st) {
      ctx.save();
      ctx.translate(st.x * sc + ox, st.y * sc + oy);
      ctx.rotate(st.angle || 0);
      ctx.fillStyle = '#FFFFFF';
      var half = 84 * sc / 2;
      ctx.fillRect(-2.5, -half - 2.5, 5, 8);
      ctx.fillRect(-2.5, half - 5.5, 5, 8);
      ctx.restore();
    }
  }

  // 统计小卡：标签 + 数值（纸卡上的凹槽面）
  function drawStatCard(ctx, x, y, w, h, label, value) {
    roundRectPath(ctx, x, y, w, h, 10);
    ctx.fillStyle = 'rgba(43,35,32,.07)';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(43,35,32,.55)';
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    setFont(ctx, 'normal', 11);
    ctx.fillStyle = 'rgba(43,35,32,.6)';
    ctx.fillText(label, x + w / 2, y + 17);
    setFont(ctx, 'bold', 19);
    ctx.fillStyle = COL.ink;
    ctx.fillText(value, x + w / 2, y + 42);
  }

  // 标题界面（桌游纸卡）：
  //   左列赛道预览 + 右列选择器/统计，主操作「开始比赛」为第一层级，
  //   键位提示压成卡下方的键帽行（调研：主操作突出、预览是选图核心、次级信息靠边）
  function drawTitle(ctx, s) {
    if (!ctx || !s) return;
    var t = Number(s.time) || 0;
    titleArrowHits.left = null;
    titleArrowHits.right = null;
    titleRowHit = null;
    uiBeginFrame();

    ctx.save();
    ctx.fillStyle = DIM_TITLE;
    ctx.fillRect(0, 0, W, H);

    // 纸卡 900×470 居中
    var cardX = 190, cardY = 125, cardW = 900, cardH = 470;
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

    // 标题锁定（视觉锚点）
    setFont(ctx, 'bold', 76);
    ctx.fillStyle = COL.ink;
    ctx.fillText('轨道赛车', W / 2, 206);
    setFont(ctx, 'normal', 15);
    ctx.fillStyle = 'rgba(43,35,32,.7)';
    ctx.fillText('《双人成行》阁楼小游戏 · 程序化复刻', W / 2, 254);

    // 左列：赛道预览（选择赛道的核心信息）
    drawTrackPreview(ctx, 250, 288, 330, 196, s.track);

    // 右列：选择器 ◀ 名称 ▶（方向键 / A·D / 点击切换，localStorage 记忆）
    var trackCount = Number(s.trackCount) || 0;
    var colCx = 815;
    if (trackCount > 1) {
      var name = String(s.trackName || '');
      var arrowFs = 30, nameFs = 26, gap = 26;
      setFont(ctx, 'bold', nameFs);
      var nameW = textWidth(ctx, name, nameFs);
      var arrowLW = textWidth(ctx, '◀', arrowFs);
      var arrowRW = textWidth(ctx, '▶', arrowFs);
      var totalW = arrowLW + gap + nameW + gap + arrowRW;
      var startX = colCx - totalW / 2;
      var leftCx = startX + arrowLW / 2;
      var nameCx = startX + arrowLW + gap + nameW / 2;
      var rightCx = startX + arrowLW + gap + nameW + gap + arrowRW / 2;
      var baseY = 330;
      ctx.fillStyle = COL.ink;
      setFont(ctx, 'bold', arrowFs);
      ctx.fillText('◀', leftCx, baseY);
      setFont(ctx, 'bold', nameFs);
      ctx.fillText(name, nameCx, baseY);
      setFont(ctx, 'bold', arrowFs);
      ctx.fillText('▶', rightCx, baseY);
      setArrowHit('left', leftCx, baseY);
      setArrowHit('right', rightCx, baseY);
      // 整行命中：限制在选择器附近（左侧是预览卡，不参与切赛道）
      titleRowHit = {
        baseY: baseY,
        nameCx: nameCx,
        minX: leftCx - 64,
        maxX: rightCx + 64,
        trackCount: trackCount
      };
      setFont(ctx, 'normal', 14);
      ctx.fillStyle = 'rgba(43,35,32,.65)';
      ctx.fillText(s.trackDesc || '', colCx, 372);
    }

    // 统计小卡：总长 / 弯道 / 存档最佳圈
    var track = s.track || null;
    var bestTxt = (s.best !== null && s.best !== undefined && isFinite(Number(s.best)))
      ? fmtLap(Number(s.best) / 1000) : '—';
    drawStatCard(ctx, 620, 400, 118, 64, '总长 px', track ? String(Math.round(track.totalLength)) : '—');
    drawStatCard(ctx, 756, 400, 118, 64, '弯道', track && track.corners ? String(track.corners.length) : '—');
    drawStatCard(ctx, 892, 400, 118, 64, '存档最佳圈', bestTxt);

    // 主操作：开始比赛（第一层级，Enter / 点按任意处同义）
    drawChip(ctx, {
      id: 'start', x: W / 2 - 140, y: 508, w: 280, h: 56,
      label: '开始比赛', face: 'wood', pressed: isPressed(s, 'start')
    });
    registerUI('start', W / 2 - 140, 508, 280, 56);
    setFont(ctx, 'normal', 12);
    ctx.fillStyle = 'rgba(43,35,32,.55)';
    ctx.fillText('按 Enter 或点按画面任意处同样开始', W / 2, 584);

    // 右上角静音芯片（M 键同义；命中先于「点按任意处开始」，见 main.onPointerDown）
    drawChip(ctx, {
      id: 'mute', x: W - 24 - CHIP_W, y: 20, w: CHIP_W, h: CHIP_H,
      icon: 'sound', iconOn: !s.muted, face: 'paper', pressed: isPressed(s, 'mute')
    });
    registerUI('mute', W - 24 - CHIP_W, 20, CHIP_W, CHIP_H);

    // 卡下方键帽行（次级信息）
    drawKeyRow(ctx, W / 2, 624, [
      { t: 'P1 ' }, { k: 'W' }, { t: ' 或 ' }, { k: '空格' }, { g: 16 },
      { t: 'P2 ' }, { k: '↑' }, { t: ' 或 ' }, { k: 'Enter' }, { g: 16 },
      { t: '手机：按住左右半屏加速' }
    ], 13);
    drawKeyRow(ctx, W / 2, 656, [
      { k: '←' }, { k: '→' }, { t: ' 或 A/D 切赛道' }, { g: 16 },
      { k: 'P' }, { t: '暂停' }, { g: 10 }, { k: 'M' }, { t: '静音' }, { g: 10 }, { k: 'R' }, { t: '重开' }
    ], 13);

    if (s.portrait) drawPortraitHint(ctx, s);
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
      // 车辆坐标是赛道坐标（原点在赛道中心），画布是 0..W / 0..H；
      // 与底图的赛道层一样要平移到画布中心，否则整局都落在左上角外
      ctx.save();
      ctx.translate(ORIGIN_X, ORIGIN_Y);
      for (var i = 0; i < race.entries.length; i++) {
        drawCarImpl(ctx, track, race.entries[i], time, i);
      }
      ctx.restore();
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
    hitTestUI: hitTestUI,
    emit: emit,
    updateParticles: updateParticles,
    width: W,
    height: H
  };
});
