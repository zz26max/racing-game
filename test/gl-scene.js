/* 3D 场景构建冒烟测试的 harness（被 test/race.test.js 与本目录的 CLI 壳共用）
 *
 * 为什么需要它：gl.js 在 'use strict' 下执行，任何拼错/漏声明的变量都会让
 * RaceGL.create 抛错，而 main.js 会静默回落到 2D 路径——画面看起来"还在跑"，
 * 实际上整条赛道/桥/车都没有 3D。曾因桥墩循环里一个未声明的 `off` 把整局打回 2D。
 *
 * 用法：
 *   const { buildScene } = require('./gl-scene');
 *   buildScene('attic');   // 抛错即失败
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

// ---- 最小 THREE 桩：只做参数记录，不做真实渲染 ----
function makeThreeStub() {
  const calls = [];
  function rec(name) { calls.push(name); }

  class Vector3 {
    constructor(x, y, z) { this.x = x || 0; this.y = y || 0; this.z = z || 0; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  }
  class Object3D {
    constructor() {
      this.position = new Vector3();
      this.rotation = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } };
      this.scale = new Vector3(1, 1, 1);
      this.children = [];
      this.userData = {};
      this.castShadow = false;
      this.receiveShadow = false;
      this.material = null;
      this.geometry = null;
    }
    add() {
      for (var i = 0; i < arguments.length; i++) this.children.push(arguments[i]);
      return this;
    }
    remove(o) {
      var i = this.children.indexOf(o);
      if (i >= 0) this.children.splice(i, 1);
      return this;
    }
    traverse(fn) {
      fn(this);
      for (var i = 0; i < this.children.length; i++) {
        var c = this.children[i];
        if (c && typeof c.traverse === 'function') c.traverse(fn);
      }
    }
    getWorldPosition(v) { if (v) v.set(this.position.x, this.position.y, this.position.z); return v; }
  }
  class Group extends Object3D { constructor() { super(); rec('Group'); } }
  class Scene extends Object3D { constructor() { super(); rec('Scene'); this.background = null; } }
  class Mesh extends Object3D {
    constructor(geo, mat) { super(); rec('Mesh'); this.geometry = geo; this.material = mat; }
  }
  class BufferGeometry {
    constructor() { rec('BufferGeometry'); this.attributes = {}; this.index = null; }
    setAttribute(name, attr) {
      if (!attr || !attr.array || !attr.itemSize) throw new Error('setAttribute: 属性对象不合法 (' + name + ')');
      this.attributes[name] = attr;
      if (attr.array.length % attr.itemSize !== 0) {
        throw new Error('setAttribute(' + name + '): 数组长度 ' + attr.array.length + ' 不是 itemSize ' + attr.itemSize + ' 的整数倍');
      }
      return this;
    }
    setIndex(idx) {
      var arr = Array.isArray(idx) ? idx : (idx && idx.array);
      if (!arr) throw new Error('setIndex: 索引不是数组');
      for (var i = 0; i < arr.length; i++) {
        if (!(arr[i] >= 0)) throw new Error('setIndex: 索引值非法 ' + arr[i]);
      }
      this.index = arr;
      return this;
    }
    computeVertexNormals() { return this; }
    dispose() { rec('dispose'); }
  }
  class Float32BufferAttribute {
    constructor(array, itemSize) {
      if (!Array.isArray(array)) throw new Error('Float32BufferAttribute: 需要数组');
      this.array = array; this.itemSize = itemSize; this.count = array.length / itemSize;
    }
  }
  class PlaneGeometry { constructor(w, h) { rec('PlaneGeometry'); this.w = w; this.h = h; } }
  class BoxGeometry { constructor(w, h, d) { rec('BoxGeometry'); this.w = w; this.h = h; this.d = d; } }
  class CylinderGeometry { constructor(r1, r2, h, seg) { rec('CylinderGeometry'); this.h = h; } }
  class CircleGeometry { constructor(r, seg) { rec('CircleGeometry'); } }
  class TorusGeometry { constructor(r, tube, rs, ts, arc) { rec('TorusGeometry'); this.r = r; this.tube = tube; } }
  class Shape {
    constructor() {}
    moveTo() {} lineTo() {} quadraticCurveTo() {} bezierCurveTo() {} closePath() {}
  }
  class ExtrudeGeometry {
    constructor(shape, opts) {
      rec('ExtrudeGeometry');
      if (!shape || typeof shape.moveTo !== 'function') throw new Error('ExtrudeGeometry: 需要 Shape');
      if (!opts || !opts.depth) throw new Error('ExtrudeGeometry: 缺 depth');
    }
  }
  class Material {
    constructor(p) { this.disposed = false; Object.assign(this, p || {}); }
    dispose() { this.disposed = true; }
  }
  class WebGLRenderer {
    constructor(o) {
      rec('WebGLRenderer');
      this.domElement = (o && o.canvas) || { width: 0, height: 0 };
      this.shadowMap = { enabled: false, type: null };
    }
    setPixelRatio() { }
    setSize(w, h) { this.domElement.width = w; this.domElement.height = h; }
    render() { rec('render'); }
  }
  class PerspectiveCamera extends Object3D {
    constructor(fov, aspect, near, far) { super(); rec('PerspectiveCamera'); this.fov = fov; this.aspect = aspect; }
    lookAt() { }
    updateProjectionMatrix() { }
  }
  class Light extends Object3D {
    constructor(a, b, c) {
      super();
      this.shadow = {
        camera: { left: 0, right: 0, top: 0, bottom: 0, near: 0, far: 0, updateProjectionMatrix() { } },
        mapSize: { set() { } }, bias: 0
      };
      this.target = new Object3D();
    }
  }

  return {
    calls,
    Scene, Group, Mesh, BufferGeometry, Float32BufferAttribute,
    PlaneGeometry, BoxGeometry, CylinderGeometry, CircleGeometry, TorusGeometry, Shape, ExtrudeGeometry,
    MeshStandardMaterial: Material, MeshBasicMaterial: Material,
    PerspectiveCamera, WebGLRenderer,
    HemisphereLight: Light, DirectionalLight: Light,
    Color: class { constructor(c) { this.c = c; } },
    CanvasTexture: class {
      constructor(c) {
        this.image = c; this.wrapS = null; this.wrapT = null; this.anisotropy = 1;
        this.repeat = { x: 1, y: 1, set(x, y) { this.x = x; this.y = y; } };
      }
    },
    Vector3,
    PCFSoftShadowMap: 2, LinearEncoding: 3000, RepeatWrapping: 1000,
    ClampToEdgeWrapping: 1001, NearestFilter: 1003, DoubleSide: 2
  };
}

// ---- DOM 桩 ----
function makeCanvas(w, h) {
  const ctx = new Proxy({}, {
    get(t, p) {
      if (p === 'canvas') return { width: w, height: h };
      if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => ({ addColorStop() { } });
      if (p === 'getImageData') return () => ({ data: new Uint8Array(4) });
      if (p === 'measureText') return () => ({ width: 10 });
      if (typeof t[p] !== 'undefined') return t[p];
      return () => { };
    },
    set(t, p, v) { t[p] = v; return true; }
  });
  return {
    width: w, height: h, style: {},
    getContext: (kind) => (kind === '2d' ? ctx : null),
    addEventListener() { }, removeEventListener() { },
    getBoundingClientRect() { return { left: 0, top: 0, width: w, height: h }; }
  };
}

function statsOf(root) {
  let meshes = 0, verts = 0, tris = 0;
  (function walk(node) {
    if (!node) return;
    if (node.geometry && node.geometry.attributes) {
      meshes += 1;
      const pos = node.geometry.attributes.position;
      if (pos) verts += pos.count;
      if (node.geometry.index) tris += node.geometry.index.length / 3;
    }
    const kids = node.children || [];
    for (let i = 0; i < kids.length; i++) walk(kids[i]);
  })(root);
  return { meshes, verts, tris };
}

// 在场景树里找车 Group（makeCar 产出的组：含 wheels userData 且子件最多）
function findCarGroup(sceneRoot) {
  let best = null, bestN = 0;
  (function walk(node) {
    if (!node) return;
    if (node.userData && node.userData.wheels && node.children.length > bestN) {
      best = node; bestN = node.children.length;
    }
    const kids = node.children || [];
    for (let i = 0; i < kids.length; i++) walk(kids[i]);
  })(sceneRoot);
  return best;
}

function run(trackId) {
  const THREE = makeThreeStub();
  const sandbox = {
    THREE,
    console,
    Math, Date, JSON, isFinite, isNaN, parseFloat, parseInt, Number, String, Array, Object, Float32Array, Uint16Array, Uint32Array, Int32Array,
    document: {
      createElement: (tag) => makeCanvas(64, 64),
      getElementById: () => makeCanvas(1280, 720),
      addEventListener() { }, removeEventListener() { }
    },
    devicePixelRatio: 1,
    addEventListener() { }, removeEventListener() { }
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const load = (rel) => {
    const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    vm.runInContext(code, sandbox, { filename: rel });
  };
  load('js/util.js');
  load('js/track.js');
  load('js/gl.js');
  // gl-cars 一并冒烟：makeCar 的全部几何/材质调用都要能过桩
  load('js/gl-cars.js');

  const track = sandbox.RaceTrack.createTrack(trackId);
  const canvas = makeCanvas(1280, 720);
  const gl = sandbox.RaceGL.create(canvas, track);
  if (!gl) throw new Error('RaceGL.create 返回空');

  // 车模冒烟：makeCar 走一遍（几何/材质桩），车 Group 必须有实际子件
  if (typeof sandbox.RaceGLCars !== 'undefined' && typeof sandbox.RaceGLCars.attach === 'function') {
    const carsGl = sandbox.RaceGLCars.attach(gl, track);
    const carGroup = carsGl && carsGl.scene ? findCarGroup(carsGl.scene) : null;
    if (!carGroup || carGroup.children.length < 8) {
      throw new Error('车模子件过少：' + (carGroup ? carGroup.children.length : '未找到车 Group'));
    }
  }

  // 统计网格/顶点/三角面，确认真的建出了东西
  const stats = statsOf(gl.scene);
  const meshes = stats.meshes, verts = stats.verts, tris = stats.tris;

  // create() 的返回对象必须带 setTrack——main.js 用它重建 3D 场景，
  // 只有模块上的 RaceGL.setTrack 时 main.js 的 typeof 守卫会静默跳过，切赛道不换图
  if (typeof gl.setTrack !== 'function') {
    throw new Error('create() 返回对象缺少 setTrack（main.js 的守卫会静默跳过，切赛道不重建 3D）');
  }

  // 切赛道路径也要跑一遍（dispose + 重建），并确认场景真的换了
  const other = trackId === 'attic' ? 'figure8' : 'attic';
  const otherTrack = sandbox.RaceTrack.createTrack(other);
  const beforeVerts = statsOf(gl.trackGroup).verts;
  gl.setTrack(otherTrack);
  const after = statsOf(gl.trackGroup);
  if (gl.track !== otherTrack) {
    throw new Error('setTrack 后 gl.track 没有指向新赛道');
  }
  if (!(after.verts > 0)) {
    throw new Error('setTrack 后赛道分组里没有几何');
  }
  if (beforeVerts > 0 && after.verts === beforeVerts) {
    throw new Error('setTrack 前后顶点数完全相同（' + after.verts + '），3D 场景很可能没有真的重建');
  }

  return { trackId, meshes, verts, tris, calls: THREE.calls.length, switched: other, switchedVerts: after.verts };
}

module.exports = { buildScene: run };
