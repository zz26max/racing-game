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

  var ENGINE_GAIN = 0.038;  // 引擎满油门时的增益上限（实际 = 上限 × 油门量，不踩不响）
  var ENGINE_BASE = 62;     // 引擎基频
  var ENGINE_SPAN = 240;    // 随速度增加的频率跨度
  var ENGINE_DETUNE = 1.007; // 第二锯齿的失谐比（≈12Hz 拍频，加厚）
  var SCREECH_GAIN = 0.05;  // 轮胎低噪峰值增益（渐入，不作啸叫）

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

    // 每个玩家一组引擎声 + 一组轮胎摩擦声（全程常驻，增益归零待命）：
    //  - 引擎：双锯齿微失谐（拍频加厚）→ lowpass 随速度开合；24Hz LFO 对增益做浅调幅（怠速颤感）
    //  - 摩擦：循环白噪声 → 高Q带通（中心频率随 warn 抬升 + 7.5Hz LFO 抖动）→ 增益随 warn
    //    —— 赛车游戏"逼近极限"的通用配方是轮胎摩擦声，不是报警器音
    function ensureEngine(i) {
      if (engines[i]) return engines[i];
      try {
        var sawA = ctx.createOscillator();
        sawA.type = 'sawtooth';
        sawA.frequency.value = ENGINE_BASE;
        var sawB = ctx.createOscillator();
        sawB.type = 'sawtooth';
        sawB.frequency.value = ENGINE_BASE * ENGINE_DETUNE;
        var filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 380;
        filter.Q.value = 2.2;
        var gain = ctx.createGain();
        gain.gain.value = 0;
        sawA.connect(filter);
        sawB.connect(filter);
        filter.connect(gain);
        gain.connect(master);
        sawA.start();
        sawB.start();

        var lfo = ctx.createOscillator();
        lfo.type = 'sine';
        lfo.frequency.value = 24;
        var lfoDepth = ctx.createGain();
        lfoDepth.gain.value = 0;        // 随引擎增益一起开合
        lfo.connect(lfoDepth);
        lfoDepth.connect(gain.gain);    // 对增益做浅调幅（AudioParam 叠加）
        lfo.start();

        var noiseSrc = ctx.createBufferSource();
        noiseSrc.buffer = noise();
        noiseSrc.loop = true;
        var bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 750;
        bp.Q.value = 0.9;      // 低 Q：宽频"沙沙"，无啸叫也无脉冲
        var screechGain = ctx.createGain();
        screechGain.gain.value = 0;
        noiseSrc.connect(bp);
        bp.connect(screechGain);
        screechGain.connect(master);
        noiseSrc.start();

        engines[i] = {
          sawA: sawA, sawB: sawB, filter: filter, gain: gain,
          lfoDepth: lfoDepth,
          bp: bp, screechGain: screechGain
        };
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
            for (var k in engines) {
              var e = engines[k];
              e.gain.gain.setTargetAtTime(0, t, 0.05);            // 解除静音后由 engine() 按油门恢复
              e.lfoDepth.gain.setTargetAtTime(0, t, 0.05);
              e.screechGain.gain.setTargetAtTime(0, t, 0.05);
            }
          } catch (err) { /* 静默失败 */ }
        }
        return muted;
      },

      isMuted: function () { return muted; },

      // 引擎音：i 区分玩家；speed01 速度比例；warn01 打滑预警量；throttle01 油门行程
      // —— 增益 = 上限 × 油门：不踩不响，踩多少响多少（槽车电机感）
      // —— 轮胎低噪：带宽 850..1500Hz、Q1.1 的"沙沙"层，0.15s 时间常数缓慢渐入，不突兀
      engine: function (i, speed01, warn01, throttle01) {
        if (silent()) return;
        var slot = ensureEngine(i | 0);
        if (!slot) return;
        try {
          var s = clamp01(speed01);
          var w = clamp01(warn01);
          var th = clamp01(throttle01);
          var t = ctx.currentTime;
          var freq = ENGINE_BASE + s * ENGINE_SPAN;
          slot.sawA.frequency.setTargetAtTime(freq, t, 0.08);
          slot.sawB.frequency.setTargetAtTime(freq * ENGINE_DETUNE, t, 0.08);
          slot.filter.frequency.setTargetAtTime(380 + s * 1500, t, 0.1);
          slot.gain.gain.setTargetAtTime(ENGINE_GAIN * th, t, 0.08);
          slot.lfoDepth.gain.setTargetAtTime(0.01 * th, t, 0.1);
          // 轮胎低噪：750..1300Hz 宽频沙沙，0.18s 慢攻——是"渐渐紧张"不是突然出现
          slot.bp.frequency.setTargetAtTime(750 + w * 550, t, 0.15);
          slot.screechGain.gain.setTargetAtTime(w * 0.035, t, 0.18);
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

      // UI 点击：短促 triangle tick（纸卡芯片按下）
      click: function () {
        tone(1250, 0, 0.05, 0.07, 'triangle');
      },

      // 救车成功：单音轻点（弯道里可能频繁出现，克制）
      save: function () {
        tone(520, 0, 0.08, 0.08, 'triangle');
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
            engines[k].sawA.stop(); engines[k].sawA.disconnect();
            engines[k].sawB.stop(); engines[k].sawB.disconnect();
            engines[k].filter.disconnect();
            engines[k].gain.disconnect();
            engines[k].lfoDepth.disconnect();
            engines[k].bp.disconnect();
            engines[k].screechGain.disconnect();
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
