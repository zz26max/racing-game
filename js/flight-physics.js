/* 脱轨后的自由飞行刚体（cannon.js 0.6.2）：只接管飞出赛道的抛出段，不参与赛道内物理。
 * 多车隔离：每辆车（car 对象本身为 key）各有一套独立的 world / 地面 / 车体 / 材质，互不共用。
 * 静态碰撞：地面平面 + 桥面/引桥承力板（随坡度倾斜）+ 沿赛道两侧整圈的矮护栏墙。
 * 护栏墙足够矮（高 7），低速脱轨被挡回槽内，高速脱轨仍能越过落在外侧地面。
 * 普通脚本：浏览器挂 window.RaceFlightPhysics；Node 下 require 时若无全局 CANNON 则导出 null。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    var cannon = (typeof globalThis !== 'undefined' ? globalThis.CANNON : null) || null;
    module.exports = factory(cannon);
  } else {
    root.RaceFlightPhysics = factory(root.CANNON);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (CANNON) {
  'use strict';

  // 依赖缺失时明确返回 null，便于 Node 端在无物理库时安全探测
  if (!CANNON) return null;

  // 飞行阶段最长时长（秒）、软超时后的硬截止、落地判定参数（px/s、秒）
  var MAX_FLIGHT_TIME = 2.2;
  var HARD_STOP_TIME = MAX_FLIGHT_TIME + 0.6;
  var STOP_SPEED = 40;
  var LANDED_HOLD = 0.25;
  // 固定子步（秒）：world.step 的固定步长
  var FIXED_STEP = 1 / 120;
  // 角速度渐入时长（秒）：起跳后这段时间内从 0 线性升到目标角速度
  var SPIN_RAMP = 0.15;
  var MAX_START_MARGIN = 0.5;   // 起跳横向坐标距护栏内壁留的余量（px）

  // 说明：视觉护栏仍由 gl.js 绘制；物理侧另建一圈矮护栏墙（见 buildWallRing）。
  // 桥面承力板：覆盖平段 + 引桥，每 20 一块、厚 4，顶面比视觉路面高 0.5
  var DECK_SEG = 20;
  var DECK_THICK = 4;

  // 护栏墙：每 40px 一段、厚 3、高 7，横向中心距中心线 halfW + 3 + 1.5（默认 46.5）
  var WALL_SEG = 40;
  var WALL_THICK = 3;
  var WALL_HEIGHT = 7;

  // 单个 car 的独立飞行世界。每个实例持有自己的 world、地面、静态桥面、车体与材质。
  function createState() {
    var world = null;
    var groundBody = null;
    var groundMaterial = null;
    var carMaterial = null;
    var carBody = null;
    var staticsBuilt = false;
    var staticsTrack = null;   // 静态体所属赛道（切赛道时重建）
    var staticBodies = [];     // 已加入 world 的静态体清单
    var wallBoxes = [];        // 护栏段定向盒参数（只给 begin 的起跳位姿自避让用，随 buildStatics 重建）

    // 已落地计时与飞行累计时间
    var startTime = 0;
    var elapsed = 0;
    var landedTime = 0;
    var active = false;
    // 本车本次飞行的目标角速度（begin 时记录，step 里 0.15s 内线性渐入）
    var spinTarget = null;

    // 桥面 + 引桥承力板：每 20 一块倾斜静态盒，顶面贴住视觉路面；贴地段交给地面平面
    function buildDeck(track, halfW) {
      if (!track.bridge || typeof track.elevationAt !== 'function') return;
      var sc = Number(track.bridge.sCenter) || 0;
      var rb = Number(track.bridge.rampHalf) || 0;
      if (!(rb > 0)) return;
      for (var d = -rb; d < rb; d += DECK_SEG) {
        var sa = sc + d, sb = sc + d + DECK_SEG;
        var pa = track.sampleAt(sa), pb = track.sampleAt(sb);
        if (!pa || !pb) continue;
        var elevM = ((Number(track.elevationAt(sa)) || 0) + (Number(track.elevationAt(sb)) || 0)) / 2;
        if (!(elevM > 0.5)) continue;   // 平地段不需要额外承力板
        var dx = pb.x - pa.x, dz = pb.y - pa.y;
        var len = Math.sqrt(dx * dx + dz * dz);
        if (len < 1e-6) continue;
        dx /= len; dz /= len;
        var slope = (typeof track.slopeAt === 'function') ? (Number(track.slopeAt(sa)) || 0) : 0;
        var body = new CANNON.Body({ mass: 0 });
        body.addShape(new CANNON.Box(new CANNON.Vec3(len / 2 + 3, DECK_THICK / 2, halfW + 4)));
        body.material = groundMaterial;
        body.position.set((pa.x + pb.x) / 2, 1 + elevM - DECK_THICK / 2 + 0.5, (pa.y + pb.y) / 2);
        // 先绕 Y 对齐走向，再绕“左法向”倾斜坡度角：slope>0（前方上坡）时 +X 端抬起
        var qYaw = new CANNON.Quaternion();
        qYaw.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), Math.atan2(-dz, dx));
        var qTilt = new CANNON.Quaternion();
        qTilt.setFromAxisAngle(new CANNON.Vec3(-dz, 0, dx), Math.atan(slope));
        qTilt.mult(qYaw, body.quaternion);
        world.addBody(body);
        staticBodies.push(body);
      }
    }

    // 护栏墙：沿整圈赛道左右两侧各建一串静态盒。每段用中点采样定朝向（切线即盒的 +X），
    // 底面贴路面、顶面到路面上方 7：中心 y = 1 + elevationAt(s) + 3.5。
    // 只在飞行世界里存在，不参与赛道内物理；坡道/桥面段随 elevationAt 一起抬升。
    function buildWallRing(track, halfW) {
      if (typeof track.sampleAt !== 'function') return;
      var total = Number(track.totalLength);
      if (!(total > 0)) return;
      var count = Math.max(1, Math.round(total / WALL_SEG));
      var step = total / count;                       // 实际段长（闭合环等分，接近 40）
      var lat = halfW + WALL_THICK + 1.5;             // 横向中心：halfW + 3 + 1.5 = 46.5
      var halfH = WALL_HEIGHT / 2;
      var halfT = WALL_THICK / 2;
      for (var i = 0; i < count; i++) {
        var sm = (i + 0.5) * step;
        var pm = track.sampleAt(sm);
        if (!pm) continue;
        var tx = Number(pm.tx), ty = Number(pm.ty);
        if (!isFinite(tx) || !isFinite(ty)) continue;
        var tl = Math.sqrt(tx * tx + ty * ty);
        if (!(tl > 1e-9)) continue;
        tx /= tl; ty /= tl;
        var elev = (typeof track.elevationAt === 'function')
          ? (Number(track.elevationAt(sm)) || 0) : 0;
        var cy = 1 + elev + halfH;
        // 绕 Y 轴朝向：与桥面承力板同一约定（切线 +X，世界 Z 对应赛道 y）
        var yaw = Math.atan2(-ty, tx);
        for (var side = -1; side <= 1; side += 2) {
          var body = new CANNON.Body({ mass: 0 });
          body.addShape(new CANNON.Box(new CANNON.Vec3(step / 2, halfH, halfT)));
          body.material = groundMaterial;   // castShadow 仅在渲染层，静态体不需要
          // 法向为 (-ty, tx)，两侧各偏移 lat
          body.position.set(pm.x - ty * lat * side, cy, pm.y + tx * lat * side);
          body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), yaw);
          world.addBody(body);
          staticBodies.push(body);
          // 登记该段的定向盒参数供起跳位姿自避让（只读快照，不参与碰撞求解）：
          // 绕 Y 转 yaw 把局部 +X 转到 (cos yaw, 0, -sin yaw)，即 u 轴；厚度沿局部 +Z。
          wallBoxes.push({
            x: body.position.x,
            z: body.position.z,
            y: cy,
            ux: Math.cos(yaw),
            uz: -Math.sin(yaw),
            halfLen: step / 2,
            halfT: halfT,
            halfH: halfH
          });
        }
      }
    }

    // 起跳位姿是否与任何护栏段重叠。车体 Box 是 44×13×13，这里近似成沿车身纵向的
    // 3 个半径 13 的圆（车心、车头前 16、车尾后 16），逐个与登记的定向盒做
    // “点 vs 膨胀盒”测试：把点变到墙盒局部坐标系后，三轴半宽各加车体对应的半尺寸。
    // 只做判断、不加任何静态体，墙体几何与视觉完全不变。
    function spawnBlocked(x, y, z, yaw) {
      var n = wallBoxes.length;
      if (!n) return false;
      var R = 13;        // 取样圆半径（车体半宽）
      var GAP = 16;      // 车头/车尾取样点距车心的纵向距离
      var HH = 6.5;      // 车体半高
      var fx = Math.cos(yaw), fz = -Math.sin(yaw);   // 车身前向单位向量（与墙盒 u 轴同约定）
      for (var k = -1; k <= 1; k++) {
        var px = x + fx * GAP * k;
        var pz = z + fz * GAP * k;
        for (var i = 0; i < n; i++) {
          var b = wallBoxes[i];
          var dx = px - b.x, dz = pz - b.z;
          if (dx * dx + dz * dz > 3600) continue;          // 60px 距离粗筛
          if (Math.abs(y - b.y) >= b.halfH + HH) continue; // 竖直不重叠
          var lu = dx * b.ux + dz * b.uz;
          if (lu <= -(b.halfLen + R) || lu >= b.halfLen + R) continue;
          var lv = -dx * b.uz + dz * b.ux;
          if (lv <= -(b.halfT + R) || lv >= b.halfT + R) continue;
          return true;
        }
      }
      return false;
    }

    function buildStatics(track) {
      wallBoxes.length = 0;   // 与静态体一同重建，避免切赛道后残留旧墙盒
      if (!track || typeof track.sampleAt !== 'function') return;
      var halfW = (Number(track.width) || 84) / 2;
      buildDeck(track, halfW);
      buildWallRing(track, halfW);
      staticsBuilt = true;
      staticsTrack = track;
    }

    // 该车首次 begin 时建自己的 world、地面与静态桥面，之后复用（只在本车内复用）
    function ensureWorld(track) {
      if (world) {
        if (staticsBuilt && staticsTrack !== track) {
          // 切换赛道：拆掉旧静态体，按新赛道重建（车体与地面保留）
          for (var i = 0; i < staticBodies.length; i++) world.removeBody(staticBodies[i]);
          staticBodies.length = 0;
          staticsBuilt = false;
        }
        if (!staticsBuilt && track) buildStatics(track);
        return;
      }

      world = new CANNON.World();
      world.gravity.set(0, -1400, 0);
      world.broadphase = CANNON.SAPBroadphase ? new CANNON.SAPBroadphase(world) : new CANNON.NaiveBroadphase();
      world.solver.iterations = 10;

      groundMaterial = new CANNON.Material('flight-ground');
      carMaterial = new CANNON.Material('flight-car');
      groundMaterial.friction = 0.16;
      groundMaterial.restitution = 0.3;
      carMaterial.friction = 0.16;
      carMaterial.restitution = 0.3;
      // 车与地面/桥面之间的接触参数：摩擦 0.16、弹性 0.3（低弹跳，撞击以减速吸收为主）
      // 弹性 0.3 是实测值——原来 0.4 时首次落地会回弹约 10.7px（0.76 倍车高），
      // 降到 0.3 后回弹明显收敛，落地以滑行吸收为主。
      world.addContactMaterial(new CANNON.ContactMaterial(groundMaterial, carMaterial, {
        friction: 0.16,
        restitution: 0.3
      }));

      // 地面：mass 0 的平面，绕 X 轴 -90° 使默认 +Z 法线立起来变成 +Y；地面 y = 1
      groundBody = new CANNON.Body({ mass: 0 });
      groundBody.addShape(new CANNON.Plane());
      groundBody.material = groundMaterial;
      groundBody.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
      groundBody.position.set(0, 1, 0);
      world.addBody(groundBody);

      if (track) buildStatics(track);
    }

    // 当前步是否踩在任意支撑面上（地面或桥面，均计入“已落地”）
    function touchingSupport() {
      if (!carBody || !world) return false;
      var contacts = world.contacts || [];
      for (var i = 0; i < contacts.length; i++) {
        var c = contacts[i];
        if (c.bi === carBody || c.bj === carBody) return true;
      }
      return false;
    }

    // 开始一次自由飞行：car 提供 s/lane/speed/offsetVel/slideSide；track 提供 pointAt/sampleAt
    function begin(car, track) {
      ensureWorld(track);

      // 重飞：移除本车上一次的飞行体，静态桥面保留复用
      if (carBody) {
        world.removeBody(carBody);
        carBody = null;
      }

      var lane = Number(car.lane);
      if (!isFinite(lane)) lane = 0;
      var speed = Number(car.speed);
      if (!isFinite(speed)) speed = 0;
      if (speed < 0) speed = 0;
      var s = Number(car.s);
      if (!isFinite(s)) s = 0;

      // 赛道坐标是 2D：世界 X = x、世界 Z = y
      var p = (track && typeof track.pointAt === 'function')
        ? track.pointAt(s, lane) : { x: 0, y: 0 };
      if (!p || !isFinite(p.x) || !isFinite(p.y)) p = { x: 0, y: 0 };

      // 单位切线：由 sampleAt 取；缺失时退化为 +X
      var tan = (track && typeof track.sampleAt === 'function')
        ? track.sampleAt(s) : null;
      var tx = 1, ty = 0;
      if (tan && isFinite(tan.tx) && isFinite(tan.ty)) {
        tx = tan.tx;
        ty = tan.ty;
      }

      var side = Number(car.slideSide) || 1;

      // 起跳点：从槽心 pointAt(s, lane) 沿外法线 (ty,-tx)×side 偏移 |offset|，但要对
      // “距中心线的有符号横向坐标”做 clamp，而不是对 |offset| 做 clamp：
      // lane 的槽心本身已经在中心线 ±22（LANE_OFFSET），只用 32 这个绝对上限会让
      // 外槽脱轨的起跳点落到 22+32=54 处、车身外沿 54+13=67，直接嵌进护栏墙
      // （墙内壁 = halfW+3 = 45），首帧就吃接触冲量。
      // 允许的最大横向坐标 = 护栏内壁 (halfW + 3) − 车半宽 13 − 余量 0.5。
      var offLat = Number(car.offset) || 0;
      if (!isFinite(offLat)) offLat = 0;
      var laneOffset = (track && isFinite(Number(track.laneOffset))) ? Number(track.laneOffset) : 22;
      var laneLat = (Number(car.lane) || 0) * laneOffset;       // 槽心横向坐标（track.laneOffset，默认 22）
      var halfTrackW = (track && isFinite(Number(track.width))) ? Number(track.width) / 2 : 42;
      var maxLat = halfTrackW + 3 - 13 - MAX_START_MARGIN;     // 45 − 13 − 0.5 = 31.5
      var startLat = laneLat - side * offLat;                  // 法线 n=(-ty,tx) 方向的坐标
      if (startLat > maxLat) startLat = maxLat;
      else if (startLat < -maxLat) startLat = -maxLat;
      var latDelta = startLat - laneLat;
      var startX = p.x - ty * latDelta;
      var startZ = p.y + tx * latDelta;

      // 横向甩出速度优先用脱轨瞬间的真实侧滑速度（offsetVel），夹在 0.28~0.50 倍车速之间：
      // 侧滑过小（偏移触发的脱轨）也给足离槽的横向分量，过大则收敛
      var slip = Math.abs(Number(car.offsetVel) || 0);
      var lat = Math.max(slip, speed * 0.28);
      if (lat > speed * 0.50) lat = speed * 0.50;

      // 甩出力度倍率 m：?throw=0.6 甩得近、?throw=1.4 甩得远，默认 1。
      // 只缩放水平初速 vx/vz，vy 不乘，保持小跳手感不变。范围钳在 [0.3, 2.0]。
      // 注意：factory 里没有外层 UMD 的 root 变量（原来取 root.location 会抛 ReferenceError 被
      // catch 吞掉，导致 ?throw 恒等于 1），这里改用 globalThis.location。
      var m = 1;
      try {
        var g = (typeof globalThis !== 'undefined') ? globalThis : null;
        var q = ((g && g.location && g.location.search) || '').match(/[?&]throw=([\d.]+)/);
        if (q) {
          var v = parseFloat(q[1]);
          if (isFinite(v)) m = Math.min(2, Math.max(0.3, v));
        }
      } catch (e) {}

      // 初始速度：纵向沿切线保留大部分动量、横向沿法线 (ty,-tx)、竖直小幅离地（全部 px/s）。
      // 横向取 (ty,-tx) 而非 (-ty,tx)：(-ty,tx) 会把车甩向弯道内侧、被赛道接住；
      // (ty,-tx) 是它的反向，车被甩向弯道外侧（越过路肩落到地毯）。
      // 竖直分量给小跳（脱离槽面），不再大角度上抛——脱轨是甩滑出去，不是起飞。
      var vx = (tx * speed * 1.0 + ty * lat * side) * m;
      var vz = (ty * speed * 1.0 - tx * lat * side) * m;
      var vy = 180 + speed * 0.22;

      // 高度优先取 pointAt 返回点上的 elevationAt；没有则回落到 track.elevationAt(s)；都没有视为平地 0。
      var elev = 0;
      if (isFinite(p.elevationAt)) {
        elev = Number(p.elevationAt);
      } else if (track && typeof track.elevationAt === 'function') {
        var e = Number(track.elevationAt(s));
        if (isFinite(e)) elev = e;
      }

      // 起跳高度：全文件只在这里定义一次，车体创建与起跳位姿自避让共用同一份取值。
      var startY = 1 + elev + 7.5 + 8;

      // 初始朝向的偏航分量：切线 yaw 上叠加侧滑角，侧滑角与渲染层同一公式
      // （slideYaw = -side × min(0.5, slip × 0.8)，slip 取 car.slip）。
      // 这里提前算好，是因为起跳位姿自避让需要最终的车身朝向。
      var baseYaw = Math.atan2(-ty, tx);
      var slipVal = Number(car.slip) || 0;
      if (!isFinite(slipVal)) slipVal = 0;
      var slideYaw = -side * Math.min(0.5, slipVal * 0.8);
      var spawnYaw = baseYaw + slideYaw;

      // 起跳位姿自避让：极紧弯内侧的护栏段会折进路面，起跳点可能落在墙体内部。
      // 以 2px 步朝槽心收缩横向坐标，最多 26px，直到车体与任何护栏段不重叠。
      var shrink = 0;
      while (shrink < 26 && spawnBlocked(startX, startY, startZ, spawnYaw)) {
        shrink += 2;
        var toward = (startLat > laneLat) ? -1 : (startLat < laneLat ? 1 : 0);
        if (toward === 0) break;
        startLat += toward * 2;
        latDelta = startLat - laneLat;
        startX = p.x - ty * latDelta;
        startZ = p.y + tx * latDelta;
      }

      // 车体：Box 半尺寸 (22,6.5,13)，质量 1，中心悬于路面之上
      var shape = new CANNON.Box(new CANNON.Vec3(22, 6.5, 13));
      carBody = new CANNON.Body({ mass: 1 });
      carBody.addShape(shape);
      carBody.material = carMaterial;
      // 初始高度 startY：路面上方 7.5（车体中心离地）+ 地面 1，再加赛道自身高度，
      // 使在桥面/坡道上甩出时第一帧不往下掉、也不与承力板初始穿插。
      // 末尾 +8 的来历：物理护栏高 7（WALL_HEIGHT），车体半高 6.5。原来只抬 2 时车体
      // 竖直范围是路面上 3~16，与护栏（0~7）竖直重叠，外槽脱轨一开始就紧贴护栏内壁，
      // 横向速度被护栏侧面接触立刻吃掉——实测外槽脱轨横向只飞 1.6~24px，看起来只是
      // “撞一下护栏又回槽”。抬到 8 后车体底部在路面上 9，高于护栏顶 7，横向甩出不会再
      // 被护栏侧面挡死，而是从矮护栏上方甩到路肩外。
      carBody.position.set(startX, startY, startZ);
      carBody.velocity.set(vx, vy, vz);

      // 初始朝向：偏航用上面算好的 spawnYaw；若 track.slopeAt 存在，
      // 再绕车身 Z 轴（横向轴）按坡度叠加俯仰
      var qYaw = new CANNON.Quaternion();
      qYaw.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), spawnYaw);
      var qPitch = null;
      if (track && typeof track.slopeAt === 'function') {
        var slopeRoot = Number(track.slopeAt(s));
        if (isFinite(slopeRoot) && slopeRoot !== 0) {
          qPitch = new CANNON.Quaternion();
          qPitch.setFromAxisAngle(new CANNON.Vec3(0, 0, 1), Math.atan(slopeRoot));
        }
      }
      // 先车身系俯仰、再 yaw：q = qYaw × qPitch
      if (qPitch) qYaw.mult(qPitch, carBody.quaternion);
      else carBody.quaternion.set(qYaw.x, qYaw.y, qYaw.z, qYaw.w);

      // 初始角速度：翻滚轴取 up×v（up=(0,1,0)，v 为水平速度 (vx,0,vz)）再归一化，
      // 即绕垂直于运动方向的水平轴翻转；幅度收敛在 1 圈上下，速度越快翻得越猛
      var axisX = vz, axisZ = -vx;
      var axisLen = Math.sqrt(axisX * axisX + axisZ * axisZ);
      if (axisLen > 1e-6) {
        axisX = axisX / axisLen;
        axisZ = axisZ / axisLen;
      } else {
        // 水平速度近似为零时退化为 up×切线，避免除零导致角速度为 NaN
        axisX = ty;
        axisZ = -tx;
      }
      var spin = 1.6 + speed * 0.010;
      // 角速度渐入：目标角速度先记录，step 里 SPIN_RAMP 时间内从 0 线性升到目标，
      // 否则起跳瞬间就被角速度拽着翻，车身会一头扎进地面
      spinTarget = {
        x: axisX * spin * side,
        // 叠加少量偏航自旋：翻滚之外还带一点绕 Y 的转动
        y: side * 0.8,
        z: axisZ * spin * side
      };
      car._spinRampT = 0;
      carBody.angularVelocity.set(0, 0, 0);
      // 阻尼：线性小幅空气阻力，角阻尼让翻滚在飞行段内自然收住
      carBody.linearDamping = 0.12;
      carBody.angularDamping = 0.35;

      world.addBody(carBody);

      startTime = world.time;
      elapsed = 0;
      landedTime = 0;
      active = true;
      car.worldActive = true;
      // 立即把刚体位姿写回 car：同帧渲染就会读到，避免沿用上一帧/归位期的旧位姿
      car.worldX = carBody.position.x;
      car.worldY = carBody.position.y;
      car.worldZ = carBody.position.z;
      car.quat = {
        x: carBody.quaternion.x,
        y: carBody.quaternion.y,
        z: carBody.quaternion.z,
        w: carBody.quaternion.w
      };
      return car;
    }

    // 推进自由飞行；dt 为真实帧时长（秒），内部按 1/120 固定子步积分
    function step(car, dt) {
      if (!active || !carBody) return car;
      var d = Number(dt);
      if (!isFinite(d) || d <= 0) return car;

      // 角速度渐入：起跳后 SPIN_RAMP 秒内从 0 线性升到 begin 记录的目标角速度
      if (spinTarget) {
        var rt = Number(car._spinRampT);
        if (!isFinite(rt)) rt = SPIN_RAMP;
        if (rt < SPIN_RAMP) {
          rt += d;
          car._spinRampT = rt;
          var kr = rt >= SPIN_RAMP ? 1 : rt / SPIN_RAMP;
          carBody.angularVelocity.set(spinTarget.x * kr, spinTarget.y * kr, spinTarget.z * kr);
        }
      }

      world.step(FIXED_STEP, d, 4);
      elapsed += d;

      // 软超时后：水平速度强衰减，让车就近落到支撑面上，避免冻结在半空或长距离滑行
      if (elapsed > MAX_FLIGHT_TIME) {
        var damp = Math.exp(-6 * d);
        carBody.velocity.x *= damp;
        carBody.velocity.z *= damp;
      }

      // 位姿写回：位置三轴与四元数（three 的 Quaternion 同序）
      var pos = carBody.position;
      var q = carBody.quaternion;
      car.worldX = pos.x;
      car.worldY = pos.y;
      car.worldZ = pos.z;
      car.quat = { x: q.x, y: q.y, z: q.z, w: q.w };

      // 落地计时：与任意支撑面有接触即视为已落地；离地则清零
      if (touchingSupport()) landedTime += d;
      else landedTime = 0;

      var speed = carBody.velocity.norm();
      if ((speed < STOP_SPEED && landedTime > LANDED_HOLD) ||
          (elapsed > MAX_FLIGHT_TIME && landedTime > 0) ||
          elapsed > HARD_STOP_TIME) {
        active = false;
        car.worldActive = false;
      }
      return car;
    }

    return {
      begin: begin,
      step: step,
      isActive: function () { return active; },
      get startTime() { return startTime; },
      get elapsed() { return elapsed; }
    };
  }

  function create() {
    // car 对象本身作为 key：每辆车只拿到属于自己的那一套世界
    var states = new WeakMap();
    var activeCount = 0;
    var lastState = null;

    function stateOf(car) {
      var st = states.get(car);
      if (!st) {
        st = createState();
        states.set(car, st);
      }
      return st;
    }

    // 开始该车自己的自由飞行
    function begin(car, track) {
      if (!car) return car;
      var st = stateOf(car);
      if (!st.isActive()) activeCount++;
      lastState = st;
      return st.begin(car, track);
    }

    // 只推进该车自己的 world；停稳时把 car.worldActive 置 false
    function step(car, dt) {
      if (!car) return car;
      var st = states.get(car);
      if (!st) return car;
      lastState = st;
      var was = st.isActive();
      st.step(car, dt);
      if (was && !st.isActive()) activeCount--;
      return car;
    }

    return {
      begin: begin,
      step: step,
      // 调试用：是否还有车处于自由飞行中
      get active() { return activeCount > 0; },
      // 调试用：最近一次操作的车的开始时刻（world.time）与累计飞行时间
      get startTime() { return lastState ? lastState.startTime : 0; },
      get elapsed() { return lastState ? lastState.elapsed : 0; }
    };
  }

  return {
    create: create,
    MAX_FLIGHT_TIME: MAX_FLIGHT_TIME,
    HARD_STOP_TIME: HARD_STOP_TIME,
    STOP_SPEED: STOP_SPEED,
    LANDED_HOLD: LANDED_HOLD,
    FIXED_STEP: FIXED_STEP
  };
});
