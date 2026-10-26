/* 比赛回合：倒计时、圈数统计、成绩与排名（UMD：浏览器挂 window.RaceRace，Node 走 module.exports） */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    var car = null, track = null, util = null;
    try { car = require('./car.js'); } catch (e) { car = null; }
    try { track = require('./track.js'); } catch (e) { track = null; }
    try { util = require('./util.js'); } catch (e) { util = null; }
    module.exports = factory(car, track, util);
  } else {
    root.RaceRace = factory(root.RaceCar, root.RaceTrack, root.RaceUtil);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (RaceCar, RaceTrack, RaceUtil) {
  'use strict';

  // 默认倒计时时长（秒）与默认圈数
  var COUNTDOWN = 3.2;
  var DEFAULT_LAPS = 3;

  // 取车模组；缺失时给出明确错误，避免静默不动
  function carApi() {
    if (!RaceCar || typeof RaceCar.update !== 'function') {
      throw new Error('race.js 需要 RaceCar.update：请先加载 car.js');
    }
    return RaceCar;
  }

  // 时间文本：优先用 RaceUtil.formatTime，无依赖时退化为秒.毫秒
  function formatTime(s) {
    if (RaceUtil && typeof RaceUtil.formatTime === 'function') return RaceUtil.formatTime(s);
    var ms = Math.round(Number(s) * 1000);
    if (!isFinite(ms) || ms < 0) ms = 0;
    var total = Math.floor(ms / 1000);
    var mmm = ms - total * 1000;
    var mm = Math.floor(total / 60);
    var ss = total - mm * 60;
    var pad3 = mmm < 10 ? '00' + mmm : (mmm < 100 ? '0' + mmm : String(mmm));
    return mm + ':' + (ss < 10 ? '0' + ss : String(ss)) + '.' + pad3;
  }

  // 创建一场比赛；cars 为 RaceCar.createCar 产出的车辆数组
  function createRace(opts) {
    var o = opts || {};
    var carList = o.cars || [];
    var laps = o.laps === undefined ? DEFAULT_LAPS : Number(o.laps);
    if (!isFinite(laps) || laps < 1) laps = DEFAULT_LAPS;
    laps = Math.floor(laps);

    var entries = [];
    for (var i = 0; i < carList.length; i++) {
      var c = carList[i];
      entries.push({
        car: c,
        lane: c && c.lane !== undefined ? c.lane : 0,
        lap: 0,
        lapStart: 0,
        lapTimes: [],
        bestLap: null,
        finished: false,
        finishTime: null
      });
    }

    return {
      track: o.track || null,
      laps: laps,
      phase: 'countdown',
      t: 0,
      countdown: COUNTDOWN,
      elapsed: 0,
      entries: entries,
      winner: null,
      phaseTime: 0,
      lastEvent: null
    };
  }

  // 单帧推进：throttles[i] 为 entries[i] 的油门（0..1），倒计时期间忽略
  function update(race, dt, throttles) {
    if (!race || !(dt > 0)) return race;

    if (race.phase === 'countdown') {
      race.t += dt;
      if (race.t >= race.countdown) {
        race.phase = 'running';
        race.elapsed = 0;
        for (var k = 0; k < race.entries.length; k++) race.entries[k].lapStart = 0;
      }
      return race;
    }

    if (race.phase !== 'running') {
      // finished 或其他静止阶段：只累加本阶段计时
      race.phaseTime += dt;
      return race;
    }

    var api = carApi();
    var track = race.track;
    var total = track && track.totalLength > 0 ? track.totalLength : 0;
    var gas = throttles || [];

    race.elapsed += dt;

    for (var i = 0; i < race.entries.length; i++) {
      var entry = race.entries[i];
      var car = entry.car;
      if (!car) continue;

      var throttle = Number(gas[i]);
      if (!isFinite(throttle) || throttle < 0) throttle = 0;
      if (throttle > 1) throttle = 1;

      api.update(car, dt, { throttle: throttle }, track);

      // 越过起点线：s 归零记一圈（单帧跨多圈也逐圈结算）
      while (total > 0 && car.s >= total) {
        car.s -= total;
        entry.lap += 1;
        var lapTime = race.elapsed - entry.lapStart;
        entry.lapTimes.push(lapTime);
        if (entry.bestLap === null || lapTime < entry.bestLap) entry.bestLap = lapTime;
        entry.lapStart = race.elapsed;
        // 冠军产生后不再用同帧后续圈事件覆盖 finish 事件
        if (!race.winner) race.lastEvent = { type: 'lap', index: i, lap: entry.lap, lapTime: lapTime };

        if (entry.lap >= race.laps) {
          entry.finished = true;
          entry.finishTime = race.elapsed;
          // 首位过线者为冠军；同帧一起过线的其它车同样记为完赛，但不改写冠军与事件
          if (!race.winner) {
            race.winner = entry;
            race.lastEvent = { type: 'finish', index: i, time: race.elapsed };
          }
          break;
        }
      }
    }

    // 本帧所有车都已结算完再定格，避免后位车少推进一帧
    if (race.winner) {
      race.phase = 'finished';
      race.phaseTime = 0;
    }

    return race;
  }

  // 已跑距离（用于未完成车辆的排名）：lap × 赛道长 + 当前弧长
  function progressOf(race, entry) {
    var total = race.track && race.track.totalLength > 0 ? race.track.totalLength : 0;
    var s = entry.car && isFinite(entry.car.s) ? entry.car.s : 0;
    return entry.lap * total + s;
  }

  // 排名：已完成按 finishTime 升序在先，未完成按已跑距离降序
  function standings(race) {
    if (!race) return [];
    var list = race.entries.slice();
    list.sort(function (a, b) {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished) {
        var ta = a.finishTime === null ? Infinity : a.finishTime;
        var tb = b.finishTime === null ? Infinity : b.finishTime;
        if (ta !== tb) return ta - tb;
        return 0;
      }
      return progressOf(race, b) - progressOf(race, a);
    });
    return list;
  }

  // 是否处于比赛进行中
  function isRunning(race) {
    return !!race && race.phase === 'running';
  }

  // 已用时文本（m:ss.mmm）
  function elapsedText(race) {
    return formatTime(race ? race.elapsed : 0);
  }

  return {
    createRace: createRace,
    update: update,
    standings: standings,
    isRunning: isRunning,
    elapsedText: elapsedText,
    COUNTDOWN: COUNTDOWN,
    DEFAULT_LAPS: DEFAULT_LAPS
  };
});
