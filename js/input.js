/* 键盘输入（UMD：浏览器挂 window.RaceInput，Node 走 module.exports） */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RaceInput = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var api = {};

  // 玩家 1 油门：W / 空格；玩家 2 油门：↑ / Enter / 右 Shift
  var P1_KEYS = ['KeyW', 'Space'];
  var P2_KEYS = ['ArrowUp', 'Enter', 'ShiftRight'];
  // 空格与方向键会滚动页面，按下时统一拦截
  var PREVENT = { Space: true, ArrowUp: true, ArrowDown: true, ArrowLeft: true, ArrowRight: true };
  // 事件边沿名字，consume 后清空
  var EDGES = ['start', 'pause', 'restart', 'mute', 'back'];

  // 有 e.code 就用 e.code，老浏览器按 e.key 兜底
  function toCode(e) {
    if (e && typeof e.code === 'string' && e.code) return e.code;
    var k = e && e.key;
    if (!k) return '';
    if (k === ' ' || k === 'Spacebar') return 'Space';
    if (k === 'Esc') return 'Escape';
    if (k === 'Shift') return 'ShiftRight';
    if (k === 'Enter') return 'Enter';
    if (k.indexOf('Arrow') === 0) return k;
    if (k.length === 1) {
      var c = k.toUpperCase();
      if (c >= 'A' && c <= 'Z') return 'Key' + c;
    }
    return k;
  }

  // 创建输入对象；返回对象同时挂 state 别名，输入实例即状态
  api.createInput = function () {
    var win = (typeof window !== 'undefined') ? window : null;
    var held = Object.create(null);
    var edges = Object.create(null);
    var destroyed = false;

    function clearAll() {
      for (var k in held) delete held[k];
    }

    function isDown(code) { return held[code] === true; }

    function anyDown(list) {
      for (var i = 0; i < list.length; i++) if (isDown(list[i])) return true;
      return false;
    }

    function fire(name) { edges[name] = true; }

    function onKeyDown(e) {
      if (destroyed) return;
      var code = toCode(e);
      if (!code) return;
      if (PREVENT[code] && e && e.preventDefault) e.preventDefault();
      // 快捷键只在真实按下边沿触发一次，忽略长按自动重复
      if (!e || !e.repeat) {
        if (code === 'KeyP') fire('pause');
        else if (code === 'KeyR') fire('restart');
        else if (code === 'KeyM') fire('mute');
        else if (code === 'Enter') fire('start');
        else if (code === 'Escape') fire('back');
      }
      held[code] = true;
    }

    function onKeyUp(e) {
      if (destroyed) return;
      var code = toCode(e);
      if (!code) return;
      if (PREVENT[code] && e && e.preventDefault) e.preventDefault();
      delete held[code];
    }

    // 失焦时按键收不到 keyup，直接清空，避免油门卡住
    function onBlur() { clearAll(); }

    function onVisibility() {
      if (win && win.document && win.document.hidden) clearAll();
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      clearAll();
      for (var i = 0; i < EDGES.length; i++) edges[EDGES[i]] = false;
      if (win && win.removeEventListener) {
        win.removeEventListener('keydown', onKeyDown, false);
        win.removeEventListener('keyup', onKeyUp, false);
        win.removeEventListener('blur', onBlur, false);
        win.removeEventListener('visibilitychange', onVisibility, false);
      }
    }

    if (win && win.addEventListener) {
      win.addEventListener('keydown', onKeyDown, false);
      win.addEventListener('keyup', onKeyUp, false);
      win.addEventListener('blur', onBlur, false);
      win.addEventListener('visibilitychange', onVisibility, false);
    }

    var input = {
      // i=0 玩家 1，i=1 玩家 2，其他返回 0
      get: function (i) {
        if (i === 0) return anyDown(P1_KEYS) ? 1 : 0;
        if (i === 1) return anyDown(P2_KEYS) ? 1 : 0;
        return 0;
      },
      // 取一次边沿事件：'start' | 'pause' | 'restart' | 'mute' | 'back'
      consume: function (name) {
        if (!name || !edges[name]) return false;
        edges[name] = false;
        return true;
      },
      isDown: function (code) { return isDown(String(code)); },
      clear: clearAll,
      destroy: destroy
    };
    input.state = input;
    return input;
  };

  return api;
});
