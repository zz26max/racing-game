/* 3D 车模：给现有 RaceGL 实例挂上两辆槽车（浏览器全局 window.RaceGLCars，普通脚本；不改 gl.js） */
(function (root) {
  'use strict';

  // 玩具槽车尺寸（世界单位）：全长 44、主体宽 21.4、车顶高 21.3，轮径 16（大脚玩具比例）
  var WHEEL_R = 8, WHEEL_LEN = 6.2, WHEEL_SEG = 24;
  var WHEEL_X = 15, WHEEL_Y = 8, WHEEL_Z = 11.4;

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

  // 车壳挤出时轮廓会沿法线外扩 bevelSize，贴面件（风挡/条纹）要按这个量抬起才不埋进壳里
  var BODY_BEVEL = 0.7;

  // 侧面轮廓：一条闭合曲线描述整车剪影——低鼻、长引擎盖、后置座舱、短尾
  function bodyShape(T) {
    var s = new T.Shape();
    s.moveTo(-18.6, 3.2);
    s.lineTo(15.6, 3.2);
    s.quadraticCurveTo(21.4, 3.2, 22.2, 7.0);
    s.quadraticCurveTo(22.6, 9.7, 20.5, 10.4);
    s.lineTo(12.8, 11.9);
    s.quadraticCurveTo(9.6, 12.5, 8.2, 14.3);
    s.lineTo(3.7, 20.2);
    s.quadraticCurveTo(2.8, 21.3, 1.2, 21.3);
    s.lineTo(-8.4, 21.3);
    s.quadraticCurveTo(-10.2, 21.3, -11.4, 20.1);
    s.lineTo(-16.2, 14.5);
    s.quadraticCurveTo(-17.3, 13.2, -19.1, 13.2);
    s.lineTo(-20.6, 13.2);
    s.quadraticCurveTo(-22.0, 13.2, -22.0, 11.6);
    s.lineTo(-22.0, 5.4);
    s.quadraticCurveTo(-22.0, 3.2, -18.6, 3.2);
    return s;
  }

  // 整车车身：侧面轮廓沿车宽挤出 + 双面倒角（宽 18 + 2×1.7 = 21.4），不再是方块堆叠
  function bodyMesh(T, mat) {
    var geo = new T.ExtrudeGeometry(bodyShape(T), {
      depth: 18, bevelEnabled: true, bevelThickness: 1.7, bevelSize: BODY_BEVEL,
      bevelSegments: 3, steps: 1, curveSegments: 12
    });
    var m = new T.Mesh(geo, mat);
    m.position.z = -9;
    m.castShadow = true;
    return m;
  }

  // 轮拱翼子板：以轮胎为心的圆管弧，截面沿车宽压扁成眉檐；端头自然圆收，不露厚切面
  function fenderMesh(T, mat) {
    var geo = new T.TorusGeometry(8.9, 0.8, 10, 24, Math.PI - 0.9);
    var m = new T.Mesh(geo, mat);
    m.rotation.z = 0.45;
    m.scale.z = 3.5;
    m.castShadow = true;
    return m;
  }

  // 斜面上的薄板（风挡 / 后窗 / 条纹）：由两点定方向，沿向上法线抬起 offset
  function slopedPanel(T, x1, y1, x2, y2, w, thick, mat, offset, z) {
    var dx = x2 - x1, dy = y2 - y1;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    var nx = dy / len, ny = -dx / len;
    if (ny < 0) { nx = -nx; ny = -ny; }
    var m = new T.Mesh(new T.BoxGeometry(len, thick, w), mat);
    m.position.set((x1 + x2) / 2 + nx * offset, (y1 + y2) / 2 + ny * offset, z || 0);
    m.rotation.z = Math.atan2(dy, dx);
    m.castShadow = true;
    return m;
  }

  // 侧窗：前门 + 后侧窗合成一条玻璃带，贴在车壳侧平面 z=±10.7 上（车壳外扩后侧平面仍在该处）
  function sideWindowShape(T) {
    var s = new T.Shape();
    s.moveTo(7.0, 15.0);
    s.quadraticCurveTo(7.3, 17.4, 4.5, 19.4);
    s.lineTo(1.2, 19.6);
    s.lineTo(-8.9, 19.6);
    s.quadraticCurveTo(-11.2, 19.3, -12.9, 16.6);
    s.lineTo(-13.5, 15.0);
    s.lineTo(7.0, 15.0);
    return s;
  }
  function sideWindows(T, mat) {
    var geo = new T.ExtrudeGeometry(sideWindowShape(T), {
      depth: 0.4, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.08,
      bevelSegments: 1, steps: 1, curveSegments: 10
    });
    var pair = [];
    var right = new T.Mesh(geo, mat);
    right.position.z = 10.24;   // 外表面 = 10.72，略高于车壳侧平面
    var left = new T.Mesh(geo, mat);
    left.position.z = -10.64;   // 几何沿 +Z 挤出，左侧直接平移贴面
    right.castShadow = true;
    left.castShadow = true;
    pair.push(right, left);
    return pair;
  }

  // 尾翼：翼型截面沿车宽挤出；这样 rotation.z 才是真正的迎角（旧写法在放平后再转 Z 会变成偏航）
  function wingMesh(T, chord, span, mat) {
    var s = new T.Shape();
    var c = chord / 2, t = 0.45;
    s.moveTo(-c, 0);
    s.quadraticCurveTo(-c + 0.2, t, -c + 1.1, t);
    s.lineTo(c - 0.9, t * 0.85);
    s.quadraticCurveTo(c - 0.1, t * 0.5, c, 0);
    s.quadraticCurveTo(c - 0.2, -t * 0.8, c - 1.0, -t * 0.9);
    s.lineTo(-c + 1.0, -t * 0.9);
    s.quadraticCurveTo(-c, -t * 0.6, -c, 0);
    var geo = new T.ExtrudeGeometry(s, {
      depth: span - 0.6, bevelEnabled: true, bevelThickness: 0.3, bevelSize: 0.3,
      bevelSegments: 2, steps: 1, curveSegments: 8
    });
    var m = new T.Mesh(geo, mat);
    m.position.z = -(span - 0.6) / 2;
    m.castShadow = true;
    return m;
  }

  // 车顶圆标 + 车号：canvas 画透明贴图，俯视机位下看得见的玩具赛车涂装
  function makeRoundel(T, num, y) {
    var cv = document.createElement('canvas');
    cv.width = 128; cv.height = 128;
    var ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, 128, 128);
    ctx.fillStyle = '#E9DCC4';
    ctx.beginPath(); ctx.arc(64, 64, 60, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#2b2320';
    ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(64, 64, 57, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#2b2320';
    ctx.font = 'bold 84px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(num), 64, 70);
    var mat = new T.MeshBasicMaterial({ map: new T.CanvasTexture(cv), transparent: true, depthWrite: false });
    var m = new T.Mesh(new T.PlaneGeometry(6, 6), mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(-3.4, y, 0);
    return m;
  }

  // 每辆车的涂装与特征件：P1 红车（米白大尾翼 + 1 号），P2 蓝车（低尾翼 + 2 号 + 引擎盖进气口）
  function makeCar(color, num, T) {
    var group = new T.Group();
    var wheels = [];

    // 车漆低粗糙度模拟注塑玩具的高光；镀铬不用高 metalness：没有环境贴图时高金属度会发黑
    var paint = new T.MeshStandardMaterial({ color: color, roughness: 0.3, metalness: 0.12 });
    var cream = new T.MeshStandardMaterial({ color: 0xE9DCC4, roughness: 0.38, metalness: 0.05 });
    var dark = new T.MeshStandardMaterial({ color: 0x2b2320, roughness: 0.55, metalness: 0.1 });
    var glass = new T.MeshStandardMaterial({ color: 0x18212b, roughness: 0.16, metalness: 0.35 });
    var chrome = new T.MeshStandardMaterial({ color: 0xdfe4ea, roughness: 0.22, metalness: 0.35 });
    var tire = new T.MeshStandardMaterial({ color: 0x171412, roughness: 0.85 });
    var lamp = new T.MeshStandardMaterial({ color: 0xfff0c4, emissive: 0xffd98a, emissiveIntensity: 1.1, roughness: 0.25 });
    var tail = new T.MeshStandardMaterial({ color: 0xff4a36, emissive: 0xff2a18, emissiveIntensity: 1.2, roughness: 0.3 });

    function box(w, h, d, mat, x, y, z, rz) {
      var m = new T.Mesh(new T.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      if (rz) m.rotation.z = rz;
      m.castShadow = true;
      group.add(m);
      return m;
    }

    // 车身：一整块挤出曲面
    group.add(bodyMesh(T, paint));

    // 底盘与侧裙：压暗车底、封住轮拱处的透空（侧裙贴车壳侧平面）
    box(35, 2.6, 17.6, dark, -1, 3.3, 0);
    box(27, 1.9, 0.6, dark, -0.5, 4.35, 10.62);
    box(27, 1.9, 0.6, dark, -0.5, 4.35, -10.62);

    // 四个轮拱翼子板：圆管弧贴着轮胎上缘，比轮胎窄一圈，露出胎面
    for (var fi = 0; fi < 4; fi++) {
      var fender = fenderMesh(T, paint);
      fender.position.set(fi % 2 === 0 ? WHEEL_X : -WHEEL_X, WHEEL_Y, fi < 2 ? WHEEL_Z : -WHEEL_Z);
      group.add(fender);
    }

    // 风挡 / 后窗（抬到挤出外扩面上；先铺一圈米白窗框，再压玻璃，做出密封胶条边）/ 侧窗（贴车身侧平面）
    group.add(slopedPanel(T, 8.36, 14.12, 3.44, 20.48, 15.9, 0.24, cream, BODY_BEVEL + 0.09, 0));
    group.add(slopedPanel(T, 8.1, 14.4, 3.7, 20.2, 15.4, 0.3, glass, BODY_BEVEL + 0.18, 0));
    group.add(slopedPanel(T, -16.56, 14.5, -11.34, 20.0, 14.7, 0.24, cream, BODY_BEVEL + 0.08, 0));
    group.add(slopedPanel(T, -16.3, 14.5, -11.6, 20.0, 14.2, 0.3, glass, BODY_BEVEL + 0.16, 0));
    var sideGlass = sideWindows(T, glass);
    group.add(sideGlass[0]);
    group.add(sideGlass[1]);
    box(0.8, 4.4, 0.16, paint, -3.2, 17.3, 10.77);
    box(0.8, 4.4, 0.16, paint, -3.2, 17.3, -10.77);

    // 米白涂装：引擎盖 / 尾箱双条纹；P1 整片米白车顶，P2 车顶留条纹
    var sz = 4.4;
    group.add(slopedPanel(T, 20.0, 10.65, 13.0, 12.0, 2.2, 0.4, cream, BODY_BEVEL + 0.22, sz));
    group.add(slopedPanel(T, 20.0, 10.65, 13.0, 12.0, 2.2, 0.4, cream, BODY_BEVEL + 0.22, -sz));
    group.add(slopedPanel(T, -16.5, 14.55, -20.2, 13.4, 2.2, 0.4, cream, BODY_BEVEL + 0.18, sz));
    group.add(slopedPanel(T, -16.5, 14.55, -20.2, 13.4, 2.2, 0.4, cream, BODY_BEVEL + 0.18, -sz));
    if (num === 1) {
      box(8.8, 0.5, 16.6, cream, -3.6, 22.09, 0);
      group.add(makeRoundel(T, num, 22.36));
    } else {
      box(9.4, 0.55, 2.2, cream, -3.6, 22.26, sz);
      box(9.4, 0.55, 2.2, cream, -3.6, 22.26, -sz);
      group.add(makeRoundel(T, num, 22.06));
    }

    // 车灯 / 格栅 / 保险杠 / 尾灯 / 排气（都顶到外扩后的车头车尾表面）
    for (var li = 0; li < 2; li++) {
      var side = li === 0 ? 1 : -1;
      var ring = new T.Mesh(new T.CylinderGeometry(2.3, 2.3, 1.0, 18), chrome);
      ring.rotation.z = Math.PI / 2;
      ring.position.set(22.95, 8.9, side * 5.7);
      group.add(ring);
      var bulb = new T.Mesh(new T.CylinderGeometry(1.7, 1.7, 1.3, 18), lamp);
      bulb.rotation.z = Math.PI / 2;
      bulb.position.set(23.08, 8.9, side * 5.7);
      group.add(bulb);
      box(0.6, 2.7, 5.4, dark, -22.9, 11.2, side * 5.7);
      box(0.5, 1.7, 4.3, tail, -23.12, 11.2, side * 5.7);
    }
    box(0.7, 2.2, 7.0, dark, 22.9, 7.9, 0);
    box(0.35, 1.5, 6.4, chrome, 23.1, 7.9, 0);
    box(1.0, 1.2, 17, chrome, 23.1, 6.8, 0);
    box(1.0, 1.2, 17, chrome, -23.0, 5.0, 0);
    for (var ei = 0; ei < 2; ei++) {
      var exh = new T.Mesh(new T.CylinderGeometry(0.95, 0.95, 2.0, 12), chrome);
      exh.rotation.z = Math.PI / 2;
      exh.position.set(-23.0, 4.2, ei === 0 ? 3.4 : -3.4);
      group.add(exh);
    }

    // 后视镜：直接长在 A 柱外侧的镜盒
    box(1.5, 1.6, 2.0, cream, 7.6, 15.35, 10.6);
    box(1.5, 1.6, 2.0, cream, 7.6, 15.35, -10.6);

    // 尾翼与车队特征件：翼型截面沿车宽挤出，rotation.z 为迎角
    if (num === 1) {
      var wing = wingMesh(T, 5.2, 20.4, cream);
      wing.position.set(-19.2, 17.2, 0);
      wing.rotation.z = 0.12;
      group.add(wing);
      box(5.6, 2.8, 0.5, paint, -19.2, 17.2, 10.2);
      box(5.6, 2.8, 0.5, paint, -19.2, 17.2, -10.2);
      box(0.9, 2.8, 1.1, dark, -18.4, 15.7, 5.5);
      box(0.9, 2.8, 1.1, dark, -18.4, 15.7, -5.5);
    } else {
      var wing2 = wingMesh(T, 4.4, 17.6, paint);
      wing2.position.set(-19.8, 15.8, 0);
      wing2.rotation.z = 0.1;
      group.add(wing2);
      box(4.8, 2.3, 0.45, cream, -19.8, 15.8, 8.8);
      box(4.8, 2.3, 0.45, cream, -19.8, 15.8, -8.8);
      box(0.8, 1.6, 1.0, dark, -18.6, 14.9, 4.8);
      box(0.8, 1.6, 1.0, dark, -18.6, 14.9, -4.8);
      box(6.4, 1.1, 11.0, dark, 17.6, 12.25, 0, -0.12);
    }

    // 车轮：轮胎 + 镀铬五辐轮毂；挂进 Group 以便绕轴自转
    var tireGeo = new T.CylinderGeometry(WHEEL_R, WHEEL_R, WHEEL_LEN, WHEEL_SEG);
    var rimGeo = new T.CylinderGeometry(WHEEL_R * 0.66, WHEEL_R * 0.66, WHEEL_LEN + 0.7, WHEEL_SEG);
    var capGeo = new T.CylinderGeometry(WHEEL_R * 0.24, WHEEL_R * 0.24, WHEEL_LEN + 1.1, 14);
    var slotGeo = new T.BoxGeometry(0.55, 0.16, 3.4);
    var signs = [1, -1];
    for (var xi = 0; xi < signs.length; xi++) {
      for (var zi = 0; zi < signs.length; zi++) {
        var wg = new T.Group();
        wg.rotation.x = Math.PI / 2;
        var t = new T.Mesh(tireGeo, tire);
        t.castShadow = true;
        wg.add(t);
        wg.add(new T.Mesh(rimGeo, chrome));
        wg.add(new T.Mesh(capGeo, chrome));
        var faceY = (zi === 0 ? 1 : -1) * 3.52;
        for (var sp = 0; sp < 5; sp++) {
          var ang = sp * Math.PI * 2 / 5;
          var slot = new T.Mesh(slotGeo, dark);
          slot.position.set(Math.sin(ang) * 2.5, faceY, Math.cos(ang) * 2.5);
          slot.rotation.y = ang;
          wg.add(slot);
        }
        wg.position.set(signs[xi] * WHEEL_X, WHEEL_Y, signs[zi] * WHEEL_Z);
        group.add(wg);
        wheels.push(wg);
      }
    }
    group.userData.wheels = wheels;

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
    // 车头是 +X，rotation.z 正角抬头；slopeAt 上坡为正，故取 +atan(slope)
    var pitch = 0;
    if (typeof track.slopeAt === 'function') {
      var slope = Number(track.slopeAt(car.s));
      if (isFinite(slope)) pitch = Math.atan(slope);
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

    // ---- 灰尘尾迹（3D）：每车一小池地面圆片，巡航淡拖尾 / 打滑浓尘 / 落地尘爆 ----
    var DUST_N = 24;
    var DUST_TAN = 0xE0D2B4;
    var FLY_GUARD = 1.7;
    var dustGeo = new T.CircleGeometry(1, 10);
    var dustPool = [];          // { mesh, age, life, vx, vz, size, peak }
    var dustClock = [0, 0];
    var dustPrevFly = [0, 0];
    var dustLastT = null;
    (function buildDust() {
      for (var i = 0; i < DUST_N * 2; i++) {
        var mat = new T.MeshBasicMaterial({
          color: DUST_TAN, transparent: true, opacity: 0, depthWrite: false
        });
        var m = new T.Mesh(dustGeo, mat);
        m.rotation.x = -Math.PI / 2;
        m.visible = false;
        gl.scene.add(m);
        dustPool.push({ mesh: m, age: 0, life: 1, vx: 0, vz: 0, size: 1 });
      }
    })();

    // 找一个空槽（已消亡优先，否则最老的一粒）
    function dustSlot() {
      var best = 0, bestAge = -1;
      for (var i = 0; i < dustPool.length; i++) {
        var d = dustPool[i];
        if (d.age >= d.life) return i;
        if (d.age > bestAge) { bestAge = d.age; best = i; }
      }
      return best;
    }

    function dustSpawn(car, tk, mode) {
      var d = dustPool[dustSlot()];
      var back = tk.pointAt(Math.max(0, (Number(car.s) || 0) - 16), car.lane === -1 ? -1 : 1);
      var tan = tangentAt(tk, car.s, back);
      var elev = (typeof tk.elevationAt === 'function') ? Number(tk.elevationAt(car.s)) : 0;
      if (!isFinite(elev)) elev = 0;
      var spread = mode === 'burst' ? 16 : 6;
      var speedBoost = mode === 'slip' ? 1.35 : 1;
      // 路面在 y = 1 + elev（gl.js SURFACE_Y）：尘片必须略高于路面，否则会被深度测试埋掉
      d.mesh.position.set(
        back.x - tan.tx * 6 + (Math.random() - 0.5) * spread,
        elev + 1.2,
        back.y - tan.ty * 6 + (Math.random() - 0.5) * spread
      );
      d.vx = -tan.tx * 24 * speedBoost + (Math.random() - 0.5) * 26;
      d.vz = -tan.ty * 24 * speedBoost + (Math.random() - 0.5) * 26;
      d.size = mode === 'slip' ? 8 + Math.random() * 3.5 : (mode === 'burst' ? 10 + Math.random() * 4 : 6 + Math.random() * 2.5);
      d.peak = mode === 'slip' ? 0.5 : (mode === 'burst' ? 0.5 : 0.34);
      d.age = 0;
      d.life = mode === 'cruise' ? 1.1 + Math.random() * 0.4 : 0.6 + Math.random() * 0.3;
      d.mesh.visible = true;
    }

    function dustUpdate(entries, tk, dt) {
      var i, d;
      if (entries && tk && typeof tk.pointAt === 'function') {
        for (i = 0; i < 2 && i < entries.length; i++) {
          dustClock[i] -= dt;
          var car = entries[i] && entries[i].car;
          if (!car) continue;
          // 落地沿：derailT 越过 FLY_GUARD 炸一圈尘
          if (car.derailed && dustPrevFly[i] <= FLY_GUARD && Number(car.derailT) > FLY_GUARD) {
            for (var b = 0; b < 8; b++) dustSpawn(car, tk, 'burst');
          }
          dustPrevFly[i] = Number(car.derailT) || 0;
          if (car.derailed || dustClock[i] > 0) continue;
          var speed = Number(car.speed) || 0;
          if ((Number(car.slip) || 0) > 0.3) { dustSpawn(car, tk, 'slip'); dustClock[i] = 0.055; }
          else if ((Number(car.throttle) || 0) > 0.85 && speed < 150) { dustSpawn(car, tk, 'slip'); dustClock[i] = 0.055; }
          else if (speed > 40) { dustSpawn(car, tk, 'cruise'); dustClock[i] = 0.07; }
        }
      }
      // 推进
      for (i = 0; i < dustPool.length; i++) {
        d = dustPool[i];
        if (d.age >= d.life) { d.mesh.visible = false; continue; }
        d.age += dt;
        if (d.age >= d.life) { d.mesh.visible = false; continue; }
        var k = d.age / d.life;
        d.mesh.position.x += d.vx * dt;
        d.mesh.position.z += d.vz * dt;
        var sc = d.size * (0.55 + k * 1.5);
        d.mesh.scale.set(sc, sc, 1);
        d.mesh.material.opacity = d.peak * (1 - k);
      }
    }

    var orig = gl.render;
    gl.render = function (race, time) {
      var t = Number(time);
      if (!isFinite(t)) t = 0;
      var dt = (dustLastT === null) ? 0 : Math.min(0.05, Math.max(0, t - dustLastT));
      dustLastT = t;
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
      try { dustUpdate(entries, tk, dt); } catch (err2) { /* 尾迹失败不影响整帧 */ }
      if (typeof orig === 'function') return orig.apply(gl, arguments);
      return undefined;
    };

    return gl;
  }

  root.RaceGLCars = { attach: attach };
})(window);
