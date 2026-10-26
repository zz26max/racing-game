/* 3D 车模：给现有 RaceGL 实例挂上两辆槽车（浏览器全局 window.RaceGLCars，普通脚本；不改 gl.js） */
(function (root) {
  'use strict';

  // 车体尺寸（世界单位）：车身 44×12×26，座舱 20×10×18，轮半径 7、宽 5
  var BODY_W = 44, BODY_H = 12, BODY_D = 26, BODY_Y = 7;
  var CABIN_W = 20, CABIN_H = 10, CABIN_D = 18, CABIN_Y = 16, CABIN_Z = -1;
  var WHEEL_R = 7, WHEEL_LEN = 5, WHEEL_SEG = 16;
  var WHEEL_X = 15, WHEEL_Y = 7, WHEEL_Z = 11;
  var LIGHT_W = 3, LIGHT_H = 3, LIGHT_D = 5, LIGHT_X = 22, LIGHT_Y = 8, LIGHT_Z = 7;
  var SPOILER_W = 3, SPOILER_H = 3, SPOILER_D = 22, SPOILER_X = -22, SPOILER_Y = 14;
  var WEDGE_W = 8, WEDGE_H = 4, WEDGE_D = 22, WEDGE_X = 21, WEDGE_Y = 9;

  var CAR_LIFT = 1;         // 路面抬升（与 gl.js 的路面高度基准一致）
  var CAR_SEAT = 0;         // 车身在路面之上的高度（Group 原点）
  var WHEEL_SPIN = 0.0008;  // 轮速 → 每帧自转角
  var SLIP_ANGLE = 0.05;    // 打滑时的车身摇摆幅度（rad）
  var SLIP_RATE = 20;       // 摇摆角频率（rad/s）
  var DERAIL_SCALE = 1.15;  // 脱轨时的放大倍数
  var BRIDGE_ELEV = 2;      // 判定“在桥上”的高度阈值
  var BRIDGE_SCALE = 1.08;  // 桥面行驶时的放大倍数（与脱轨取较大值）
  var BLINK_OPACITY = 0.85; // 复位期整体透明度（不再整辆隐显）
  var RIGID_HALF_H = 6.5;   // 刚体盒半高：车模原点（轮底）在刚体中心下方这个距离

  // 刚体位姿 → 车模位姿的复用临时量（每帧每车都要算，避免逐帧新建对象）
  var _q = null, _bottom = null;

  // 每辆车的颜色与车头/车尾特征：P1 红车带尾翼，P2 蓝车带车头楔形
  function makeCar(color, num, T) {
    var group = new T.Group();
    var wheels = [];

    var body = new T.Mesh(
      new T.BoxGeometry(BODY_W, BODY_H, BODY_D),
      new T.MeshStandardMaterial({ color: color, roughness: 0.45 })
    );
    body.position.y = BODY_Y;
    body.castShadow = true;
    group.add(body);

    var cabin = new T.Mesh(
      new T.BoxGeometry(CABIN_W, CABIN_H, CABIN_D),
      new T.MeshStandardMaterial({ color: 0x2b2320, roughness: 0.45 })
    );
    cabin.position.set(0, CABIN_Y, CABIN_Z);
    cabin.castShadow = true;
    group.add(cabin);

    var wheelMat = new T.MeshStandardMaterial({ color: 0x1b1714, roughness: 0.45 });
    var wheelGeo = new T.CylinderGeometry(WHEEL_R, WHEEL_R, WHEEL_LEN, WHEEL_SEG);
    var signs = [-1, 1];
    for (var xi = 0; xi < signs.length; xi++) {
      for (var zi = 0; zi < signs.length; zi++) {
        var wheel = new T.Mesh(wheelGeo, wheelMat);
        wheel.rotation.x = Math.PI / 2;
        wheel.position.set(signs[xi] * WHEEL_X, WHEEL_Y, signs[zi] * WHEEL_Z);
        wheel.castShadow = true;
        group.add(wheel);
        wheels.push(wheel);
      }
    }
    group.userData.wheels = wheels;

    // 车头灯：两盏 emissive 小方块，左右对称
    var lightMat = new T.MeshStandardMaterial({
      color: 0xffe0a0,
      emissive: 0xffe0a0,
      emissiveIntensity: 0.9,
      roughness: 0.45
    });
    var lightGeo = new T.BoxGeometry(LIGHT_W, LIGHT_H, LIGHT_D);
    for (var li = 0; li < signs.length; li++) {
      var lamp = new T.Mesh(lightGeo, lightMat);
      lamp.position.set(LIGHT_X, LIGHT_Y, signs[li] * LIGHT_Z);
      group.add(lamp);
    }

    // P1 尾翼 / P2 车头楔形（num 为 1 或 2）
    if (num === 1) {
      var spoiler = new T.Mesh(
        new T.BoxGeometry(SPOILER_W, SPOILER_H, SPOILER_D),
        new T.MeshStandardMaterial({ color: color, roughness: 0.45 })
      );
      spoiler.position.set(SPOILER_X, SPOILER_Y, 0);
      spoiler.castShadow = true;
      group.add(spoiler);
    } else {
      var wedge = new T.Mesh(
        new T.BoxGeometry(WEDGE_W, WEDGE_H, WEDGE_D),
        new T.MeshStandardMaterial({ color: color, roughness: 0.45 })
      );
      wedge.position.set(WEDGE_X, WEDGE_Y, 0);
      wedge.castShadow = true;
      group.add(wedge);
    }

    // 收集本车所有材质（去重）：复位期只改透明度，不再整辆车隐显
    var mats = [];
    group.traverse(function (o) {
      if (o && o.material && mats.indexOf(o.material) < 0) mats.push(o.material);
    });
    group.userData.mats = mats;
    group.userData.blinkOn = false;

    return group;
  }

  // 取赛道 s 处的单位切线：pointAt 只返回 x/y，切线优先取 sampleAt
  function tangentAt(track, s, p) {
    if (track && typeof track.sampleAt === 'function') {
      var t = track.sampleAt(s);
      if (t && isFinite(t.tx) && isFinite(t.ty)) return { tx: t.tx, ty: t.ty };
    }
    if (p && isFinite(p.tx) && isFinite(p.ty)) return { tx: p.tx, ty: p.ty };
    return { tx: 1, ty: 0 };
  }

  // 单辆车同步到赛道：位置 = 槽中心 + 法向 (ty,-tx) × 侧滑偏移，高度跟随赛道 elevationAt，
  // 朝向随切线（脱轨后用 car.flyHeading），俯仰随 slopeAt，打滑摇摆 / 脱轨端翻 / 复位半透明
  function syncCar(g, car, track, time) {
    var p = track.pointAt(car.s, car.lane);
    if (!p || !isFinite(p.x) || !isFinite(p.y)) return;
    var tan = tangentAt(track, car.s, p);

    // 脱轨前冲：car.flyForward 存在且 > 0 时，沿切线把车往前送，再叠加侧滑偏移
    var flyForward = Number(car.flyForward);
    if (isFinite(flyForward) && flyForward > 0) {
      p.x += tan.tx * flyForward;
      p.y += tan.ty * flyForward;
    }

    var off = (Number(car.offset) || 0) * (Number(car.slideSide) || 1);
    // 侧滑偏移沿 (ty, -tx) 施加（切线右方法线），与 flight-physics 抛出时的横向初速同向，
    // 渲染的侧滑方向才和物理实际甩出的方向一致
    var offX = tan.ty * off;
    var offZ = -tan.tx * off;

    // 赛道高度：未提供 elevationAt 视为平地 0；y = 路面抬升 + 赛道高度 + 车身坐高
    var elev = (typeof track.elevationAt === 'function') ? Number(track.elevationAt(car.s)) : 0;
    if (!isFinite(elev)) elev = 0;

    // 脱轨抬升：car.flyHeight 由 car.js 的飞出/归位正弦拱给出，直接叠到车身高度上
    var flyHeight = Number(car.flyHeight);
    if (!isFinite(flyHeight) || flyHeight < 0) flyHeight = 0;
    g.position.set(p.x + offX, CAR_LIFT + elev + CAR_SEAT + flyHeight, p.y + offZ);

    // 侧滑时车头朝弯外：侧滑角随 slip 增长，上限 0.5 rad（side 为弯道方向）
    // 脱轨后车身已不受抓地约束，侧滑角归零，朝向改用 car.flyHeading（世界朝向，含自旋）
    var slideYaw = 0;
    if (!car.derailed && typeof car.slip === 'number' && car.slip > 0.02) {
      slideYaw = -(Number(car.slideSide) || 1) * Math.min(0.5, car.slip * 0.8);
    }
    var yaw = car.derailed
      ? (isFinite(Number(car.flyHeading)) ? Number(car.flyHeading) : Math.atan2(-tan.ty, tan.tx))
      : Math.atan2(-tan.ty, tan.tx) + slideYaw;

    // 俯仰：上坡车头抬起、下坡低头；与打滑摆动相加（不覆盖）
    var pitch = 0;
    if (typeof track.slopeAt === 'function') {
      var slope = Number(track.slopeAt(car.s));
      if (isFinite(slope)) pitch = -Math.atan(slope);
    }
    var sway = car.slip > 0.25 ? Math.sin(time * SLIP_RATE) * SLIP_ANGLE : 0;

    // 端翻：脱轨时绕横轴的翻滚角直接用 car.js 维护的 flyPitch（fly 段累积，
    // rest / return 段由 car.js 自行衰减），此处只透传，不再叠加任何自旋/后空翻；
    // 未脱轨时保持正常行驶逻辑（坡度俯仰 + 打滑摆动）
    var pitchOrFlyPitch;
    if (car.derailed) {
      var flyPitch = Number(car.flyPitch);
      pitchOrFlyPitch = pitch + (isFinite(flyPitch) ? flyPitch : 0);
    } else {
      pitchOrFlyPitch = pitch + sway;
    }

    // 三轴一次性设定（rotation.x 显式归零）：清掉上一次世界坐标分支（刚体四元数）残留的
    // 绕 X 旋转，否则归位回赛道系后车会倒扣沉到地面以下、看上去像隐形
    g.rotation.set(0, yaw, pitchOrFlyPitch);

    // 刚体接管：飞行物理（cannon）已算出世界位姿时，位置与四元数直接照抄，
    // 跳过上面的赛道系旋转赋值（欧拉角会覆盖四元数），只保留材质/车轮等收尾
    if (car.worldActive && car.quat) {
      var T = root.THREE;
      var wy = Number(car.worldY);
      if (!isFinite(wy)) wy = 7;
      // 刚体中心 → 车模原点：车模原点（轮底）在刚体中心下方 RIGID_HALF_H 处，
      // 这个偏移必须随刚体姿态一起旋转，否则车倒扣/翻滚时仍按“永远正立”抬升，会扣到地下
      if (!_q) { _q = new T.Quaternion(); _bottom = new T.Vector3(); }
      _q.set(car.quat.x, car.quat.y, car.quat.z, car.quat.w);
      _bottom.set(0, -RIGID_HALF_H, 0).applyQuaternion(_q);
      g.position.set(car.worldX + _bottom.x, wy + _bottom.y, car.worldZ + _bottom.z);
      g.quaternion.copy(_q);
      // 车模初始 visible=false（标题页不显形），提前返回前必须显式点亮，否则飞行中整车不可见
      g.visible = true;
      // 世界坐标阶段（飞行/归位/停留）一律按原尺寸绘制，不再用 1.15 放大
      g.scale.setScalar(1);
      // 上一帧复位期可能把材质留在 BLINK_OPACITY 半透明状态，这里强制恢复不透明，
      // 否则本车会以“半隐形”状态飞出去；transparent 复位后由下方分支按需重新开启
      var wmats = g.userData.mats || [];
      for (var wi = 0; wi < wmats.length; wi++) {
        wmats[wi].transparent = false;
        wmats[wi].opacity = 1;
        wmats[wi].needsUpdate = true;
      }
      g.userData.blinkOn = false;
      return;
    }

    // 桥面放大与脱轨放大取较大值（阴影保持开启，车在桥上也投到桥面上）
    var scale = car.derailed ? DERAIL_SCALE : 1;
    if (elev > BRIDGE_ELEV && BRIDGE_SCALE > scale) scale = BRIDGE_SCALE;
    g.scale.setScalar(scale);

    // 复位期不再隐显：整辆车的材质统一降到 0.85 透明度（transparent 标志只在切换时重编译）
    var blinkOn = (Number(car.blinkT) || 0) > 0;
    var mats = g.userData.mats || [];
    if (blinkOn !== g.userData.blinkOn) {
      g.userData.blinkOn = blinkOn;
      for (var mi = 0; mi < mats.length; mi++) {
        mats[mi].transparent = blinkOn;
        mats[mi].opacity = blinkOn ? BLINK_OPACITY : 1;
        mats[mi].needsUpdate = true;
      }
    } else {
      for (var mj = 0; mj < mats.length; mj++) {
        mats[mj].opacity = blinkOn ? BLINK_OPACITY : 1;
      }
    }
    g.visible = true;

    // 轮子自转：绕自身轴（rotation.x = π/2 之前先转 Y）
    var wheels = g.userData.wheels || [];
    var spin = (Number(car.speed) || 0) * WHEEL_SPIN;
    for (var i = 0; i < wheels.length; i++) {
      wheels[i].rotation.y += spin;
    }
  }

  // 给 RaceGL 实例挂两辆车；包装 gl.render 以逐帧同步，返回同一个 gl
  function attach(gl, track) {
    if (!gl || !gl.scene || !root.THREE) return gl;
    var T = root.THREE;

    gl.track = track || gl.track || null;   // 切赛道时由 gl.setTrack 更新，逐帧同步读到最新
    var g1 = makeCar(0xE8503A, 1, T);
    var g2 = makeCar(0x2F8FD6, 2, T);
    var cars = [g1, g2];
    // 首帧同步前保持隐藏：标题页没有 race，车不能停在原点
    g1.visible = false;
    g2.visible = false;
    gl.scene.add(g1);
    gl.scene.add(g2);

    var orig = gl.render;
    gl.render = function (race, time) {
      var t = Number(time);
      if (!isFinite(t)) t = 0;
      var entries = race && race.entries;
      var tk = gl.track || track;
      if (entries && tk && typeof tk.pointAt === 'function') {
        for (var i = 0; i < cars.length; i++) {
          var entry = entries[i];
          var car = entry && entry.car;
          if (!car || !cars[i]) continue;
          try { syncCar(cars[i], car, tk, t); } catch (err) { /* 单车同步失败不影响整帧 */ }
        }
      }
      if (typeof orig === 'function') return orig.apply(gl, arguments);
      return undefined;
    };

    return gl;
  }

  root.RaceGLCars = { attach: attach };
})(window);
