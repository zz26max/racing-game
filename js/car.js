/* 槽车物理：沿槽自动行驶，玩家只控制油门，弯道超速会甩出（UMD：浏览器挂 window.RaceCar，Node 走 module.exports） */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    var util = null, track = null;
    try { util = require('./util.js'); } catch (e) { util = null; }
    try { track = require('./track.js'); } catch (e) { track = null; }
    module.exports = factory(util, track);
  } else {
    root.RaceCar = factory(root.RaceUtil, root.RaceTrack);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (util, track) {
  'use strict';
  // track 为可选注入：本模块只通过 update 的参数接收赛道，不在此强依赖

  // 速度上限（px/s）
  var MAX_SPEED = 400;
  // 横向抓地上限：超过即打滑
  var GRIP = 950;
  // 甩出触发阈值（px）
  var DERAIL_OFFSET = 10;
  // 脱轨总时长（秒）= 飞出 FLIGHT_TIME（上限护栏）+ 停留 REST_TIME + 归位 RETURN_TIME
  var FLIGHT_TIME = 2.2;
  var REST_TIME = 0.35;
  var RETURN_TIME = 0.4;
  var DERAIL_TIME = FLIGHT_TIME + REST_TIME + RETURN_TIME;
  // fly 段实际生效的护栏：复位总时长保守收在 2.5s 内（race.test.js 第 2 条的窗口为 3.0s），
  // 留 1 帧余量后取 2.5 - REST_TIME - RETURN_TIME - 1/120 ≈ 1.74s
  var FLY_GUARD = Math.min(FLIGHT_TIME, 1.70);
  // 飞出阶段重力加速度（px/s²）与空气阻尼（1/s，纵向/横向同值）
  var GRAVITY = 1400;
  var AIR_DRAG = 0.10;
  // 落地后地面摩擦减速度（px/s²）：纵向（滑行）与横向（侧滑）
  var GROUND_LONG_DECEL = 300;
  var GROUND_LAT_DECEL = 520;
  // 落地反弹系数与收起弹跳的竖直速度阈值（px/s）
  var RESTITUTION = 0.35;
  var GROUND_VUP_MIN = 80;
  // 地面滑行低于此速度即判定停稳（px/s）
  var STOP_SPEED = 25;
  // 自旋 / 翻滚角速度的阻尼（1/s）
  var SPIN_DAMP = 0.4;
  // 翻滚阻尼：2.0 使 ~12 rad/s 的初始角速度只积出约 6 rad（≈1 圈），0.35 时约 6 圈
  var PITCH_DAMP = 2.0;
  var GROUND_PITCH_DAMP = 3.5;
  // 归位阶段抬升幅度（px）
  var RETURN_HEIGHT = 18;
  // 油门加速度与阻力
  var ACCEL = 620;
  var BRAKE = 240;
  // 油门踏板行程：上升 3.34/s（≈0.3s 踩满），回落 8.33/s（≈0.12s 松空）
  var THROTTLE_RISE = 3.34;
  var THROTTLE_FALL = 8.33;
  // 救车：打滑且已松油（目标油门 < 0.05）时的减速度与侧滑速度衰减
  var SAVE_THROTTLE_MAX = 0.05;
  var SAVE_BRAKE = 480;
  // 坡度加速度系数：accel += -SLOPE_ACCEL * slopeAt(s)（上坡减速、下坡加速）
  var SLOPE_ACCEL = 600;
  // 复位速度
  var RESPAWN_SPEED = 120;
  // 归位完成时的闪烁时长（秒）
  var RESPAWN_BLINK = 0.18;

  // 可插拔的外部飞行计算器（如 CANNON 刚体）：null 时走内置抛体。
  // 约定：begin(car, trackObj) 启动刚体；step(car, dt) 推进一帧，停稳时把 car.worldActive 置 false。
  var flightHooks = null;

  function setFlightHooks(h) { flightHooks = h || null; }
  function getFlightHooks() { return flightHooks; }

  function clamp(v, a, b) {
    if (util && typeof util.clamp === 'function') return util.clamp(v, a, b);
    if (v < a) return a;
    if (v > b) return b;
    return v;
  }

  // 轨道切线角（与飞行朝向同一约定）：atan2(-ty, tx)
  var TAU = Math.PI * 2;
  function tangentPoint(trackObj, s) {
    if (!trackObj || typeof trackObj.sampleAt !== 'function') return { tx: 1, ty: 0 };
    var p = trackObj.sampleAt(s);
    if (!p || !isFinite(p.tx) || !isFinite(p.ty)) return { tx: 1, ty: 0 };
    return p;
  }
  function tangentHeading(trackObj, s) {
    var p = tangentPoint(trackObj, s);
    return Math.atan2(-p.ty, p.tx);
  }
  // 角度归一到 (-π, π]
  function wrapAngle(a) {
    if (!isFinite(a)) return 0;
    a = a % TAU;
    if (a > Math.PI) a -= TAU;
    if (a <= -Math.PI) a += TAU;
    return a;
  }
  // smoothstep：x 夹到 [0,1] 后的 3x²-2x³
  function smooth01(x) {
    var t = clamp(Number(x) || 0, 0, 1);
    return t * t * (3 - 2 * t);
  }

  // 槽位是否落在桥面正下方的相机死角：固定高机位下，桥下赛道被桥面/护栏完全遮挡。
  // 判定只依赖几何——槽位在贴地段、且与桥面中心线（sCenter ± halfLength）水平距离
  // 小于 桥面半宽+车半宽余量，即认为在桥面正下方。
  function slotUnderDeck(trackObj, s) {
    if (!trackObj || !trackObj.bridge ||
        typeof trackObj.elevationAt !== 'function' ||
        typeof trackObj.sampleAt !== 'function' ||
        typeof trackObj.pointAt !== 'function') return false;
    if (Number(trackObj.elevationAt(s)) > 1) return false;   // 自己在桥上/坡上，不会被桥面挡住
    var p = trackObj.pointAt(s, 0);
    var b = trackObj.bridge;
    var half = Number(b.halfLength) || 70;
    var reach = (Number(trackObj.width) || 84) / 2 + 14;
    var reachSq = reach * reach;
    var sc = Number(b.sCenter) || 0;
    for (var d = -half; d <= half; d += 10) {
      var q = trackObj.sampleAt(sc + d);
      if (!q) continue;
      var dx = p.x - q.x, dz = p.y - q.y;
      if (dx * dx + dz * dz < reachSq) return true;
    }
    return false;
  }
  // 角度沿最短弧向目标靠拢 ratio ∈ [0,1]
  function lerpAngle(from, to, ratio) {
    return from + wrapAngle(to - from) * clamp(ratio, 0, 1);
  }

  // ---- 四元数工具（THREE 不可用，自行实现；约定同 three / cannon：x,y,z,w）----
  function quatNormalize(q) {
    if (!q) return { x: 0, y: 0, z: 0, w: 1 };
    var n = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
    if (!(n > 1e-9)) return { x: 0, y: 0, z: 0, w: 1 };
    return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n };
  }
  // 正立 + 车头朝 yaw（绕 Y 轴旋转）：车顶朝 +Y，无俯仰/翻滚
  function uprightQuat(yaw) {
    var h = yaw * 0.5;
    return { x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) };
  }
  // 复制四元数；非法值返回 null
  function copyQuat(q) {
    if (!q || !isFinite(q.x) || !isFinite(q.y) || !isFinite(q.z) || !isFinite(q.w)) return null;
    return { x: q.x, y: q.y, z: q.z, w: q.w };
  }
  // 四元数模长平方；缺失/非有限返回 -1（必然小于任何合法阈值）
  function quatLenSq(q) {
    if (!q) return -1;
    var l = q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w;
    return isFinite(l) ? l : -1;
  }
  // 球面插值（最短弧）：t ∈ [0,1]
  function quatSlerp(a, b, t) {
    // 保护：任一端为 null/undefined 或退化（零四元数、非有限）时，
    // 直接返回目标端的归一化副本（b 也无效则返回单位四元数），
    // 避免归位过程中算出 NaN 影响朝向而使车“消失”。
    if (quatLenSq(a) < 1e-6 || quatLenSq(b) < 1e-6) return quatNormalize(b);
    var qa = quatNormalize(a);
    var qb = quatNormalize(b);
    var dot = qa.x * qb.x + qa.y * qb.y + qa.z * qb.z + qa.w * qb.w;
    // 反向时取同一半球，保证走最短弧
    if (dot < 0) { qb = { x: -qb.x, y: -qb.y, z: -qb.z, w: -qb.w }; dot = -dot; }
    var k0, k1, ratio = clamp(t, 0, 1);
    if (dot > 0.9995) {
      // 夹角极小时退化为线性插值，避免 sin 除零
      k0 = 1 - ratio; k1 = ratio;
    } else {
      var theta = Math.acos(dot > 1 ? 1 : dot);
      var sinTheta = Math.sin(theta);
      k0 = Math.sin((1 - ratio) * theta) / sinTheta;
      k1 = Math.sin(ratio * theta) / sinTheta;
    }
    return quatNormalize({
      x: qa.x * k0 + qb.x * k1,
      y: qa.y * k0 + qb.y * k1,
      z: qa.z * k0 + qb.z * k1,
      w: qa.w * k0 + qb.w * k1
    });
  }

  // 创建一辆槽车：lane 决定所在槽（±1），name 用于展示
  function createCar(opts) {
    var o = opts || {};
    var lane = Number(o.lane);
    if (!isFinite(lane)) lane = 1;
    return {
      lane: lane,
      name: o.name === undefined ? '' : String(o.name),
      s: 0,
      speed: 0,
      throttle: 0,
      throttleTarget: 0,
      offset: 0,
      offsetVel: 0,
      slideSide: 1,
      // 外部刚体飞行状态（flightHooks 非空且已启动时有效）：世界坐标与朝向四元数
      worldActive: false,
      worldX: 0,
      worldY: 0,
      worldZ: 0,
      quat: null,
      // 世界坐标归位起点（刚体停稳瞬间的位姿）：rest → return 全程按世界坐标插值
      restPose: null,
      derailed: false,
      derailT: 0,
      // 脱轨分段：null 正常 / 'fly' 飞出 / 'rest' 落地停留 / 'return' 归位；供渲染层做连续动画
      derailPhase: null,
      flyHeight: 0,
      flightProgress: 0,
      // 抛体飞行状态：纵向/横向/竖直速度（px/s）、离地高度（px）、朝向（rad）、自旋角速度（rad/s）
      flyVLong: 0,
      flyVLat: 0,
      // 脱轨期间的“视觉前冲”位移（px）：只用于渲染，不推进赛道进度 s
      flyForward: 0,
      flyVUp: 0,
      flyY: 0,
      flyHeading: 0,
      flySpin: 0,
      // 绕横轴的端翻角与角速度（rad, rad/s）、是否已落地停稳、落地弹跳次数
      flyPitch: 0,
      flyPitchVel: 0,
      flyGrounded: false,
      flyBounces: 0,
      returnOffset: 0,
      blinkT: 0,
      slip: 0,
      justDerailed: false,
      totalDerails: 0,
      // HUD / 音效用：是否在打滑、抓地占用率（0..2，1 为刚好吃满抓地）、是否处于救车窗口
      sliding: false,
      gripUse: 0,
      saveWindow: false
    };
  }

  // 单帧推进：input = { throttle: 0..1 }
  function update(car, dt, input, trackObj) {
    if (!car || !(dt > 0) || !trackObj) return car;
    var inp = input || {};
    // 目标油门与踏板行程：throttle 向 throttleTarget 靠拢，加速度用行程值 throttle
    var target = clamp(Number(inp.throttle) || 0, 0, 1);
    car.throttleTarget = target;
    var thr = Number(car.throttle) || 0;
    if (target > thr) thr = Math.min(target, thr + THROTTLE_RISE * dt);
    else if (target < thr) thr = Math.max(target, thr - THROTTLE_FALL * dt);
    car.throttle = clamp(thr, 0, 1);

    if (car.derailed) {
      // 脱轨三段式：fly（抛体飞出）→ rest（落地停留）→ return（归位，回到槽心）
      // 脱轨期间没有抓地可言，HUD 中间量清零，避免残留上一帧的读数
      car.sliding = false;
      car.gripUse = 0;
      car.saveWindow = false;

      if (car.derailPhase === 'return') {
        // 归位：s 不变，offset 按 smoothstep 收回，抬升走 18px 小拱，朝向/翻滚插值回切线角与 0
        car.derailT -= dt;
        var k = 1 - Math.max(car.derailT, 0) / RETURN_TIME;
        k = clamp(k, 0, 1);
        var smooth = k * k * (3 - 2 * k);

        // 外部刚体路径（有 flightHooks）：全程在世界坐标里插值。
        // 起点是停稳时的世界位姿，终点是槽心 + 路面高度；不再经过赛道系 offset/flyForward，
        // 因此坡道附近不会因为“赛道系 ↔ 世界系”换算而突然跳上桥面。
        if (car.worldActive) {
          var rp = car.restPose;
          if (!rp) rp = { x: car.worldX, y: car.worldY, z: car.worldZ, q: copyQuat(car.quat) };
          var wp = trackObj.pointAt(car.s, car.lane);
          var welev = (typeof trackObj.elevationAt === 'function') ? Number(trackObj.elevationAt(car.s)) : 0;
          if (!isFinite(welev)) welev = 0;
          var targetY = 1 + welev + 7;
          var fromX = Number(rp.x), fromZ = Number(rp.z), fromY = Number(rp.y);
          if (!isFinite(fromX)) fromX = wp.x;
          if (!isFinite(fromZ)) fromZ = wp.y;
          if (!isFinite(fromY)) fromY = targetY;
          // 位置插值：常规落差直接水平+竖直插值（18px 正弦小拱，k=0/1 时均为 0，端点无突跳）；
          // 需要大幅爬升（如从桥下地板回到桥面）时改为三段——升到槽上方安全高度 → 平移 → 落下，
          // 避免直线插值斜穿桥面/护栏
          if (targetY - fromY > 20) {
            var riseY = targetY + 16;
            if (k < 0.32) {
              var kA = smooth01(k / 0.32);
              car.worldX = fromX;
              car.worldZ = fromZ;
              car.worldY = fromY + (riseY - fromY) * kA;
            } else if (k < 0.72) {
              var kB = smooth01((k - 0.32) / 0.40);
              car.worldX = fromX + (wp.x - fromX) * kB;
              car.worldZ = fromZ + (wp.y - fromZ) * kB;
              car.worldY = riseY;
            } else {
              var kC = smooth01((k - 0.72) / 0.28);
              car.worldX = wp.x;
              car.worldZ = wp.y;
              car.worldY = riseY + (targetY - riseY) * kC + Math.sin(Math.PI * kC) * 6;
            }
          } else {
            car.worldX = fromX + (wp.x - fromX) * smooth;
            car.worldZ = fromZ + (wp.y - fromZ) * smooth;
            car.worldY = fromY + (targetY - fromY) * smooth + Math.sin(Math.PI * k) * RETURN_HEIGHT;
          }
          // 姿态：从停稳四元数球面插值到“正立 + 朝向切线”
          var tq = uprightQuat(tangentHeading(trackObj, car.s));
          car.quat = quatSlerp(rp.q || tq, tq, smooth);
          // 赛道系中间量在归位期间保持清零，避免渲染层残留
          car.flyHeight = 0;
          car.flyY = 0;
          if (car.derailT <= 0) {
            // 归位结束：交回赛道坐标，位置已精确落在槽心（误差来自浮点求和）
            car.worldActive = false;
            car.worldX = wp.x;
            car.worldY = targetY;
            car.worldZ = wp.y;
            car.quat = quatNormalize(tq);
            car.restPose = null;
            car.derailed = false;
            car.derailPhase = null;
            car.derailT = 0;
            car.offset = 0;
            car.offsetVel = 0;
            car.speed = RESPAWN_SPEED;
            car.flyForward = 0;
            car.flyPitch = 0;
            car.flyPitchVel = 0;
            car.flySpin = 0;
            car.flyVLong = 0;
            car.flyVLat = 0;
            car.flyVUp = 0;
            car.flyHeight = 0;
            car.flyY = 0;
            car.flyHeading = tangentHeading(trackObj, car.s);
            car.blinkT = RESPAWN_BLINK;
            car.returnOffset = 0;
            car.justDerailed = false;
          }
          return car;
        }

        car.offset = car.returnOffset * (1 - smooth);
        // 视觉前冲随 smoothstep 同步收回；复位时再硬置 0，保证归位后为 0
        car.flyForward *= (1 - smooth);
        car.flyHeight = Math.sin(Math.PI * k) * RETURN_HEIGHT;
        car.flyY = 0;
        car.flyHeading = lerpAngle(car.flyHeading, tangentHeading(trackObj, car.s), Math.min(1, 6 * dt));
        car.flyPitch = lerpAngle(car.flyPitch, 0, Math.min(1, 6 * dt));
        car.flySpin *= Math.exp(-8 * dt);
        car.flyPitchVel *= Math.exp(-8 * dt);
        if (car.derailT <= 0) {
          car.derailed = false;
          car.derailPhase = null;
          car.derailT = 0;
          car.offset = 0;
          car.offsetVel = 0;
          car.speed = RESPAWN_SPEED;
          car.flyHeight = 0;
          car.flyY = 0;
          car.flyForward = 0;
          car.flyVLong = 0;
          car.flyVLat = 0;
          car.flyVUp = 0;
          car.flySpin = 0;
          car.flyPitch = 0;
          car.flyPitchVel = 0;
          car.flyHeading = tangentHeading(trackObj, car.s);
          car.blinkT = RESPAWN_BLINK;
          car.returnOffset = 0;
          // justDerailed 在复位时视为已消费；slip / slideSide 不在复位清单内，保留由后续帧回落
          car.justDerailed = false;
        }
        return car;
      }

      // rest：停稳后的短暂停顿，s / offset / 位置全部保持，自旋与翻滚角速度快速衰减
      if (car.derailPhase === 'rest') {
        car.derailT -= dt;
        car.flyHeight = 0;
        car.flyY = 0;
        car.flightProgress = 1;
        car.flySpin *= Math.exp(-8 * dt);
        car.flyPitch *= Math.exp(-8 * dt);
        car.flyPitchVel *= Math.exp(-8 * dt);
        if (Math.abs(car.flySpin) < 0.001) car.flySpin = 0;
        if (car.derailT <= 0) {
          // 停顿结束切入归位段：世界坐标起点已由停稳时记录到 restPose。
          // 归位目标不得落在桥面正下方的相机死角：沿赛道向后退出该区，车随后正常从桥下驶过
          var totalLen = Number(trackObj.totalLength) || 0;
          if (totalLen > 0) {
            // 双向扫描走廊出口，取更近的一侧退出（桥下走廊内含弯道时，
            // 固定向后退出会把车送回弯道入口，重新加速再次脱轨形成死循环）
            var backSteps = 81, fwdSteps = 81;
            for (var k = 1; k <= 80; k++) {
              if (backSteps === 81 && !slotUnderDeck(trackObj, car.s - 12 * k)) backSteps = k;
              if (fwdSteps === 81 && !slotUnderDeck(trackObj, car.s + 12 * k)) fwdSteps = k;
              if (backSteps !== 81 && fwdSteps !== 81) break;
            }
            if (fwdSteps < backSteps) {
              car.s = (car.s + 12 * fwdSteps) % totalLen;   // 前向退出走廊（跳过桥下段）
            } else if (backSteps <= 80) {
              car.s -= 12 * backSteps;
              if (car.s < 0) car.s += totalLen;
            }
          }
          car.derailPhase = 'return';
          car.derailT = RETURN_TIME;
        }
        return car;
      }

      // fly：起跳→抛物线飞远→落地弹跳→带摩擦滑行到停；derailT 作为总时长护栏
      // 外部刚体接管：每帧交给 flightHooks.step；停稳后记录世界位姿作为归位起点（rest → return 仍走世界坐标）
      if (car.worldActive && flightHooks) {
        flightHooks.step(car, dt);
        car.derailT -= dt;
        if (!car.worldActive) {
          // 刚体已停稳：记录当前世界位姿作为归位起点，并继续保持世界坐标渲染。
          // 不再把世界坐标回算成赛道系 offset / flyForward（坡道附近换算会“跳上桥面”）。
          car.restPose = {
            x: car.worldX,
            y: car.worldY,
            z: car.worldZ,
            q: copyQuat(car.quat)
          };
          car.worldActive = true;
          car.flyY = 0;
          car.flyHeight = 0;
          car.flyVUp = 0;
          car.derailPhase = 'rest';
          car.derailT = REST_TIME;
        }
        return car;
      }

      car.derailT -= dt;
      if (!car.flyGrounded) {
        car.flyVUp -= GRAVITY * dt;
        car.flyY += car.flyVUp * dt;
        car.flyVLong *= Math.exp(-AIR_DRAG * dt);
        car.flyVLat *= Math.exp(-AIR_DRAG * dt);
        if (car.flyY <= 0) {
          // 触地：竖直速度按恢复系数反弹，太弱则收弹并转入地面滑行
          car.flyY = 0;
          car.flyBounces += 1;
          car.flyVUp = -car.flyVUp * RESTITUTION;
          if (Math.abs(car.flyVUp) < GROUND_VUP_MIN) {
            car.flyVUp = 0;
            car.flyGrounded = true;
          }
        }
      } else {
        // 地面滑行：纵向/横向各自按摩擦减速，翻滚角速度额外收敛
        car.flyVLong = Math.max(0, car.flyVLong - GROUND_LONG_DECEL * dt);
        car.flyVLat = Math.max(0, car.flyVLat - GROUND_LAT_DECEL * dt);
        car.flyPitchVel *= Math.exp(-GROUND_PITCH_DAMP * dt);
      }

      // 位置推进与姿态：脱轨期间赛道进度 s 完全不变（不会“飞得比开得快”），
      // 纵向动量只累积到视觉前冲 flyForward，offset 走横向动量，朝向平旋、翻滚绕横轴
      car.flyForward += car.flyVLong * dt;
      car.offset += car.flyVLat * dt;
      car.flyHeading += car.flySpin * dt;
      car.flySpin *= Math.exp(-SPIN_DAMP * dt);
      car.flyPitch += car.flyPitchVel * dt;
      car.flyPitchVel *= Math.exp(-PITCH_DAMP * dt);
      car.flyHeight = Math.max(0, car.flyY);
      car.flightProgress = clamp(1 - car.derailT / FLY_GUARD, 0, 1);

      // 停稳（地面速度双双低于阈值）或护栏超时：清空动量，切入停留段
      var stopped = car.flyGrounded && car.flyVLong < STOP_SPEED && car.flyVLat < STOP_SPEED;
      if (stopped) {
        car.flyVLong = 0;
        car.flyVLat = 0;
      }
      if (stopped || car.derailT <= 0) {
        car.flyY = 0;
        car.flyHeight = 0;
        car.flyVLong = 0;
        car.flyVLat = 0;
        car.flyVUp = 0;
        car.flyPitchVel = 0;
        car.flyGrounded = true;
        car.derailPhase = 'rest';
        car.derailT = REST_TIME;
        car.returnOffset = car.offset;
        car.flightProgress = 1;
      }
      return car;
    }

    // 横向：向心需求 = v² × |曲率|（先用本帧初速判断是否在救车窗口，再推进速度）
    var curv = trackObj.curvatureAt(car.s);
    var absCurv = Math.abs(curv);
    var demandPre = car.speed * car.speed * absCurv;
    var saveWindow = demandPre > GRIP && target < SAVE_THROTTLE_MAX;

    // 纵向：油门加速随速度递减；松油门按固定阻力减速，救车窗口内用更大减速度
    var accel;
    if (car.throttle > 0.02) {
      accel = ACCEL * car.throttle * (1 - car.speed / MAX_SPEED);
    } else {
      accel = saveWindow ? -SAVE_BRAKE : -BRAKE;
    }
    // 坡度：上坡（slopeAt > 0）减速、下坡（slopeAt < 0）加速
    if (typeof trackObj.slopeAt === 'function') {
      var slope = Number(trackObj.slopeAt(car.s));
      if (isFinite(slope)) accel -= SLOPE_ACCEL * slope;
    }
    car.speed = clamp(car.speed + accel * dt, 0, MAX_SPEED);

    // 横向：本帧的实际抓地占用（HUD / 音效读取）
    var demand = car.speed * car.speed * Math.abs(curv);
    car.gripUse = Math.min(2, demand / GRIP);
    car.sliding = demand > GRIP;
    car.saveWindow = demand > GRIP && target < SAVE_THROTTLE_MAX;

    // 横向：抓得住则 offset 与侧滑速度一起回落；打滑则按超出抓地的横向加速度累积侧滑
    if (demand <= GRIP) {
      car.offsetVel *= Math.exp(-8 * dt);
      car.offset *= Math.exp(-6 * dt);
      if (car.offset < 0.01) { car.offset = 0; car.offsetVel = 0; }
    } else {
      var excess = demand - GRIP;              // 超出抓地的横向加速度
      car.offsetVel += excess * dt;            // 侧滑速度累积
      if (car.saveWindow) car.offsetVel *= (1 - 3 * dt);
      car.offset += car.offsetVel * dt;
      car.speed = Math.max(0, car.speed - 0.25 * excess * dt);  // 轮胎摩擦损耗
    }
    car.slideSide = curv === 0 ? (car.slideSide || 1) : (curv > 0 ? 1 : -1);
    car.slip = Math.min(1, car.offsetVel / Math.max(car.speed, 1));

    // 超出槽宽容许范围：甩出赛道（侧滑速度相对车速过大同样判甩出）
    if (car.offset > DERAIL_OFFSET ||
        (car.offsetVel / Math.max(car.speed, 1)) > 0.35) {
      // 触发瞬间按当前速度分配三轴动量：纵向等于车速、横向取侧滑速度（不足则 0.35 倍车速）、竖直起跳
      var p = tangentPoint(trackObj, car.s);
      car.derailed = true;
      car.justDerailed = true;
      car.derailPhase = 'fly';
      car.derailT = FLY_GUARD;
      // 外部刚体飞行：交给 flightHooks.begin 接手，内置抛体动量不再赋值
      if (flightHooks) {
        car.worldActive = true;
        car.restPose = null;
        if (typeof flightHooks.begin === 'function') flightHooks.begin(car, trackObj);
      } else {
        car.flyVLong = car.speed * 1.0;
        car.flyVLat = Math.max(car.offsetVel, car.speed * 0.35);
        car.flyVUp = 200 + car.speed * 0.70;
        car.flyY = 0;
        car.flyGrounded = false;
        car.flyBounces = 0;
        car.flyHeading = Math.atan2(-p.ty, p.tx);
        car.flySpin = (car.slideSide || 1) * (0.6 + car.flyVLat / 120);
        // 绕横轴端翻：速度越快翻得越猛，方向随甩出侧
        car.flyPitch = 0;
        car.flyPitchVel = (6 + car.speed * 0.02) * (car.slideSide || 1);
      }
      car.speed = 0;
      car.offsetVel = 0;
      car.totalDerails += 1;
      car.flightProgress = 0;
      car.flyHeight = 0;
      car.sliding = false;
      car.gripUse = 0;
      car.saveWindow = false;
      return car;
    }

    car.s += car.speed * dt;
    if (car.blinkT > 0) car.blinkT = Math.max(0, car.blinkT - dt);
    return car;
  }

  return {
    createCar: createCar,
    slotUnderDeck: slotUnderDeck,   // 调试用：归位目标是否在桥面遮挡死角
    update: update,
    setFlightHooks: setFlightHooks,
    getFlightHooks: getFlightHooks,
    MAX_SPEED: MAX_SPEED,
    GRIP: GRIP,
    DERAIL_OFFSET: DERAIL_OFFSET,
    DERAIL_TIME: DERAIL_TIME,
    FLIGHT_TIME: FLIGHT_TIME,
    REST_TIME: REST_TIME,
    RETURN_TIME: RETURN_TIME
  };
});
