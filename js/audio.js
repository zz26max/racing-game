/* 音效合成（UMD：浏览器挂 window.RaceAudio，Node 走 module.exports）
 * 全部用 WebAudio 振荡器/噪声实时合成，不加载任何音频文件。
 * AudioContext 在首次用户手势后 resume；未 resume 或静音时所有方法静默返回。 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RaceAudio = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  var api = {};

  var ENGINE_GAIN = 0.03;   // 引擎增益（固定）
  var ENGINE_BASE = 55;     // 引擎基频 55Hz
  var ENGINE_SPAN = 220;    // 随速度增加的频率跨度

  function getWin() {
    if (typeof window !== 'undefined') return window;
    if (root && root.window) return root.window;
    return null;
  }

  // speed01 裁剪到 [0, 1]；非法值按 0
  function clamp01(v) {
    var n = Number(v);
    if (!isFinite(n)) return 0;
    if (n < 0) return 0;
    if (n > 1) return 1;
    return n;
  }

  api.createAudio = function () {
    var win = getWin();
    var CtxCtor = win ? (win.AudioContext || win.webkitAudioContext) : null;
    var ctx = null;
    var master = null;
    var muted = false;
    var destroyed = false;
    var engines = [];
    var noiseBuffer = null;
    var gestureAttached = false;

    // 只在真正 running 时出声：未 resume / 挂起一律静默
    function running() {
      return !!(ctx && ctx.state === 'running');
    }

    function silent() {
      return destroyed || muted || !running();
    }

    function initCtx() {
      if (ctx || destroyed || !CtxCtor) return null;
      try {
        ctx = new CtxCtor();
        master = ctx.createGain();
        master.gain.value = 1;
        master.connect(ctx.destination);
      } catch (err) {
        ctx = null;
        master = null;
      }
      return ctx;
    }

    // 首次用户手势自动解锁（也提供显式 resume）
    function onGesture() {
      detachGesture();
      resume();
    }

    function attachGesture() {
      if (gestureAttached || !win || !win.addEventListener) return;
      gestureAttached = true;
      win.addEventListener('keydown', onGesture, true);
      win.addEventListener('pointerdown', onGesture, true);
      win.addEventListener('touchstart', onGesture, true);
    }

    function detachGesture() {
      if (!gestureAttached || !win || !win.removeEventListener) { gestureAttached = false; return; }
      gestureAttached = false;
      win.removeEventListener('keydown', onGesture, true);
      win.removeEventListener('pointerdown', onGesture, true);
      win.removeEventListener('touchstart', onGesture, true);
    }

    function resume() {
      if (destroyed) return Promise.resolve(false);
      try {
        if (!initCtx()) return Promise.resolve(false);
        detachGesture();
        var p = ctx.resume();
        if (p && typeof p.then === 'function') {
          return p.then(function () { return true; }, function () { return false; });
        }
        return Promise.resolve(true);
      } catch (err) {
        return Promise.resolve(false);
      }
    }

    // 1 秒白噪声，boom 复用
    function noise() {
      if (!noiseBuffer) {
        var len = Math.max(1, Math.floor(ctx.sampleRate * 0.4));
        noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
        var data = noiseBuffer.getChannelData(0);
        for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      }
      return noiseBuffer;
    }

    // 单个 sine 音，start 为相对当前时刻的秒数偏移
    function tone(freq, start, dur, peak, type) {
      if (!running() || muted || destroyed) return;
      try {
        var t = ctx.currentTime + start;
        var osc = ctx.createOscillator();
        osc.type = type || 'sine';
        osc.frequency.value = freq;
        var gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(peak, t + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        osc.connect(gain);
        gain.connect(master);
        osc.start(t);
        osc.stop(t + dur + 0.02);
      } catch (err) { /* 静默失败 */ }
    }

    // 每个玩家一条 sawtooth + lowpass 引擎音
    function ensureEngine(i) {
      if (engines[i]) return engines[i];
      try {
        var osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = ENGINE_BASE;
        var filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 320;
        filter.Q.value = 1;
        var gain = ctx.createGain();
        gain.gain.value = 0;
        osc.connect(filter);
        filter.connect(gain);
        gain.connect(master);
        osc.start();
        engines[i] = { osc: osc, filter: filter, gain: gain };
        return engines[i];
      } catch (err) {
        return null;
      }
    }

    var audio = {
      resume: resume,

      setMuted: function (b) {
        muted = !!b;
        // 静音时把引擎音降到 0，解除后由下一次 engine() 恢复
        if (running()) {
          try {
            var t = ctx.currentTime;
            for (var k in engines) engines[k].gain.gain.setTargetAtTime(muted ? 0 : ENGINE_GAIN, t, 0.05);
          } catch (err) { /* 静默失败 */ }
        }
        return muted;
      },

      isMuted: function () { return muted; },

      // 引擎音：i 区分玩家，speed01 为 0..1 速度比例
      engine: function (i, speed01) {
        if (silent()) return;
        var slot = ensureEngine(i | 0);
        if (!slot) return;
        try {
          var s = clamp01(speed01);
          var t = ctx.currentTime;
          slot.osc.frequency.setTargetAtTime(ENGINE_BASE + s * ENGINE_SPAN, t, 0.08);
          slot.filter.frequency.setTargetAtTime(320 + s * 1200, t, 0.1);
          slot.gain.gain.setTargetAtTime(ENGINE_GAIN, t, 0.1);
        } catch (err) { /* 静默失败 */ }
      },

      // 撞击：白噪声短爆
      boom: function () {
        if (silent()) return;
        try {
          var t = ctx.currentTime;
          var src = ctx.createBufferSource();
          src.buffer = noise();
          var filter = ctx.createBiquadFilter();
          filter.type = 'lowpass';
          filter.frequency.value = 900;
          var gain = ctx.createGain();
          gain.gain.setValueAtTime(0.85, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
          src.connect(filter);
          filter.connect(gain);
          gain.connect(master);
          src.start(t);
          src.stop(t + 0.36);
        } catch (err) { /* 静默失败 */ }
      },

      // 提示音：sine 120ms
      beep: function (freq) {
        var f = Number(freq);
        if (!isFinite(f) || f <= 0) f = 440;
        tone(f, 0, 0.12, 0.18, 'sine');
      },

      // 两音上行
      chime: function () {
        tone(660, 0, 0.12, 0.15, 'sine');
        tone(990, 0.12, 0.16, 0.15, 'sine');
      },

      // 四音上行琶音
      fanfare: function () {
        var notes = [523.25, 659.25, 783.99, 1046.5];
        for (var i = 0; i < notes.length; i++) tone(notes[i], i * 0.14, 0.16, 0.14, 'triangle');
      },

      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        detachGesture();
        for (var k in engines) {
          try {
            engines[k].osc.stop();
            engines[k].osc.disconnect();
            engines[k].gain.disconnect();
            engines[k].filter.disconnect();
          } catch (err) { /* 忽略 */ }
        }
        engines = [];
        noiseBuffer = null;
        if (ctx) {
          try {
            if (ctx.state !== 'closed' && typeof ctx.close === 'function') ctx.close();
          } catch (err) { /* 忽略 */ }
        }
        ctx = null;
        master = null;
      }
    };

    attachGesture();
    return audio;
  };

  return api;
});
