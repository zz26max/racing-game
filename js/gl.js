/* 三维房间底景：相机 / 灯光 / 木地板 / 地毯 + 赛道路面与槽线（浏览器全局 window.RaceGL，普通脚本） */
(function (root) {
  'use strict';
  var api = {};

  // 房间中心与世界尺度（逻辑空间 1280×720 位于房间中央）
  var CENTER_X = 670;
  var CENTER_Z = 420;
  var FLOOR_W = 4200;
  var FLOOR_D = 3200;
  var FLOOR_REPEAT_X = 6;
  var FLOOR_REPEAT_Y = 5;
  var CARPET_W = 1100;
  var CARPET_D = 620;
  var CARPET_Y = 0.6;

  // 木地板贴图：底色 + 64px 一行板缝 + 隔行错缝的端缝 + 少量噪点
  var WOOD_TEX = 1024;
  var WOOD_PLANK = 64;      // 每行板缝间距
  var WOOD_SEAM = 3;        // 板缝宽度
  var WOOD_PLANK_LEN = 256; // 端缝间距（板长）
  var WOOD_STAGGER = 128;   // 相邻行的端缝错位
  var WOOD_BASE = '#C98B55';
  var WOOD_SEAM_COL = '#8a5b33';

  // 地毯贴图：底色 + 内缩边框 + 噪点
  var RUG_W = 1024;
  var RUG_H = 576;
  var RUG_BASE = '#7A3E3A';
  var RUG_BORDER_COL = '#E9DCC4';
  var RUG_INSET = 16;       // 边框内缩
  var RUG_BORDER_W = 4;     // 边框线宽

  // 固定的伪随机：同一 seed 每次贴图一致
  function makeRandom(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
      t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function createCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  // 撒 1px 深浅噪点
  function sprinkle(ctx, w, h, count, seed) {
    var rnd = makeRandom(seed);
    var i, x, y;
    for (i = 0; i < count; i++) {
      x = Math.floor(rnd() * w);
      y = Math.floor(rnd() * h);
      ctx.fillStyle = rnd() < 0.5 ? 'rgba(255,238,214,0.10)' : 'rgba(92,52,24,0.10)';
      ctx.fillRect(x, y, 1, 1);
    }
  }

  // 木地板贴图：横向 64px 板缝 + 隔行错开的端缝
  function makeWoodTexture() {
    var canvas = createCanvas(WOOD_TEX, WOOD_TEX);
    var ctx = canvas.getContext('2d');
    var row, col, x, y;

    ctx.fillStyle = WOOD_BASE;
    ctx.fillRect(0, 0, WOOD_TEX, WOOD_TEX);

    // 横缝
    ctx.fillStyle = WOOD_SEAM_COL;
    for (y = 0; y < WOOD_TEX; y += WOOD_PLANK) {
      ctx.fillRect(0, y, WOOD_TEX, WOOD_SEAM);
    }

    // 端缝：每行 256px 一条，奇偶行错开 128px
    for (row = 0, y = 0; y < WOOD_TEX; row++, y += WOOD_PLANK) {
      var offset = (row % 2) * WOOD_STAGGER;
      for (col = 0; col * WOOD_PLANK_LEN < WOOD_TEX + WOOD_PLANK_LEN; col++) {
        x = offset + col * WOOD_PLANK_LEN;
        if (x >= WOOD_TEX) continue;
        ctx.fillRect(x, y, WOOD_SEAM, WOOD_PLANK);
      }
    }

    sprinkle(ctx, WOOD_TEX, WOOD_TEX, 3200, 7);

    var tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(FLOOR_REPEAT_X, FLOOR_REPEAT_Y);
    tex.anisotropy = 4;
    if (THREE.LinearEncoding !== undefined) tex.encoding = THREE.LinearEncoding;
    return tex;
  }

  // 地毯贴图：底色 + 内缩 16px 的浅色细边框 + 噪点
  function makeCarpetTexture() {
    var canvas = createCanvas(RUG_W, RUG_H);
    var ctx = canvas.getContext('2d');

    ctx.fillStyle = RUG_BASE;
    ctx.fillRect(0, 0, RUG_W, RUG_H);

    ctx.strokeStyle = RUG_BORDER_COL;
    ctx.lineWidth = RUG_BORDER_W;
    ctx.strokeRect(
      RUG_INSET, RUG_INSET,
      RUG_W - RUG_INSET * 2, RUG_H - RUG_INSET * 2
    );

    sprinkle(ctx, RUG_W, RUG_H, 2400, 11);

    var tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = 4;
    if (THREE.LinearEncoding !== undefined) tex.encoding = THREE.LinearEncoding;
    return tex;
  }

  // 赛道：世界映射 X = track.x、Z = track.y、Y 向上；路面在 y = SURFACE_Y，槽线略高
  var SURFACE_Y = 1;
  var SLOT_Y = 1.02;
  var SLOT_HALF_W = 1.5;  // 槽线带宽 3px
  var SLOT_STEP = 4;      // 槽线沿弧长每 4px 采样

  // 路肩：弯道外侧红白条带，带宽 14（半宽 7），中心距路面边缘 5，每 14px 换色
  var KERB_Y = 1.03;
  var KERB_STEP = 4;
  var KERB_HALF_W = 7;
  var KERB_EDGE_GAP = 5;
  var KERB_BAND = 14;
  var KERB_COLOR_A = 0xe0455a;  // 红
  var KERB_COLOR_B = 0xf7f2e6;  // 米白

  // 护栏：两侧各偏离路面边缘 3，高 7、厚 3（矮护栏：高速脱轨可越过，低速被挡）
  var WALL_Y0 = 0;
  var WALL_H = 7;
  var WALL_THICK = 3;
  var WALL_GAP = 3;
  var WALL_STEP = 4;

  // 立体交叉装饰：桥面两侧黄色护栏（含引桥段）+ 桥墩 + 桥下投影
  var RAIL_COLOR = 0xf2b544;
  var RAIL_S0 = -70;      // 桥面弧长范围（与 track.elevationAt 的平段一致）
  var RAIL_S1 = 70;
  var RAIL_STEP = 5;      // 每 5px 一根
  var RAIL_GAP = 2;       // 护栏离路面边缘的横向间隙
  var RAIL_H = 16;        // 桥面黄护栏高度：独立于普通护栏 WALL_H，保持 16 不变
  var RAIL_DEPTH_PAD = 1; // 立方体沿走向略加长，弯道上相邻块不留缝

  var PIER_COLOR = 0x8c96a3;
  var PIER_S0 = -180;     // 桥墩弧长范围（覆盖落坡段）
  var PIER_S1 = 180;
  var PIER_STEP = 60;
  var PIER_RADIUS = 4;
  var PIER_SEGMENTS = 10;

  var BRIDGE_SHADOW_W = 200;
  var BRIDGE_SHADOW_D = 140;
  var BRIDGE_SHADOW_Y = 0.75;
  var BRIDGE_SHADOW_OPACITY = 0.28;

  // 起跑线：84×24 平面 + 2 列 × 3 行、每格 12px 的黑白格贴图
  var STARTLINE_Y = 1.04;
  var STARTLINE_W = 84;
  var STARTLINE_D = 24;
  var CHECK_CELL = 12;
  var CHECK_COLS = 2;
  var CHECK_ROWS = 3;
  var CHECK_DARK = '#14161c';
  var CHECK_LIGHT = '#f4f1e8';

  // 当前 create() 的场景：路面 / 槽线构建函数按签名只收 track，场景从这里取
  var activeScene = null;

  // 赛道高度：track 提供 elevationAt(s) 时按弧长取值，未提供则视为平地（0）
  function elev(track, s) {
    return (typeof track.elevationAt === 'function') ? track.elevationAt(s) : 0;
  }

  // 由中心线采样生成闭合三角带：左右顶点 = 中心 ± halfW × 法向 (-ty, tx)，高度 y
  // samples[i] = { x, y, tx, ty }，x/y 为赛道坐标、tx/ty 为单位切线
  // y 可传数值（整条带等高）或 function(i, p)：同一采样的左右两顶点用同一高度
  function makeRibbonGeometry(samples, halfW, y) {
    var count = samples.length;
    var positions = [];
    var indices = [];
    var i, p, nx, nz, a, b, c, d, yv;
    var height = (typeof y === 'function') ? y : null;

    for (i = 0; i < count; i++) {
      p = samples[i];
      nx = -p.ty;
      nz = p.tx;
      yv = height ? height(i, p) : y;
      // 左顶点
      positions.push(p.x + nx * halfW, yv, p.y + nz * halfW);
      // 右顶点
      positions.push(p.x - nx * halfW, yv, p.y - nz * halfW);
    }

    // 每段两个三角形；末段回接首点，闭合成环
    for (i = 0; i < count; i++) {
      a = i * 2;
      b = a + 1;
      c = ((i + 1) % count) * 2;
      d = c + 1;
      indices.push(a, c, b);
      indices.push(b, c, d);
    }

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }

  // 路面：沿 track.points 取相邻点差为单位切线，向两侧各铺 width/2，得到闭合三角带
  function buildSurface(track) {
    var pts = track ? track.points : null;
    if (!pts || pts.length < 3) return null;

    var n = pts.length;
    var halfW = (Number(track.width) || 0) / 2;
    var samples = [];
    var i, prev, next, tx, ty, len;

    // 每个顶点的弧长：相邻点距离沿点序累加（闭合环不重复首点，末点不绕回 0）
    var cum = new Array(n);
    cum[0] = 0;
    for (i = 1; i < n; i++) {
      var dx = pts[i].x - pts[i - 1].x;
      var dy = pts[i].y - pts[i - 1].y;
      cum[i] = cum[i - 1] + Math.sqrt(dx * dx + dy * dy);
    }

    for (i = 0; i < n; i++) {
      prev = pts[(i + n - 1) % n];
      next = pts[(i + 1) % n];
      tx = next.x - prev.x;
      ty = next.y - prev.y;
      len = Math.sqrt(tx * tx + ty * ty);
      if (len > 0) { tx = tx / len; ty = ty / len; } else { tx = 1; ty = 0; }
      samples.push({ x: pts[i].x, y: pts[i].y, tx: tx, ty: ty, s: cum[i] });
    }

    var mesh = new THREE.Mesh(
      makeRibbonGeometry(samples, halfW, function (i, p) { return SURFACE_Y + elev(track, p.s); }),
      new THREE.MeshStandardMaterial({ color: 0x3f444f, roughness: 0.95, metalness: 0 })
    );
    mesh.receiveShadow = true;
    if (activeScene) activeScene.add(mesh);
    return mesh;
  }

  // 槽线：沿弧长每 4px 在两侧车道中心（pointAt(s, ±1)）各生成一条 3px 宽的带
  function buildSlots(track) {
    if (!track || typeof track.pointAt !== 'function' || typeof track.sampleAt !== 'function') return null;
    var total = Number(track.totalLength) || 0;
    if (!(total > 0)) return null;

    var lanes = [1, -1];
    var meshes = [];
    // 槽线只比路面高 0.02，深度精度不足会与路面 z-fighting，用 polygonOffset 压到路面前面
    var material = new THREE.MeshStandardMaterial({
      color: 0x22262e,
      roughness: 0.85,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4
    });

    for (var li = 0; li < lanes.length; li++) {
      var samples = [];
      for (var s = 0; s < total; s += SLOT_STEP) {
        var center = track.pointAt(s, lanes[li]);
        var t = track.sampleAt(s);
        samples.push({ x: center.x, y: center.y, tx: t.tx, ty: t.ty, s: s });
      }
      if (samples.length < 3) continue;

      var mesh = new THREE.Mesh(
        makeRibbonGeometry(samples, SLOT_HALF_W, function (i, p) { return SLOT_Y + elev(track, p.s); }),
        material
      );
      mesh.receiveShadow = true;
      if (activeScene) activeScene.add(mesh);
      meshes.push(mesh);
    }
    return meshes;
  }

  // 沿弧长 [s0, s1] 均匀取 count 个中心点与单位切线，附上弧长 s
  function samplesAlong(track, s0, s1, step) {
    var span = s1 - s0;
    var count = Math.max(2, Math.ceil(Math.abs(span) / step) + 1);
    var list = [];
    for (var i = 0; i < count; i++) {
      var s = s0 + span * i / (count - 1);
      var p = track.sampleAt(s);
      list.push({ x: p.x, y: p.y, tx: p.tx, ty: p.ty, s: s });
    }
    return list;
  }

  // 沿整圈每 step 取一个中心点（闭合环用，不重复首点）
  function samplesLoop(track, step) {
    var total = Number(track.totalLength) || 0;
    var list = [];
    for (var s = 0; s < total; s += step) {
      var p = track.sampleAt(s);
      list.push({ x: p.x, y: p.y, tx: p.tx, ty: p.ty, s: s });
    }
    return list;
  }

  // 沿 samples 铺一条四边形带：a 边（法向偏移 offA、高 yA）接 b 边（偏移 offB、高 yB）
  // closed=true 时末段回接首点；flip 反转绕序，用于按所在侧修正朝向
  // yA / yB 可传数值（整条边等高）或 function(p)：按每个采样自己的弧长取高度
  function pushQuadStrip(positions, indices, samples, offA, yA, offB, yB, closed, flip) {
    var count = samples.length;
    var start = positions.length / 3;
    var i, p, nx, nz, a0, b0, a1, b1, ya, yb;
    var fnA = (typeof yA === 'function') ? yA : null;
    var fnB = (typeof yB === 'function') ? yB : null;

    for (i = 0; i < count; i++) {
      p = samples[i];
      nx = -p.ty;
      nz = p.tx;
      ya = fnA ? fnA(p, i) : yA;
      yb = fnB ? fnB(p, i) : yB;
      positions.push(p.x + nx * offA, ya, p.y + nz * offA);
      positions.push(p.x + nx * offB, yb, p.y + nz * offB);
    }

    var segs = closed ? count : count - 1;
    for (i = 0; i < segs; i++) {
      a0 = start + i * 2;
      b0 = a0 + 1;
      a1 = start + ((i + 1) % count) * 2;
      b1 = a1 + 1;
      if (flip) {
        indices.push(a0, b1, a1);
        indices.push(a0, b0, b1);
      } else {
        indices.push(a0, a1, b1);
        indices.push(a0, b1, b0);
      }
    }
  }

  // 路肩：对 track.corners 的每个 { s0, s1, side }，沿弧长每 4px 在弯道外侧铺 14px 宽条带，
  // 每 14px 红 / 米白交替；顶点色写入同一几何后合并成一个 MeshStandardMaterial
  function buildKerbs(track) {
    if (!track || typeof track.sampleAt !== 'function') return null;
    var corners = track.corners || [];
    if (!corners.length) return null;
    var total = Number(track.totalLength) || 0;
    if (!(total > 0)) return null;

    var halfW = (Number(track.width) || 0) / 2;
    var colorA = new THREE.Color(KERB_COLOR_A);
    var colorB = new THREE.Color(KERB_COLOR_B);
    var positions = [];
    var colors = [];
    var indices = [];
    var ci, c, side, off, list, i, p, nx, nz, band, col;

    for (ci = 0; ci < corners.length; ci++) {
      c = corners[ci];
      side = c.side >= 0 ? 1 : -1;
      // 法向 n=(-ty,tx) 与 side 同号时指向弯心，外侧取其反号；中心落在 width/2 + 5（带宽 2 × 7，内侧压住路面 2px）
      off = -side * (halfW + KERB_EDGE_GAP);
      list = samplesAlong(track, c.s0, c.s1, KERB_STEP);
      if (list.length < 2) continue;

      var start = positions.length / 3;
      for (i = 0; i < list.length; i++) {
        p = list[i];
        nx = -p.ty;
        nz = p.tx;
        // 外沿 / 内沿各一个顶点，条带带宽 2 × KERB_HALF_W；高度随该采样的弧长抬升
        var ky = KERB_Y + elev(track, p.s);
        positions.push(p.x + nx * (off + KERB_HALF_W), ky, p.y + nz * (off + KERB_HALF_W));
        positions.push(p.x + nx * (off - KERB_HALF_W), ky, p.y + nz * (off - KERB_HALF_W));
        band = Math.floor((p.s - c.s0) / KERB_BAND);
        col = band % 2 === 0 ? colorA : colorB;
        colors.push(col.r, col.g, col.b);
        colors.push(col.r, col.g, col.b);
      }

      for (i = 0; i + 1 < list.length; i++) {
        var a0 = start + i * 2;
        var b0 = a0 + 1;
        var a1 = a0 + 2;
        var b1 = a0 + 3;
        indices.push(a0, a1, b1);
        indices.push(a0, b1, b0);
      }
    }

    if (!indices.length) return null;

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    var mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.9,
      metalness: 0
    }));
    mesh.receiveShadow = true;
    if (activeScene) activeScene.add(mesh);
    return mesh;
  }

  // 护栏：沿赛道两侧各偏移 width/2 + 3，竖直墙高 7、厚 3，
  // 每条墙由内侧立面（朝路面）、顶面、外侧立面三条四边形带拼成
  function buildWalls(track) {
    if (!track || typeof track.sampleAt !== 'function') return null;
    var total = Number(track.totalLength) || 0;
    if (!(total > 0)) return null;

    var halfW = (Number(track.width) || 0) / 2;
    var inner = halfW + WALL_GAP;
    var outer = inner + WALL_THICK;
    var list = samplesLoop(track, WALL_STEP);
    if (list.length < 3) return null;

    var material = new THREE.MeshStandardMaterial({ color: 0x7f8896, roughness: 0.6, metalness: 0 });
    var sides = [1, -1];
    var meshes = [];
    var si, side, positions, indices, geo, mesh;

    // 墙底贴地、墙顶保持 WALL_H 高：底边随该采样的赛道高度抬升
    function wallBottom(p) { return WALL_Y0 + elev(track, p.s); }
    function wallTop(p) { return wallBottom(p) + WALL_H; }

    for (si = 0; si < sides.length; si++) {
      side = sides[si];
      positions = [];
      indices = [];

      pushQuadStrip(positions, indices, list, side * inner, wallBottom, side * inner, wallTop, true, side > 0);
      pushQuadStrip(positions, indices, list, side * inner, wallTop, side * outer, wallTop, true, side > 0);
      pushQuadStrip(positions, indices, list, side * outer, wallBottom, side * outer, wallTop, true, side < 0);

      geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setIndex(indices);
      geo.computeVertexNormals();

      mesh = new THREE.Mesh(geo, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (activeScene) activeScene.add(mesh);
      meshes.push(mesh);
    }
    return meshes;
  }

  // 立体交叉装饰：桥面两侧黄色护栏（s ∈ [-70,70] 每 5px 一根立方体，沿赛道走向）、
  // 桥墩（s ∈ [-180,180] 每 60px 左右各一根，从地面顶到该处赛道高度）、桥下地面投影
  function buildBridge(track) {
    if (!track || typeof track.sampleAt !== 'function') return null;
    var halfW = (Number(track.width) || 0) / 2;
    var railOff = halfW + RAIL_GAP;
    var group = new THREE.Group();
    var sides = [1, -1];
    var si, s, p, off, mesh, h;

    var railGeo = new THREE.BoxGeometry(WALL_THICK, RAIL_H, RAIL_STEP + RAIL_DEPTH_PAD);
    var railMat = new THREE.MeshStandardMaterial({ color: RAIL_COLOR, roughness: 0.55, metalness: 0 });
    var pierMat = new THREE.MeshStandardMaterial({ color: PIER_COLOR, roughness: 0.8, metalness: 0 });

    // 护栏：贴着桥面两侧，底面随该处赛道高度抬升，Y 轴转到赛道走向
    for (si = 0; si < sides.length; si++) {
      for (s = RAIL_S0; s <= RAIL_S1; s += RAIL_STEP) {
        p = track.sampleAt(s);
        off = railOff * sides[si];
        mesh = new THREE.Mesh(railGeo, railMat);
        mesh.position.set(
          p.x - p.ty * off,
          SURFACE_Y + elev(track, s) + RAIL_H / 2,
          p.y + p.tx * off
        );
        // 立方体长边为局部 Z：rotation.y = atan2(tx, ty) 后局部 +Z 指向 (tx, ty)
        mesh.rotation.y = Math.atan2(p.tx, p.ty);
        mesh.castShadow = true;
        group.add(mesh);
      }
    }

    // 桥墩：站在地面（y=0）上，高 = 该处赛道高度，落在路面边缘正下方
    for (si = 0; si < sides.length; si++) {
      for (s = PIER_S0; s <= PIER_S1; s += PIER_STEP) {
        h = elev(track, s);
        if (!(h > 0)) continue;   // 平地处不立墩
        p = track.sampleAt(s);
        off = halfW * sides[si];
        mesh = new THREE.Mesh(new THREE.CylinderGeometry(PIER_RADIUS, PIER_RADIUS, h, PIER_SEGMENTS), pierMat);
        mesh.position.set(p.x - p.ty * off, h / 2, p.y + p.tx * off);
        mesh.castShadow = true;
        group.add(mesh);
      }
    }

    // 桥下投影：一块固定尺寸的半透明黑面，压住桥体正下方的地面
    var shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(BRIDGE_SHADOW_W, BRIDGE_SHADOW_D),
      new THREE.MeshBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: BRIDGE_SHADOW_OPACITY,
        depthWrite: false
      })
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set(0, BRIDGE_SHADOW_Y, 0);
    shadow.receiveShadow = true;
    group.add(shadow);

    if (activeScene) activeScene.add(group);
    return group;
  }

  // 起跑线贴图：2 列 × 3 行、每格 12px 的黑白格
  function makeStartTexture() {
    var w = CHECK_CELL * CHECK_COLS;
    var h = CHECK_CELL * CHECK_ROWS;
    var canvas = createCanvas(w, h);
    var ctx = canvas.getContext('2d');
    var row, col;

    for (row = 0; row < CHECK_ROWS; row++) {
      for (col = 0; col < CHECK_COLS; col++) {
        ctx.fillStyle = (row + col) % 2 === 0 ? CHECK_DARK : CHECK_LIGHT;
        ctx.fillRect(col * CHECK_CELL, row * CHECK_CELL, CHECK_CELL, CHECK_CELL);
      }
    }

    var tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.anisotropy = 4;
    if (THREE.LinearEncoding !== undefined) tex.encoding = THREE.LinearEncoding;
    return tex;
  }

  // 起跑线：track.startLine 处 84×24 的黑白格平面，绕 Y 转到与赛道垂直
  function buildStart(track) {
    var start = track ? track.startLine : null;
    if (!start) return null;

    var mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(STARTLINE_W, STARTLINE_D),
      new THREE.MeshStandardMaterial({ map: makeStartTexture(), roughness: 0.85, metalness: 0 })
    );
    // 先绕 X 摊平到地面，再绕 Y 转到法向 (-ty, tx)；start.angle 即该法向的方向角
    mesh.rotation.set(-Math.PI / 2, 0, -(Number(start.angle) || 0));
    // 整块平面按起点弧长处的高度平移（起点在平地，实际等于 STARTLINE_Y）
    mesh.position.set(Number(start.x) || 0, STARTLINE_Y + elev(track, track.startS), Number(start.y) || 0);
    mesh.receiveShadow = true;
    if (activeScene) activeScene.add(mesh);
    return mesh;
  }

  // 固定机位：脱轨时不再后拉，始终用 BASE
  var CAM_BASE_X = 0, CAM_BASE_Y = 620, CAM_BASE_Z = 900;

  // 创建房间：canvas 为页面里的 <canvas>，track 为赛道（有则铺路面与槽线）
  api.create = function (canvas, track) {
    var scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1b1714);

    var camera = new THREE.PerspectiveCamera(42, 16 / 9, 1, 6000);
    camera.position.set(0, 620, 900);
    camera.lookAt(0, 0, 0);

    var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    if (THREE.LinearEncoding !== undefined) renderer.outputEncoding = THREE.LinearEncoding;

    // 灯光：半球光压暗底色，平行光做主光并投影
    var hemi = new THREE.HemisphereLight(0xfff1d6, 0x5a4a3c, 0.55);
    scene.add(hemi);

    var dir = new THREE.DirectionalLight(0xfff0d8, 0.95);
    dir.position.set(-300, 900, -200);
    dir.target.position.set(CENTER_X, 0, CENTER_Z);
    scene.add(dir.target);
    dir.castShadow = true;
    dir.shadow.camera.left = -900;
    dir.shadow.camera.right = 900;
    dir.shadow.camera.top = 900;
    dir.shadow.camera.bottom = -900;
    dir.shadow.camera.near = 100;
    dir.shadow.camera.far = 3200;
    dir.shadow.camera.updateProjectionMatrix();
    dir.shadow.mapSize.set(2048, 2048);
    dir.shadow.bias = -0.0005;
    scene.add(dir);

    // 木地板
    var floor = new THREE.Mesh(
      new THREE.PlaneGeometry(FLOOR_W, FLOOR_D),
      new THREE.MeshStandardMaterial({ map: makeWoodTexture(), roughness: 0.9, metalness: 0 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(CENTER_X, 0, CENTER_Z);
    floor.receiveShadow = true;
    scene.add(floor);

    // 地毯
    var carpet = new THREE.Mesh(
      new THREE.PlaneGeometry(CARPET_W, CARPET_D),
      new THREE.MeshStandardMaterial({ map: makeCarpetTexture(), roughness: 0.95, metalness: 0 })
    );
    carpet.rotation.x = -Math.PI / 2;
    carpet.position.set(0, CARPET_Y, 0);
    carpet.receiveShadow = true;
    scene.add(carpet);

    // 赛道：路面 + 两侧槽线 + 弯道路肩 + 护栏 + 起跑线
    activeScene = scene;
    if (track) {
      buildSurface(track);
      buildSlots(track);
      buildKerbs(track);
      buildWalls(track);
      buildBridge(track);
      buildStart(track);
    }

    // 画布尺寸随 CSS 盒变化
    function resize() {
      var w = canvas.clientWidth || canvas.width || 1280;
      var h = canvas.clientHeight || canvas.height || 720;
      if (!(w > 0 && h > 0)) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }

    resize();
    window.addEventListener('resize', resize);

    // 相机：固定 BASE 机位，脱轨也不再后拉（camK 恒为 0）
    function render(race, time) {
      camera.position.set(CAM_BASE_X, CAM_BASE_Y, CAM_BASE_Z);
      camera.lookAt(0, 0, 0);

      renderer.render(scene, camera);
    }

    return {
      scene: scene,
      camera: camera,
      renderer: renderer,
      render: render,
      resize: resize
    };
  };

  root.RaceGL = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
