# 交接文档：脱轨物理与"回槽隐形"修复（2026-10-26）

## 任务背景

用户报告两个 bug：

1. **小车物理模拟不够真实，会穿模**——最明显的是"甩出去"动作不真实（穿过护栏/桥面、垂直弹跳、落地乱蹦）。
2. **小车回到赛道上时会隐形**——用户怀疑是"桥下隐形机制"没处理好。

## 诊断结论（已验证）

### 隐形：不是隐藏机制，是几何遮挡

- 排查了全部渲染链路（`gl-cars.js` / `gl.js` / `render.js` / `main.js`），**不存在任何显式的"桥下隐藏"代码**；`gl-cars.js` 里的 `visible`/`opacity` 注释是历史修复，已堵住。
- 真正原因：固定高机位 `gl.js:589` 相机在 `(0, 620, 900)` 俯视，8 字赛道在 **s≈1156–1392** 段从桥面（36px 高 + 16px 黄护栏）正下方穿过。射线检测（`_debug/_occlusion-probe.js`）证实：
  - **s∈[1208,1256] 车身包围盒完全不可见**；
  - s∈[1160,1316] 大部分被遮挡（>25% 角点被挡）。
- 脱轨后归位回到**脱轨时原 s**（脱轨期间 `car.s` 冻结），所以脱轨点在桥下死角时，车凭空出现在被桥面挡死的区段；以复位速度 120px/s 约 0.33 秒完全隐身、~1.2 秒大部分被挡。
- 正常行驶穿过桥下也会被挡（4/8 角点可见，近侧护栏挡半辆车），这是"从桥下经过"的正常观感，不算 bug。

### 穿模：飞行世界只有一块无限地面

- `flight-physics.js` 的 cannon 世界只有地面平面（`ensureWorld`），视觉里的护栏、桥面、桥墩全都没有碰撞体 → 穿模必然发生。
- 起跳参数"蹦"而不是"甩"：`vy = 150+0.1v` 垂直上抛、自旋 `7+0.03v` 且角阻尼仅 0.05、弹性 0.45。实测落地二次弹到 2.5 倍车高。
- 归位是世界坐标直线插值，桥附近复位会斜穿桥面/护栏。
- 旧版超时（2.2s）会原地冻结半空 0.35s 再滑回。

## 已完成的修改

### 1. `js/flight-physics.js` —— 重写飞行碰撞与调参

- **新增静态碰撞体**（每车世界建一次，跨脱轨复用）：
  - `buildWallRing`：整圈两侧护栏墙，每 40px 一段（高 16、厚 3、中心线偏移 46.5、随 `elevationAt` 起伏），共 ~128 段。**墙底抬高 0.5px**——见下方"调试记录"。
  - `buildDeck`：桥面+引桥承力板，每 20px 一块（s∈[sCenter±240]，厚 4、顶面比视觉路面高 0.5、按 `slopeAt` 倾斜）。
  - broadphase 换 `SAPBroadphase`（缺失回落 Naive）。
- **接触材质**：摩擦 0.2、弹性 0.25（原 0.12 / 0.45）——低弹跳，撞击以减速吸收为主。
- **起跳参数**（保留用户中途加的 `?throw=` 调参参数和 0.9 前向保留）：
  - 横向速度改用脱轨瞬间真实 `offsetVel`，钳在 [0.18, 0.5]×speed（原来是固定 0.65 倍兜底）；
  - `vy = 50 + 0.18v`（原 150+0.1v）——甩滑出去，不是起飞；
  - 自旋 `1.6+0.010v`（原 7+0.03v）、偏航 0.8（原 1.5）、角阻尼 0.35（原 0.05）、线阻尼 0.12（原 0.02）。
- **停稳判定**：
  - 落地判定从"只认地面"改为"接触任意支撑面"（`touchingSupport`）；
  - 软超时 2.2s 后水平速度按 `exp(-6dt)` 强衰减让车就近落下；2.8s 硬截止；
  - 新增停稳条件 `elapsed > MAX_FLIGHT_TIME && landedTime > 0`，不再冻结半空。

### 2. `js/car.js` —— 归位目标避开死角 + 三段式归位

- 新增 `slotUnderDeck(trackObj, s)`：纯几何判定槽位是否在桥面足迹正下方（贴地段 + 距桥面中心线水平距离 < 半宽+14）。
- rest → return 切换时：若归位目标在死角内，沿赛道**向后以 12px 步退**（最多 80 次 = 960px）退出遮挡区，车归位后正常从桥下驶出。圈数计数用 `s >= total` 判定，s 只减不增，**安全**。
- 归位插值：目标比起点高 >20px（如从桥下地板回桥面）时改**三段式**——升到槽上方 16px → 平移 → 落下，避免直线插值斜穿桥面/护栏；小落差仍走原 smoothstep + 18px 小拱。

### 3. 新增调试探针（`_debug/`）

- `_occlusion-probe.js`：桥下遮挡射线检测（Möller–Trumbore 复现桥面/护栏/桥墩网格）。
- `_flight-probe.js`：6 种脱轨场景的飞行物理回归验证（桥面中央/低中速/引桥坡面/地面高速/地面低速/桥下死角）。

## 验证状态

- ✅ `node --test test/race.test.js` **4/4 通过**（修后重跑）。
- ✅ `_flight-probe.js` 全部场景：不穿桥面、留在护栏走廊内（最远偏移 37px < 护栏 45px）、翻滚 0.1–0.6 圈、飞行 0.5–1.5s 自然停稳。
- ⚠️ 探针里 s=1256 那条"穿模"是**误报**：立交区 `nearestS` 命中桥面支线（车 y=7.5 在地面层合法从桥下穿过）。
- ❌ **浏览器实际画面未验证**（改动只有 Node 侧几何/逻辑验证，见待办）。

## 调试记录（重要经验）

- **静态体互相嵌入会让 cannon 求解器把车喷飞**：护栏墙底（y=37）与承力板顶（y=37.5）嵌入 0.5px，车滑到墙脚时被夹在两者之间持续向上顶（桥面脱轨 0.28s 就被喷到 y=60 提前停稳）。修复 = 墙整体抬高 0.5px，干净坐在板面上。以后再加静态体，注意接缝不重叠。
- cannon 0.6.2 `Quaternion.mult(a, out)` 语义 = `this × a`（先作用 a），已实测确认。
- `SAPBroadphase` 对无限 Plane 曾被怀疑，A/B 对照排除——不是它的问题。

## 待办

1. **浏览器视觉验证（最重要）**：所有改动只做了 Node 侧验证。打开 `index.html` 实际玩：①在桥面/引桥/地面各触发几次脱轨，看甩出轨迹、护栏反弹、桥面落地是否自然；②在桥下段（s≈1156–1392）脱轨，确认车归位到死角外、不再隐形；③观察 2.2s 软超时后的就近落下滑行是否顺滑。可用 `?ff=秒数&freeze=1` 截帧、`?throw=0.6~2.0` 调甩出力度。
2. **观感调参**：`vy`、自旋、弹性是第一轮理论值，视觉验证后大概率要微调（调参点集中在 `flight-physics.js` 顶部常量与 `begin()` 内）。
3. **浏览器自检**：`index.html?selftest=1` 跑一遍——`main.js:73` 在自检前就挂了 cannon 钩子，自检现在会走新飞行物理，需确认标题输出 `SELFTEST PASS`。
4. **README 更新**（多处已过时）：
   - 脱轨时序：文档写 0.9/0.8/0.45（合计 2.15s），代码实际 2.2/0.35/0.4；
   - 文件结构表缺 `flight-physics.js` 和 `vendor/cannon.min.js`（index.html 实际加载 13 个 js + 2 个 vendor）；
   - 新增行为：归位目标最多向后退 960px 避开桥下死角；飞行段有护栏/桥面碰撞；`?throw=` 参数。
5. **性能观察**：每车 154 个静态体 × 2 车（SAP broadphase），Node 里无感，浏览器帧率待观察；如果吃紧可把墙段加长（WALL_SEG 40→80 减半数量）。
6. **2D 兜底路径未动**：无 WebGL 时走 `car.js` 内置抛体（else 分支），参数仍是旧的（flyVLong=speed、大上抛），可接受但与 3D 观感不一致；如需统一再调。
7. `_debug/` 共 298 个文件（含本次 2 个探针），确认稳定后可清理旧调试产物。

## 关键文件/位置速查

| 位置 | 内容 |
| --- | --- |
| `js/flight-physics.js:17-31` | 飞行时长/停稳/护栏/承力板常量 |
| `js/flight-physics.js` `begin()` | 起跳速度、自旋、阻尼 |
| `js/car.js` `slotUnderDeck()` | 桥下死角判定 |
| `js/car.js` return 段（`derailPhase === 'return'`） | 归位目标回退 + 三段式插值 |
| `js/gl.js:582` | 固定机位坐标（遮挡问题的根源之一） |
| `js/track.js:28` | 桥几何（sCenter=0, halfLength=70, height=36, rampHalf=240） |
| `_debug/_flight-probe.js` / `_occlusion-probe.js` | 两个回归探针，改动后重跑即可 |

## 2026-10-26 后续修正（当前状态）

- **护栏改为矮护栏**：视觉 7px、物理碰撞 7px（每 40px 一段、绕赛道两侧，随 elevation 起伏）；桥面黄色护栏仍 16px；桥面/引桥承力板保留；接触弹性 0.4、摩擦 0.16。
- **相机**：固定 (0,620,900)，已移除脱轨后拉近/拉远的逻辑。
- **水平甩出方向**：统一为法线 (ty,-tx)·side（渲染的侧滑偏移与物理初速同向）；`?throw=0.3~2.0` 可调力度，默认 1。
- **flight-physics `begin()`**：从「槽心 + 外法线×offset（限幅 32）」起跳，yaw = 切线 + 侧滑偏航 + 坡度俯仰，高度 +2px，角速度 0.15s 渐入，并在 begin 末尾立即写回 `car.worldX/Y/Z` 与 `car.quat`（避免触发帧用旧位姿）。
- **gl-cars 赛道分支**：改为 `g.rotation.set(0, yaw, pitch)`，清除世界坐标分支残留的 `rotation.x`。这是「归位后几率性隐形」的根因：欧拉分解出 x=π 会让车倒扣沉到路面下。
- **验证状态**：`node --test test/race.test.js` 4/4 通过；`index.html?selftest=1` 输出 `SELFTEST PASS`（最近一次 bestLap≈16.1、derails≈12）。以上均为 Node 侧验证，浏览器观感仍需人工确认。
- **已知遗留**：
  1. 起跳瞬间若 offset + 车半宽 超过护栏内壁 45，首帧仍会吃到护栏接触冲量（clamp 基准应改为 45-13-lane偏移）；
  2. 需实机慢放连拍 20 次脱轨，确认「无回弹、归位可见」；
  3. README 与 `_debug` 清理仍待做。

## 2026-10-26 第二轮：脱轨手感与归位验证（当前状态）

用户要求“接着修脱轨手感与归位验证”，本轮针对上一轮遗留的三条问题做了修正：

### 1. 起跳嵌护栏（`js/flight-physics.js` `begin()`）
- 原来 `MAX_START_OFFSET = 32` 是对 `|offset|` 的绝对量 clamp，没算 lane 槽心已在中心线 ±22：外槽脱轨起跳点落在 32.6、车身外沿 45.6 > 护栏内壁 45，出生即嵌入护栏墙、首帧吃接触冲量。
- 改为对“距中心线的**有符号**横向坐标”clamp 到 `±(halfW + 3 − 13 − 0.5) = ±31.5`（halfW=42、车半宽 13、余量 0.5），再用 `latDelta` 从槽心推出世界坐标。常量换成 `MAX_START_MARGIN = 0.5`。
- 实测：20 次脱轨起跳外沿最大 44.50px，四种 lane/side 组合均 ≤ 31.5。

### 2. 外槽脱轨甩不出去（同文件 `begin()`）
- 护栏高 7、车体半高 6.5，原来起跳只抬 2px（车体竖直范围路面上 3~16）与护栏 0~7 竖直重叠；外槽脱轨一开始就贴着护栏内壁，横向速度被护栏侧面接触立刻吃掉——实测甩出横向只有 1.6~24px，观感是“撞一下护栏又回槽”。
- 起跳高度 `+2` → `+8`：车体底部在路面上 9px，高于护栏顶 7，横向甩出不再被挡死。
- 实测：甩出横向位移从 1.6~24px 提升到 41.5~80.7px，外槽/内槽都能越过矮护栏落到路肩。

### 3. 落地乱蹦（同文件材质）
- 接触弹性 `0.4` → `0.3`（摩擦保持 0.16）。原来首次落地回弹约 10.7px（0.76 倍车高），改后 >3px 回弹最多 1 次、最大 3.3px，落地以滑行吸收为主。

### 4. 新增回归探针 `_debug/_derail-probe.js`
- 用真实驾驶循环（`carMod.update` + `setFlightHooks`）连跑 20 次脱轨（20 个均匀起点、初速 40→400）。
- 在**脱轨瞬间的局部坐标系**里测量：外法线 `(ty,−tx)×side` 方向的甩出距离、沿切线的前冲距离（不用 `nearestS`，避免 8 字赛道误命中交叉支路）。
- 每个样本检查：起跳外沿 ≤ 45.05、单帧位移 ≤ 14px（无瞬移）、归位目标 `slotUnderDeck === false`（不在桥下遮挡死角）、阶段顺序 `fly>rest>return`、4s 内归位、无 NaN、归位后 `offset === 0` 且 `worldActive === false`、回弹高度。
- 硬条件不过 `exit 1`，可直接接入 CI。
- `js/car.js` 为此导出了内部函数 `slotUnderDeck`（调试用）。
- 实测：20/20 通过；飞行 0.79–1.55s，全程 1.54–2.30s，单帧最大位移 6.7px。

### 验证状态
- ✅ `node -e "require('./test/race.test.js')"` 4/4 通过（本沙箱 `node --test` 因 spawn EPERM 不可用）。
- ✅ `node _debug/_derail-probe.js` 20/20 通过。
- ✅ `node _debug/_flight-probe.js` 6 场景不穿桥面、留在护栏走廊内（其中 s=1256 那条“穿模”仍是已知误报：车 y=7.5 在地面层合法从桥下穿过）。
- ✅ README 已同步（时序、文件结构、新行为、探针、验证段）。
- ⚠️ 浏览器实机观感仍未验证：本沙箱无法派生无头浏览器（Edge/Chrome 启动即被拒），`?selftest=1` / `?ff=&freeze=1` 截帧需人工在桌面浏览器里跑一遍。

### 剩余待办
1. 人工实机确认：桥面/引桥/地面各脱轨若干次，看甩出轨迹是否自然、有没有越护栏后“卡在护栏上”的观感；桥下段（s≈1156–1392）脱轨后归位是否可见。
2. `_debug/` 已 360+ 文件，确认稳定后可清理（删除前需人工确认）。
3. 无 WebGL 的 2D 兜底路径仍是旧抛体参数，观感与 3D 不一致。

## 2026-10-26 第三轮：赛道选择 + 阁楼复刻赛道（当前状态）

### 已完成

1. **git 基线**：`953cfdf chore: 保留当前版本基线（脱轨手感修复后）`——本轮改动前的完整还原点。

2. **track.js 多赛道改造**：
   - `TRACK_DEFS` 注册表：`figure8`（双纽线，默认）/ `attic`（阁楼复刻）。
   - `createTrack(id)`（未知 id 回落 figure8）、`listTracks()`；track 对象新增 `id/name/desc/startLineStyle`。
   - 阁楼赛道用**海龟命令**描述（`['F', dist] / ['R', deg, r] / ['L', deg, r]`），`buildTurtlePoints()` 内含 CR 平滑 + 2px 均匀重采样 + 2 遍轻 fairing——海龟构造保证全部衔接切线连续（早期手工控制点版本的 junction 尖刺即由此根除）。
   - 断言按赛道分派：figure8 维持"恰 1 自交且一遍桥上一遍桥下"；attic 为"每个自交都是合法桥下穿越（一遍平段高程≥30 + 一遍地面且在桥面路基内）+ 走廊重叠段须在平段 ±60 弧长内"。
   - attic 桥参数：crest (12,-167)、rampHalf **280**（引桥加长，让桥下穿越点保持 ≥28px 高程）、railSpan 170（黄护栏覆盖平段+大部分引桥）。

3. **赛道选择**：标题界面 ←/→ 切换（`input.js` 新增 left/right 边沿），`main.js` 的 `switchTrack()` 重建赛道/2D 底图/3D 场景，`localStorage['slotrace.track']` 记忆，`?track=attic` URL 可指定。标题渲染选择器（render.js drawTitle）。

4. **3D 重建**：`gl.js` 赛道几何收进 `trackGroup`，新增 `api.setTrack(track)`（释放旧几何+重建）；`gl-cars.js` 改读 `gl.track`（切换后逐帧同步用新赛道）；`flight-physics.js` 静态体登记 `staticBodies`，`ensureWorld` 检测赛道变化拆旧重建。

5. **起跑线样式**：`startLineStyle: 'grid' | 'lines'`——attic 用双白线（对照参考图终点线），gl.js 与 scene.js（2D 兜底）均已实现。

6. **car.js 回位退出双向化**：原实现只向后退出桥下走廊，attic 的走廊内含弯道时会形成"后退→重新加速→再脱轨"死循环（全油门 0 圈）。改为前后双向扫描取更近出口（前向退出会跳过桥下段约 130px，计圈安全：race.js 按 s≥total 结算，跳段不跨终点线就不计圈；跨了也只影响该圈圈速）。8 字赛道行为不变（其走廊内无弯道，双向扫描结果与原单向一致或更近）。

7. **测试**：race.test.js 新增用例 5（attic 几何断言 + 治理驾驶 150s 完赛 3 圈零脱轨）与用例 6（注册表回落）。6/6 通过。

### 阁楼赛道关键数据

- 总长 3723px（8 字的 1.46 倍），bbox 894×564，起点 (236,-168) 向西，crest (12,-167)。
- 治理驾驶（油门调制，GOVERNOR 190）：3 圈 61.3s **零脱轨**，最佳圈 20.33s。
- 全油门：151s 完赛但 90 次脱轨——技术赛道，收油过弯是设计意图（README 已注明）。
- 最紧弯 r44（脱轨阈值 sqrt(950×44)≈204px/s）。

### 调试经验（重要）

- **手工控制点 + Catmull-Rom 的 junction 尖刺**：线/弧交接处弦切差（30° 弦约 13°）会让采样曲率出现 R=10-25 的假尖刺，车在 junction 反复脱轨。海龟构造（弧点每 15°）+ CR 平滑根除。
- **采样曲率尖刺 ≠ 几何折叠**：3 点窗（±2px）跨曲率跳变读出的低半径是数值伪影，折线本身精确（线+弧解析）。判据看渲染 roadbed 是否折叠，不看单点曲率。
- **桥下走廊 + 弯道 = 死循环**：走廊内含 r<166 的弯道时，后退回位→重新加速(400)→弯道再脱轨→再后退，永不逃逸。修复=双向退出（取近端）。未来设计桥下穿越时走廊内必须直线。
- **seaturtle 闭合**：末点贴近首点（<2px）时用末点**替换**首点（保留末段方向），不能简单 pop（会删掉弧末段造成闭合弦线跳变）。

### 遗留待办

1. 浏览器实机验证（本沙箱无显示）：标题选择器交互、attic 的 3D 观感（桥下穿越、黄护栏范围、双白线起跑）、gl.setTrack 切换无内存泄漏。
2. attic 的 `_derail-probe` 式量化验证（探针目前绑定 8 字赛道的几何假设）。
3. attic 全油门 151s/90 脱轨——若想全油门也可玩，需把最紧弯放宽到 r≥75（会进一步偏离参考图的紧凑 chicane）。
4. `_debug/_ref/` 下本轮生成的参考图网格标注与 attic_points.json（可复用于后续调参）。
5. `_debug/_mk-attic-track.js`（海龟原型）与 `_seg-audit.js`（junction 审计）保留可重跑。

## 2026-10-27 第四轮：多赛道脱轨探针 + 阁楼赛道手感分析（当前状态）

### 1. `_debug/_derail-probe.js` 泛化到多赛道
- 改法：`runTrack(id)` 每条赛道独立 `createTrack(id)` + 独立 `setFlightHooks(fp.create())`（避免跨赛道残留 world）；护栏内壁不再硬编码 45，改成 `track.width/2 + 3`；`node _debug/_derail-probe.js [all|figure8|attic]`，未知 id 退出码 2，任一赛道有失败样本退出码 1。
- 新增指标：`Δret = 归位目标 s − 脱轨 s`（归一到最短弧）与 `respawnMoved`，用于观察 `car.js` 的双向退出跳段；`>200px` 只打 `[跨段退出]` 软标记、不计失败。
- 实测：figure8 20/20、attic 20/20 通过；两条赛道归位目标都不在桥下遮挡死角；`attic` 出现一次 `Δret=+36`（前向退出），在软标记阈内。

### 2. 阁楼赛道：三条「甩不远」样本的根因（已定位，不是护栏 bug）
- 现象：`attic` idx 9/10/11（脱轨 s≈2048/2052/2154）`maxLatOut` 只有 5.4–6.4px、`fwdMax` 14–16px，1.2s 就停住。
- 逐帧追踪：起跳后 y 从 16.5 升到 ~26（apex），随即下落并停住；横向只走 5px。
- 根因：这三处赛道从**斜坡承力板下方**穿过，头顶净空只有 **28.9–32.5px**；起跳竖直初速 `vy = 180 + 0.22v` 让车体顶部（y+6.5）撞上斜置承力板底面，接触法线因 `slopeAt` 倾斜而带水平分量，反复接触把水平速度吃掉 —— 属于几何限制（低净空下没有甩出空间），不是穿模，也不是护栏把车卡住。
- 复核过的事实：那三处的墙段偏移都在 46.5（正常）；起跳点与墙体无 3D 重叠。

### 3. `js/flight-physics.js`：起跳位姿自避让（安全网，当前不触发）
- 新增 `wallBoxes`（`buildWallRing` 登记每段墙的定向盒参数）+ `spawnBlocked(x,y,z,yaw)`（车体近似成纵向 3 个半径 13 的圆，与膨胀后的墙盒做 3 轴重叠测试）+ `begin()` 里以 2px 步朝槽心收缩最多 26px。
- **当前几何下永不触发**：起跳中心 y = elev+16.5、墙中心 y = elev+4.5，`|Δy| = 12 > halfH+6.5 = 10`（车体底面 10 高于墙顶 8，本来就悬在墙顶上方）。保留它是为了将来若把起跳抬升从 `+8` 调低、或换更紧的赛道时能自动避让。
- 已验证：`node --check js/flight-physics.js` 通过；开启前后 `_derail-probe` 的两条赛道数字完全一致（说明行为未变）。

### 4. 阁楼赛道几何隐患（需要人眼确认）
- `attic` 有 5.4% 弧长的曲率半径 **< 46.5px**（最紧 R≈37–44，位于 s≈2534–2590、2674 一带；另有若干 junction 附近的采样尖刺）。
- 把中心线按 46.5 偏移生成护栏时，**R < 46.5 处内法线偏移会折叠**（实测扫描到 98 个反向点，分布在 s≈588/814/1112/1248–1278/2022–2194/2272/2332–2336/2426–2590/2672–2732 等短区段）——即视觉护栏在发夹弯内侧会「掐进路面」。
- 物理侧影响有限（`_derail-probe` 20/20 通过，脱轨不会穿模），但**视觉上可能出现护栏穿过路面的怪异形状**，需在浏览器里看一下 s≈1250–1290 与 2500–2740 两个区段。
- 若要修：`buildWallRing`（物理）与 `gl.js` 的 `buildWalls`（视觉）都可对「R ≤ 偏移量」的内侧段跳过或把偏移压到 `0.8R`，但会改变发夹弯的护栏外观与脱轨落点，属于设计决策，未实施。

### 验证状态
- ✅ `node -e "require('./test/race.test.js')"` 6/6 通过（`node --test` 在本沙箱 spawn EPERM）。
- ✅ `node _debug/_derail-probe.js` figure8 20/20、attic 20/20；`node _debug/_derail-probe.js nosuch` → 退出码 2。
- ✅ `node _debug/_flight-probe.js` 6 场景不穿桥面（s=1256 那条「穿模」仍是既有误报：车 y=7.5 在地面层合法从桥下穿过）。
- ⚠️ 浏览器实机仍未验证（本沙箱无法派生无头浏览器）：赛道切换交互、attic 3D 观感、发夹弯护栏是否掐进路面。

### 剩余待办
1. 人眼检查 attic 发夹弯护栏（s≈1250–1290、2500–2740）是否折叠穿路；决定是否按曲率跳过内侧墙段（物理+视觉同改）。
2. 若想让「桥下低净空处」的脱轨也有甩出手感，可在 `begin()` 里按头顶承力板净空动态压低 `vy`（例如净空 < 40px 时用 `vy = 90 + 0.1v`），需另做观感标定。
3. `_debug/` 目录已很大，确认稳定后清理（删除前需人工确认）。

## 2026-10-27 第五轮：修「侧边栏里切赛道无效」

- 现象：在 DSH Web GUI 侧边栏（iframe/面板）里打开 `index.html`，标题界面按 ←/→ 无法切换赛道。
- 分析：`_debug/_boot-sim.js` 的 `runFrames()` 有 bug——函数开头把待执行回调 `slice()` 到局部变量又丢弃，`pressKey()` 之后实际一帧都没跑，所以模拟日志里 `store` 永远是 `{}`，看起来像“切换无效”（**假阴性**，掩盖了真实问题）。真机上的主因更可能是宿主 iframe/面板吞掉或拦走方向键。
- 改动：
  1. `js/render.js`：标题选择器的 `◀` / `▶` 拆成独立绘制，并记录 56×48 的逻辑坐标命中框，新增导出 `hitTestTitleArrow(x, y)`。
  2. `js/main.js`：新增 `toLogical(e)`（用 `hudCanvas.getBoundingClientRect()` 把 client 坐标换算到 1280×720）与 `onPointerDown(e)`——标题阶段点中左右箭头即切换赛道，同时 `focus()` 画布；两个画布都加了 `tabindex="0"`；`pointerdown` 监听挂在 `#game` 与 `#hud` 上。
  3. `js/input.js`：`KeyA` / `KeyD` 也发 `left` / `right` 边沿（方向键被吞时的键盘备用键）。
  4. `_debug/_boot-sim.js`：修好 `runFrames()`；画布桩补 `getBoundingClientRect` / `addEventListener` / `focus`；新增流程 0（点击右箭头 → 断言 `localStorage['slotrace.track'] === 'attic'`）与键盘流程断言。
  5. `index.html`：脚本版本参数 `?v=2` → `?v=3`，避免旧缓存掩盖新代码。
- 验证：`node _debug/_boot-sim.js` exit 0（`[click] 右箭头 → attic`、`[key] ArrowRight ×2 → attic`）；`node -e "require('./test/race.test.js')"` 6/6；`node _debug/_derail-probe.js` 两条赛道 20/20 不变。
- 待人工确认：在侧边栏里点标题上的 ▶ 能否切到「阁楼复刻」（本沙箱无法起浏览器）。

## 2026-10-27 第六轮：侧边栏切赛道「诊断化」

- **外部证据**：用户确认「按 Enter 能开赛，但 ←/→ 与鼠标都没法切赛道」。Enter 有效 ⇒ keydown 与主循环正常、`phase==='title'` 成立 ⇒ 问题不可能是「iframe 完全没拿到事件」。
- **高级模型（Oracle）分析与我的独立核实一致**，给出按可能性排序的假设；两条输入通路（键盘 consume、鼠标 pointerdown）**都要经过 `switchTrack()` 的第一行守卫 `if (!window.RaceTrack || trackList.length < 2) return;`**，所以「两条都静默失效」最可能是 `trackList` 里只有 1 条 / 没有 `listTracks`（= 加载到了旧缓存脚本，或 index.html 自身被缓存导致引用旧 URL）。
- **同时发现一个真实缺陷（H2）**：`switchTrack` 原来先 `trackId = 新id`，再 `try { track = createTrack(trackId) } catch { return; }`。若 `createTrack` 抛错，`trackId` 已是新赛道而 `track` 仍是旧赛道，标题读取的是 `track.name` ⇒ 永远显示旧名字，看起来像「按了没反应」，且状态被污染。

### 改动
1. `js/main.js` `switchTrack()`：改为**先建后提交**——`createTrack(nextId)` 成功（且非空）后才写 `trackId` / `track` / `localStorage`；`scene.build`、`gl.setTrack` 的异常不再静默吞掉，写进 `window.__DBG__.err`。
2. `js/main.js`：`__DBG__` 统计 `calls / lastDir / guarded / err`；新增 `updateDbg()`（每 6 帧采样，`paused` 分支也写），把 `BUILD5 list=… phase=… id=… name=…` / `calls=… guard=…` / `key=… pt=…` / `err=… errors=…` 写进 `#dbg`。
3. `js/main.js` `drawHUD`：标题界面右下角固定画一行 11px 小字 `build 5 · N tracks`（**无需任何 URL 参数就能判断跑的是不是新代码，以及 trackList 有几条**）。
4. `index.html`：`Cache-Control/Pragma: no-cache` meta；`<div id="dbg">` + 诊断探针脚本（捕获阶段记录 keydown/pointerdown、`error`/`unhandledrejection`，`?debug=1` 才显示）；脚本版本 `?v=4` → `?v=5`。
5. `_debug/_boot-sim.js`：新增流程 0d——把 `createTrack('attic')` 打桩成抛 `boom`，断言 ① localStorage 未被污染 ② `__DBG__.err` 含 boom ③ 恢复后能正常切换。（并做过变异测试：把 `switchTrack` 改回旧写法，该用例确实 exit 1。）

### 判定指引（用户侧，不需要 devtools）
- 右下角**没有** `build 5 · N tracks` ⇒ 侧边栏仍是旧缓存（要重开侧边栏而不是普通刷新）。
- 有该小字且 `N=1` ⇒ `trackList` 只有一条，脚本版本/顺序问题。
- 有该小字且 `N=2`，但切换仍无效 ⇒ 在 URL 后加 `?debug=1`，看左下角 `calls` 是否增长、`guard` 是否非空、`err` 内容。
- 名称变了但背景没变 ⇒ `scene.build` / `gl.setTrack` 抛错，看 `err`。

### 验证
- `node _debug/_boot-sim.js` exit 0（`[click] / [row-click] / [keyD] / [key] / [guard]` 五条全过）
- `node -e "require('./test/race.test.js')"` 6/6；`node _debug/_derail-probe.js` figure8 20/20、attic 20/20
- 仍未做：真实浏览器里点一次（本沙箱起不了浏览器）。

## 2026-10-28 第七轮：修「赛道重叠穿模 + 弯道不自然」

### 定位（量化，不是目测）
新增两个审计脚本，把用户截图里的问题变成数字：

- `_debug/_pinch-audit.js`：把中心线按 4px 重采样，用 128px 空间网格找**非邻域**（弧长距离 >150px）最近点对。
  改之前的结果：`11.4px / 25.7px / 40.9px / 55.8px` 共 5 处——最狠的一处中心线只差 11.4px，而路面宽 84px，
  等于两段路基几乎完全重叠（这就是用户看到的「穿模」）。位置集中在西侧 S 弯下坡的"腰"与扫掠道之间。
- 同一脚本的曲率剖面：改之前有 `r37 / r41 / r41 / r42` 的窗口，而护栏内壁在中心线外 45px、路肩内沿在 40px，
  **r<45 时内侧墙/路肩会自己折过来**（这就是「弯道不自然」的几何根因）。

### 改法
1. **形状重排**（`js/track.js` 的 attic `CMDS`）：把中段那条长扫掠道整体东移（`['F',78]` → `['F',145]`），
   把 S 弯下坡的腰从扫掠道旁边让开；发卡/回旋针与 U 弯半径 44–55 → 56–70；
   `L70/70 + R110/60` 段改为 `L70/74 + R110/62`，并在两个反向 90° 弯之间补短直道，避免样条在交接处收紧。
2. **闭合改求解而不是手调**：新增 `_debug/_turtle-solve.js`，把"底部东西向直道"和"东侧南北向直道"当未知量，
   利用两段正交、互不影响的性质，迭代一次就能把终点精确拉回起点（gap = 0.0000）。
   这解决了我之前手调 `F` 长度时闭合差 3px、导致起点处多出一个假自交的问题。
3. **fairing 加强**（`buildTurtlePoints`）：2 遍 0.1 → 3 遍 0.12，磨掉线/弧交接的局部曲率尖峰
   （2px 重采样下对标准圆弧的半径影响 <1%）。
4. **桥体装饰修正**（`js/gl.js`，这是真正的 bug，不只是观感）：
   - 黄护栏/桥墩的循环用的是**绝对弧长** `s ∈ [-railSpan, railSpan]`。8 字环道的 `sCenter=0` 恰好正确，
     但阁楼赛道的桥面平段在 `sCenter≈330`，于是护栏被画到了起点直道和右上弯道（那里高程为 0）——错位。
     改为以 `track.bridge.sCenter` 为中心：`s ∈ [sc-railSpan, sc+railSpan]`。
   - 黄护栏原来是每 5px 一个立方体，弯道上外沿弧长 > 立方体长度，**沿外侧拉出梳齿状缝隙**。
     改成和护栏墙同一套 `pushQuadStrip` 连续条带（内侧立面 + 顶面 + 外侧立面）。
   - 桥墩逐根判定：若落点距离"非本桥路段"的中心线 < `halfW + PIER_RADIUS + 2`，跳过——否则桥墩会从
     下层路面里长出来。阁楼赛道因此跳过 4 根（正好是桥下穿越口的支点），留出通行断面。
   - 桥下投影原来是一块固定在原点的 200×140 平面（对阁楼完全错位），改为沿平段 ±(halfLength+20) 铺的条带。

### 结果
- 中心线非邻域最近距离：11.4px → **100.9px**（地面段之间）；其余 32–83px 的几处全部是「桥面压在地面段上方」
  的穿越段，靠 36px 高差分开。
- 最小半径：37px → 47px（仅 6px 长的过渡点），持续弯半径 ≥53；弯道内侧不再折墙。
- 包围盒 888×566（改前 866×568），仍在固定机位取景内；总长 3689px。
- governed bot：3 圈 19.47 / 19.47 / 19.47s，0 脱轨（改前 20.33s）；全油门 3 圈 80 次脱轨（技术赛道，符合设计）。
- `node --test test/race.test.js` 6/6；`_derail-probe attic` 20/20；`_boot-sim` 全流程通过。

### 未完成
- 3D 实机最终观感没能在本轮确认：浏览器面板进入后台后 `document.visibilityState === 'hidden'`，
  rAF 停摆、`screenshot` 一律 `surface preparation timed out`。本轮只在改形状**之前**拿到过全赛道 3D 截图
  （确认包围盒不越界）。护栏条带与桥墩避让由 `_debug/_bridge-audit.js` 俯视校验 + 复用已验过的 `pushQuadStrip`，
  但仍建议人工开一次浏览器看一眼桥面。

## 2026-10-28 第八轮：修「地图不在画面中」（3D 静默回落 2D + 2D 取景错位）

用户截图里赛道只剩下左上角一小截、地面木板是直角网格没有透视、路面没有路肩和护栏——
这不是 3D 场景，是 **2D 兜底路径**。两个独立缺陷叠在一起：

### 缺陷 A：`RaceGL.create` 抛错，整局被静默降级到 2D
- 第七轮清理未用变量时把 `var off` 从 `buildBridge` 的声明里删了，但桥墩循环仍在
  `off = halfW * sides[si];` 赋值。`gl.js` 顶部是 `'use strict'`，于是抛
  `ReferenceError: off is not defined`。
- `main.js` 的 `try { gl = RaceGL.create(...) } catch { gl = null; }` 把异常吞掉，
  画面照常跑（2D 兜底），所以看起来"游戏正常，只是地图不对"。
- 修：`var off` 补回循环内；`main.js` 失败时 `console.error` + 写 `window.__DBG__.glError`，
  不再静默。

### 缺陷 B：2D 兜底的赛道层没有平移到画布中心
- 赛道点与车辆坐标的原点在**赛道中心**（坐标有正有负，如 x ∈ [-422, 466]），
  而 `scene.js` 的画布是 0..1280 / 0..720。`drawTrack` / `drawSlots` / `drawSeams` /
  `drawStartLine` 都直接用原始坐标画，于是只有"正坐标象限"那一块落在画布内——
  正好是用户截图里左上角那一截。地毯/地板是按画布坐标居中画的，所以背景看着正常，
  更掩盖了这一层错位。
- 两条赛道都有这个问题（figure8 也是原点居中），属于长期存在、只在 WebGL 不可用时
  才暴露的缺陷。
- 修：`js/scene.js` 的赛道层整体 `translate(W/2, H/2)`；`js/render.js` 的车辆绘制用
  同一个平移量（新增 `ORIGIN_X` / `ORIGIN_Y`）。两处必须同源，否则车会离开路面。

### 顺带修掉：`gl.setTrack` 根本不存在
- `api.setTrack` 挂在模块对象 `RaceGL` 上，而 `api.create()` 返回的对象里没有它。
  `main.js` 用 `if (gl && typeof gl.setTrack === 'function')` 守卫，条件永远为假——
  **切换赛道时 3D 场景从来不会重建**，只是名字和 2D 底图变了。
- 修：把 `setTrack` 抽成局部函数，同时挂到 `RaceGL.setTrack` 和 `create()` 返回对象
  （后者会同步 `gl.track`），返回对象另外补 `trackGroup`。

### 新增的回归网（这次的两个缺陷都能被它们拦住）
- `test/gl-scene.js` + 测试用例 7：用最小 THREE 桩真正跑 `RaceGL.create` 与 `setTrack`。
  gl.js 的严格模式错误、`setTrack` 缺失、`setTrack` 不重建（按顶点数变化判定）全部会失败。
  已做变异测试：把 `off` 改回未声明 → 用例报 `ReferenceError: off is not defined`；
  把返回对象的 `setTrack` 删掉 → 用例报「缺少 setTrack」。
- 测试用例 8：两条赛道按画布中心平移后，连同路肩余量必须完整落在 1280×720 内。
- `_debug/_gl-smoke.js` 是同一套 harness 的命令行壳。
- 脚本版本 `?v=6` → `?v=7`。

### 验证
- `node --test test/race.test.js`：8/8（新增两条）
- `_boot-sim` 全流程通过；`_gl-smoke all` 两条赛道通过
- `_derail-probe` figure8 20/20、attic 20/20；`_pinch-audit` 与 `_bridge-audit` 数字不变

### 仍未完成
- 浏览器实机确认（本轮会话的 IAB 面板进入后台后 `document.visibilityState === 'hidden'`，
  rAF 停摆、`screenshot` 全部 `surface preparation timed out`，后续连标签页都被回收）。
  请强制刷新（脚本已升到 `?v=7`）后确认：① 是 3D 透视画面 ② 有灰色护栏与红白路肩
  ③ 切换赛道后 3D 赛道跟着换。若又变成平面无透视画面，看控制台是否有 `[RaceGL]` 报错。

## 2026-10-28 第九轮：移动端左右半屏油门

### 交互
- 比赛阶段（countdown / running）：`pointerdown` 按 `clientX` 与窗口中线比较，左半屏 → P1、右半屏 → P2，`input.setTouch(i, true)`；`pointerup` / `pointercancel` 释放；`pointermove` 允许手指从一半划到另一半（释放旧区、按住新区）。
- 多指：`pointerId → zone` 映射，第二根手指不再被 `isPrimary === false` 挡掉（旧代码会挡）。
- 标题 / 结算界面：触摸或笔点按任意处 → `startRace()`；鼠标点击维持旧行为（只聚焦），避免桌面误触开赛。
- 失焦（`window blur`）、切后台（`visibilitychange`）、`startRace()` 开头都会 `releaseAllPointers()`，避免油门卡住。

### 改动文件
- `js/input.js`：新增 `touchHeld`、`setTouch(i, on)`，`get(i)` = 键盘 || 触摸；`clearAll()`/`destroy()` 一并清零。
- `js/main.js`：新增 `activePointers` / `touchHeld` / `zoneOfClientX` / `setZoneHeld` / `releasePointer` / `releaseAllPointers`；重写 `onPointerDown`、新增 `onPointerUp` / `onPointerMove` 并注册 `pointerup` / `pointercancel` / `pointermove`（捕获阶段）；`startRace()` 先清指针；`snapshot()` 增加 `portrait`；`__DBG__` 增加 `phase` 与 `zones`，`#dbg` 面板多一行 `zones=P1:x P2:y phase=…`。
- `js/render.js`：标题提示改为「手机：按住左右半屏加速」+「点击 / 点按任意处开始」；倒计时阶段底部加一行油门提示；新增 `drawPortraitHint()`，竖屏时在 `drawTitle` / `drawHUD` 末尾盖遮罩提示横屏。
- `styles.css`：`html, body` 加 `touch-action: none`、`overscroll-behavior: none`、禁选中/长按菜单；`#game,#hud` 加 `touch-action: none`、去点击高亮。
- `index.html`：viewport 加 `maximum-scale=1.0, user-scalable=no, viewport-fit=cover`，加 `mobile-web-app-capable`，脚本版本统一升到 `?v=8`。
- `test/race.test.js`：新增用例 9「触摸油门：setTouch 控制 P1/P2，clear 后全部释放」。
- `_debug/_boot-sim.js`：window 桩补 `pointerup` / `pointercancel` / `pointermove` 监听收集与 `dispatchPointer()`；新增流程 3：Esc 回标题 → 触摸点按开赛 → 左/右半屏、双指 `zones` 断言。

### 验证（实跑）
- `node --check js/input.js js/main.js js/render.js` 全部通过（分开跑，无输出）。
- `node _debug/_boot-sim.js` exit 0：`[tap-start] phase=countdown`、`[zone-left] down→1 up→0`、`[zone-right] down→1 up→0`、`[zone-both] 双指 [1,1] → 松开 [0,0]`，旧流程 `[click]/[row-click]/[keyD]/[guard]/[key]` 全部保留通过。
- `node -e "require('./test/race.test.js')"` **9/9**。
- `node _debug/_derail-probe.js` figure8 20/20、attic 20/20（物理未改动）。

### 已知限制 / 待办
1. 移动端没有暂停 / 重开 / 回标题的屏上按钮，仍靠键盘（P / R / Esc）。
2. 竖屏只提示不强制；16:9 竖屏黑边较大。
3. 桌面鼠标按住画面也会给对应半边油门（便于调试），P2 没有鼠标键。
4. 真机（iOS Safari / Android Chrome）未验证：localStorage 记忆赛道、iOS 双击缩放、多指同时按、转屏后 letterbox 需人工确认。

## 2026-10-28 第十轮：UI 风格定调 + 屏上按钮（桌游纸卡）

### 风格决策（先调研后拍板）
- 调研结论（详见对话）：赛车 HUD 通行原则「少而靠边、不遮赛道」；cozy/桌游风典型语言是
  重圆角药丸 + 暖色低饱和 + 纸/木手作框架 + 低压力微交互；移动端硬指标 44pt/48dp 触控目标、
  拇指弧布局、避开安全区。候选 A 桌游纸卡 / B Art-of-rally 扁平极简 / C Hot-Wheels 塑料街机，
  用户选 **A**。A 的优势：与阁楼场景同源（UI 即玩具套装的一部分），现有 HUD 已是该语言 70%，
  补完而非重画。
- 令牌（render.js 顶部）：CHIP_H=44（触控下限）、圆角 12、描边 2.5、硬投影偏移 4（无模糊、
  实色 rgba(43,35,32,.35)）、主操作木色面 / 次操作纸面；颜色全部取自场景已有六色。

### 实现
- **render.js**：
  - `uiHits` 命中注册表：drawTitle / drawHUD 每帧 `uiBeginFrame()` 重建，`registerUI(id,x,y,w,h)`
    记录，导出 `hitTestUI(x,y)`（从最上层往回找）。箭头命中框走原有独立路径不动。
  - `drawChip`：实色硬投影 + 墨描边圆角面，按下整体下沉 3px、投影间隙收成 1px（像按积木）；
    图标为手绘矢量（暂停双竖条、喇叭+弧线/斜杠），不引外部素材。
  - 各阶段按钮：比赛 ⏸(828,24,46,44) + ♪(884,24)；暂停面板 继续/重开/回标题（560×240 纸卡）；
    结算面板加高 440→470，底部 再来一局/回标题；标题右上 ♪。
  - 竖屏遮罩可关闭：注册全屏 'portraitDismiss'（最后注册=最上层，第一要点掉遮罩），
    `s.portraitHint === false` 时不再绘制；main 转屏（resize）后重新评估。
- **main.js**：
  - `onPointerDown` 最先查 `hitTestUI`——比赛里点芯片不会变成半屏油门，标题里点喇叭不会开赛；
    `pressedPointers`（pointerId→按钮 id）驱动按下高亮，随 pointerup/cancel 释放。
  - 键盘路径重构：`togglePause` / `backToTitle` / `toggleMute` 同时服务 P/Esc/M 与屏上按钮。
  - 静音持久化：`slotrace.muted`（'1'/'0'），init 恢复、toggle 写入。
  - snapshot 增补 `muted` / `pressed` / `portraitHint`；`__DBG__` 增 `muted`、`ui`（最近一次按钮 id）；
    build 标记 5 → 9。
- **回归**：race.test 用例 10（各阶段命中区 + 芯片外 3px 不命中 + 遮罩优先级 + 关闭后恢复）；
  boot-sim 流程 4（静音持久化/取消、暂停芯片不注入油门 zones 保持 [0,0]、继续、回标题）。
  变异验证：删掉 `registerUI('pause',…)` → 用例 10 报「暂停芯片中心应命中」。
- `node --test` 10/10；`_boot-sim` 全流程（含流程 4）通过。脚本版本 ?v=8 → ?v=9。

### 仍未完成
- 结算页按钮在真机/实机上只被 boot-sim 的逻辑断言覆盖（快速到 finished 需 ?ff，boot-sim
  单页沙箱没法二次加载；race.test 用例 10 已覆盖注册与命中）。
- 3D 实机观感（纸卡芯片叠在 3D 画面上的层次、阴影观感）仍需人工看一眼。

## 2026-10-28 第十一轮：开始界面改版（赛道预览 + 主操作按钮 + 键帽行）

### 参考（联网调研）
- Game UI Database 的通用模式：主操作（开始/继续）放第一层级最显眼处，标题是视觉锚点，
  次要选项下沉；racing UI 的赛道选择通行模式是「大预览图 + 名称/统计卡」
  （[Game UI Database](https://www.gameuidatabase.com)、[A Brief Guide to UI in Video Games](https://uiux.studio/blog/game-ui-design-guide)、
  [rally track select 参考](https://in.pinterest.com/pin/289637819760451512)、[race UI 集合](https://www.pinterest.com/dragonmen/race-ui)）。
- 同类型顶视玩具赛车 Circuit Superstars 证明「玩具感 + 干净菜单」成立。

### 改版内容（仍走桌游纸卡语言）
- 纸卡 760×330 → 900×470：左列 330×196 **赛道预览缩略图**（毯红底 + 墨描边 + 缩放路基带
  + 起点双白线，从 track.points 实时缩放，两条赛道形状一眼可辨）；右列选择器 ◀名称▶（字号加大）
  + 三张统计小卡（总长 px / 弯道数 / 存档最佳圈）。
- 主操作：木色「开始比赛」280×56 大按钮（registerUI 'start'），`Enter` 与点按任意处仍是同义路径；
  原呼吸闪烁文本删除。
- 键位提示压成卡下方两行**键帽行**（drawKeyRow / drawKeycap，圆角小块 + 墨描边），
  不再与标题/选择器抢层级；静音芯片位置不变（右上角 1210..1256, 20..64）。
- 选择器整行命中收窄到选择器附近（leftCx-64 .. rightCx+64）：左侧现在是预览卡，
  整行命中不再横向铺满卡片，避免误触语义混乱。

### 连带修正
- `_boot-sim` 流程 0/0b 原来写死 `(x,368)` 扫描与 `(900,368)` 整行点击——布局改版后全失效。
  改为动态扫描：先在 y∈[290,420] 扫右箭头命中框，再扫「非箭头框但行命中返回 right」的点。
  过程中定位到一个测试脆弱性：流程 0b 原来用 `hitX+108`，该偏移对 5 字赛道名恰好落在行内、
  对 4 字名就出界（行 maxX = rightCx+64，随名称宽度变化）——动态扫描后与布局解耦。
- main.js `runUIAction` 增加 'start' 分支（title/finished 才生效）；build 标记 → 10。
- race.test 用例 10 增加开始按钮命中断言（640,536 → 'start'）。
- 脚本版本 ?v=9 → ?v=10。

### 验证
- `node --test test/race.test.js` 10/10；`_boot-sim` 全流程（含新的 [ui-start]）通过；
  `_gl-smoke` 两赛道通过。

## 2026-10-29 第十二轮：反馈层（手感 × 音效交集）

### 动机
核心戏剧点是「贴极限 → 松油救车 → 没救住甩出」，但反馈链断裂：判断依据在 HUD 抓地条
（视线在车上看不到），等 boom 响已脱轨。audio.js 里 beep(freq) 写好却无人调用。

### 改动
- **audio.js**：
  - `engine(i, speed01, warn01)` 新增第三参：每玩家引擎加一条 square 谐波"预警层"
    （频率 = 引擎基频×2.01，增益 = warn01×0.022）——黄区起步、越贴极限越尖；
    setMuted/destroy 同步覆盖预警节点。
  - `click()`：1250Hz 50ms triangle tick（纸卡芯片按下）。
  - `save()`：440→660 triangle 上行双音（比过圈 chime 660→990 sine 低而钝，音色可区分）。
- **main.js**：
  - `countdownSounds()`：与画面同一阈值（COUNTDOWN_GO=0.8）——3/2/1 各一声 440、
    GO 一声 990，按档变化沿触发（cdSound 档位状态，startRace 复位）。
  - `saveFeedback()`：saveWindow（超限且已松油）进入即"武装"，gripUse 回落 <1 的那一刻
    播 save()；脱轨清除武装（boom 已负责该时刻）。每步在 step 主循环里逐车跟踪。
  - `engineSounds()` 传 warn01 = clamp((gripUse-0.75)/0.75)（黄区 0→红区渐满）。
  - 屏上按钮按下时 `audio.click()`。
- **boot-sim**：AudioContext 桩升级为"录音"——osc.start(t) 记 {freq,t,type}（t 为数字 =
  定时音，undefined = 引擎持续音）；流程 5 断言倒计时 440×3 + 990×1、芯片 1250 tick。
- **race.test 用例 11**：Node 桩 AudioContext 断言 engine 建本体+预警两条持续振荡器、
  beep/click/save 入队频率正确、**muted 期间零新增**（门控）、解除后恢复。
  注意：ctx 惰性创建，测试需先 audio.resume()。

### 验证
- `node --test` 11/11；`_boot-sim` 全流程（含流程 5 [sfx-countdown]/[sfx-click]）通过；
  `_gl-smoke` 两赛道通过。物理零改动，_derail-probe 不需重跑。
- 脚本版本 ?v=10 → ?v=11；build 标记 → 11。

### 仍未完成
- 预警音的"好听度"需真机听：square×2.01 的粗糙感是否刺耳、warn 增益 0.022 是否够/过；
  参数都在 audio.js 顶部附近，好调。
- 真机移动端验证（历轮挂起）：iOS Safari 双指、切后台、转屏、音频解锁时机。

## 2026-10-29 第十三轮：重做引擎声与轮胎摩擦声（用户反馈：无紧张感）

### 诊断
上一轮的"预警"是 square×2.01 方波层——本质是报警器音，与赛车语言不符；引擎是单锯齿过
320Hz 低通——闷且单薄。联网调研（sfxengine 过程化音频、Velocity Unleashed 实时引擎合成
案例、 DSP 帖"车轮辐条 playing card"类比、锯齿失谐拍频技法）得出两个标准配方：
- 引擎：**双锯齿微失谐**（≈12Hz 拍频加厚）+ 带宽随速度开合的低通 + LFO 浅调幅颤感
- 极限预警 = **轮胎摩擦声**：循环白噪声 → 高 Q 带通（1–4kHz）→ 中心频率 LFO 抖动

### 改动（audio.js）
- 每玩家引擎组：sawA + sawB（×1.007 失谐）→ lowpass（380 + s×1500，Q2.2）→ gain(0.05)；
  24Hz LFO 经 depth 节点对 gain 做浅调幅（怠速颤感）。
- 每玩家摩擦组：循环白噪声 → bandpass（中心 1800 + warn×1600，Q4.2，7.5Hz LFO 抖动
  深度 320 + warn×160）→ screechGain（warn × (0.10 + 0.05×speed)）。
- engine(i, speed01, warn01) 驱动全部节点；warn01 在 main 里取
  max(抓地需求 warn, 实际侧滑 slip/0.85)——真滑出瞬间摩擦声立即拉满。
- setMuted 归零全部常驻增益（含两条 LFO 深度——AudioParam 连接是叠加的，不归零会漏音）；
  destroy 相应清理。ENGINE_GAIN 0.03→0.05、基频 55→62（原声偏闷偏小）。
- 上一轮的 square 预警层整体移除。

### 验证
- race.test 用例 11 更新：断言 4 条持续振荡器（双锯齿+两 LFO）+ ≥1 循环噪声源，
  静音门控不变；11/11。boot-sim 流程 5（倒计时/点击音）不变通过；gl-smoke 通过。
- 脚本版本 ?v=11 → ?v=12。

### 待真机
- 音色参数纯理论值：拍频 12Hz、摩擦声 Q4.2、wobble 7.5Hz、峰值增益 0.14——需要实机听感
  校准；全部集中在 audio.js 顶部常量与 engine() 驱动段。

## 2026-10-29 第十四轮：引擎声克制化 + 预警声换胎噪（用户反馈：太大/突兀）

### 反馈 → 改法
1. 「引擎声太大、按下油门才响」：
   - 增益上限 0.05 → 0.038，且 **gain = 上限 × 油门行程**（engine 新增第 4 参 throttle01）——
     不踩不响，踩多少响多少，油门 0.3s 行程自然带出音量渐入。
   - LFO 调幅深度同步 ×油门；setMuted 的恢复分支改为归零（实际音量由 engine() 每帧按油门写）。
2. 「过弯预警太突兀」：
   - 高 Q 啸叫（1800–3400Hz、Q4.2、峰值 0.14）整层换掉 → **低 Q 胎噪**（850–1500Hz、Q1.1、
     峰值 0.05，中心频率仍随 warn 抬升 + 抖动减弱）。
   - 预警量阈值从 0.75 提前到 **0.55** 渐入（黄区之前就低声存在，不搞突然进场）。
   - main 端新增**非对称指数平滑**：0.18s 快攻 / 0.4s 慢放（warnSm[2]），侧滑瞬间不再阶跃。

### 验证
- race.test 用例 11 补油门参数；11/11；boot-sim 流程 5 与全流程通过。
- 脚本版本 ?v=12 → ?v=13；build 标记 → 12。

### 待真机
- 引擎上限 0.038 / 胎噪峰值 0.05 / 平滑常数（0.18/0.4）/ 渐入阈值 0.55——都等实机听感再校。

## 2026-10-29 第十五轮：去"滴滴"脉冲 + 灰尘尾迹

### 1. 过弯"滴滴"声的根因与修复
- 根因：摩擦层的 7.5Hz LFO 在带通中心频率上做 ±抖动——噪声被调制成每秒 7.5 次的
  脉冲节奏，听感就是"滴滴/突突"。且峰值 0.05 在持续过弯时一直存在。
- 修复：**整条频率抖动 LFO 移除**（bpLfo/bpLfoDepth 节点删除）；带通改为
  750–1300Hz、Q0.9 的纯宽频"沙沙"；峰值 0.05→0.035、攻角时间常数 0.12→0.15/0.18。
  save() 从双音改单音轻点（520Hz、0.08 增益 0.08）——弯道里频繁出现不抢戏。

### 2. 灰尘尾迹（克制版）
- 条件：打滑（slip>0.3）或起步烧胎（油门>0.85 且速度<150）；每车 80ms 一粒；
  生命周期 0.5–0.8s；尺寸 3.5–6 起步、随龄放大 ~2 倍；向车尾漂移并受阻尼。
- **双实现**：
  - 2D 兜底：render.js 尘粒池（上限 56），画在底图之上、车辆之下（世界坐标 + ORIGIN 平移）；
    `dustStats()` 供测试。
  - 3D：gl-cars.js 每车 16 片 CircleGeometry 地面圆片池（共 32），贴地 elev+0.6，
    材质独立（逐粒 opacity），depthWrite 关；attach 的 render 包装里以 dt 驱动。
- race.test 用例 12：打滑 1s 场上有尘、封顶、停滑 2s 归零；用例 11 更新
  （bpLfo 移除后持续振荡器 4→3）。

### 验证
- node --test 13/13；boot-sim 全流程 + gl-smoke 通过。脚本 ?v=13 → ?v=14；build 标记 → 13。

### 待真机
- 尘粒大小/透明度（0.32 峰值）、发射率（80ms）是否克制；胎噪峰值 0.035 与攻角 0.18s 听感。

## 2026-10-29 第十六轮：车模精修（程序化）+ 导入模型评估

### 用户问题：直接导入玩具车模型怎么样？
调研结论（poly.pizza/Quaternius、Kenney 均为 CC0 GLTF——授权不是障碍）：
- **file:// 是硬障碍**：GLTFLoader 走 fetch，双击打开的页面被同源策略拦死。出路三条：
  本地服务器（破坏双击即玩）/ 浏览器安全旗标（不现实）/ GLB 转 base64 内嵌 +
  `GLTFLoader.parse()`——但 r149 的 three.min.js 核心不含 GLTFLoader（examples/js 已移除），
  需改 ESM 加载或自写迷你 GLB 解析器，外加轴向/尺度归一化与体积 +33%。
- 收益存疑：车在画面里约 40 逻辑像素，网格细节大多不可见；「无素材文件、无构建步骤」
  是项目卖点。
- 结论：**现阶段不导入**。将来若要：Kenney Car Kit / Quaternius CC0 GLB → 离线烘成
  内嵌 JS 数组 → 自写 ~150 行迷你解析器（DataView 读 JSON+BIN chunk → BufferGeometry），
  file:// 安全。工作量约一天，作可选升级路径。

### 本轮实施：程序化车模精修（makeCar 重写，零素材）
- 车身保留原尺寸占位（物理对齐不变），新增细节件：
  引擎盖（-0.10 rad 下斜）+ 米白赛车条纹、后仰风挡（0.42 rad）、座舱玻璃带 + 米白车顶、
  浅色轮毂（比胎宽 0.8 端面可见）、两侧侧裙、双色尾翼（P1 更高更大 + 支柱）、
  P2 保留车头楔形。全部平面着色（flatShading）。
- 材质收敛为 5 个共享实例（paint/dark/cream/tire/hub），traverse 收集不受影响。
- 回归网：test/gl-scene.js 的 THREE 桩补 userData/traverse/CircleGeometry/getWorldPosition，
  冒烟流程加载 gl-cars.js 并 attach——makeCar 的全部几何/材质调用与「车 Group ≥8 子件」
  断言进回归（此前 makeCar 只在浏览器里跑过，桩测试零覆盖）。
- 脚本版本 ?v=14 → ?v=15。

### 验证
- node --test 13/13；_boot-sim 全流程；_gl-smoke all（含车模冒烟）通过。
- 视觉效果需人工确认（本沙箱无法截图 3D）：重点看引擎盖斜面/风挡仰角的比例，
  参数都在 makeCar 顶部的 box(...) 调用里，一句话可调。

## 2026-10-29 第十七轮：车模去方块 + 尾迹可见化 + 飞出反馈（用户截图反馈）

### 1. 车模"方块感"太强
- 车身/座舱/车顶/引擎盖/尾翼从 BoxGeometry 全部换成**圆角挤出平板**（roundedShape →
  ExtrudeGeometry，bevel 1.6/1.2/0.7 双面倒角，curveSegments 8）——圆角 + 倒角消灭直角棱。
  轮胎/轮毂/侧裙/车灯保持。车身占位不变（物理对齐不变）。

### 2. "车尾的轨迹看不到效果"
- 根因：此前只在打滑/烧胎时发射——巡航时完全没有尾迹。
- 改为**三档**：巡航（速度 >40）每 90ms 一粒淡尘（峰值透明度 0.15、寿命 0.8–1.1s）——
  车尾拖尾常态可见；打滑/烧胎每 55ms 浓尘（0.42）；**脱轨落地瞬间炸一圈 6 粒尘爆**。
  尘色提亮（224,210,180）；上限 56→72。2D（render.js）与 3D（gl-cars.js，池 16→20/车）同步。

### 3. 飞出去的手感（调研：Steve Swink《Game Feel》/ juiciness 清单——镜头震动、落地
粒子、音效构成冲击反馈，但需校准避免过火）
- **镜头震动**：gl.js 新增 `api3d.shake(power)`——render 每帧在固定机位上叠加随机偏移，
  幅度 ×0.86 指数衰减。main 在 saveFeedback 循环里检测两个沿：**脱轨瞬间 shake(9)**、
  **落地瞬间（derailT 越过 FLY_GUARD=1.7）shake(5)**。2D 兜底无相机，自然忽略。
- 物理参数（弹起速度/翻转/停留时长）本轮未动——先上反馈层，实机玩过再校物理。

### 修复
- gl.js：shake 曾误写为 `api3d.shake = …`（api3d 尚未赋值，运行时必炸）——改为函数声明 +
  字面量挂载，并用脚本断言次序。
- test/race.test.js：用例 12 曾被重复追加两份（node:test 跑了两遍同名用例）——去重后
  改为三段式断言（打滑扬尘 → 巡航淡拖尾 → 停车归零）。

### 验证
- node --test 12/12；boot-sim 全流程；gl-smoke（含 ExtrudeGeometry/Shape 桩）通过。
- 脚本 ?v=15 → ?v=16；build 标记 → 14。

### 待真机
- 震动幅度（9/5，衰减 0.86）与尾迹密度（90/55ms）是手感参数，实机玩了再校。
- 车模挤出圆角的比例（圆角 9 / 倒角 1.6）需人眼确认。

## 2026-10-29 第十八轮：首次真机手感测试（CDP 遥测 + 实机截图）

### 方法
- 新增 `_debug/_feel-cdp.js`：Node 24 内置 WebSocket 直连本地 Chrome（headless=new，
  1280×720，AMD 780M / D3D11 ANGLE，约 220–240fps，p95 4.3–4.4ms），`Page.addScript-
  ToEvaluateOnNewDocument` 注入探针：每帧车辆遥测（速度/油门/slip/gripUse/脱轨计时/圈数）、
  相机相对 BASE 机位位移、`gl.shake` 调用、rAF 帧耗时；两种自动油门：`auto`（按刹车距离提前
  收油）与 `lift`（gripUse 阈值松油）。命令：`node _debug/_feel-cdp.js baseline|auto|lift|snap
  attic|figure8 [秒]`，结果写 `_debug/feel-*.json` / `feel-snap|zoom-*.jpg`。
- `LIVE=1` 关闭冻帧再截图：冻帧页 game time 不走，dt=0，尘粒不生长也不漂移，截图会低估
  尾迹（本轮踩过的坑）。

### 发现（实测，非估算）
1. **全油门阁楼**：每 1.5–2.0s 脱轨一次（P1 el 2.13 / 4.58 / 7.33 / 10.53），脱轨速度
   293–361，slip 0.24–0.37，最大 offset 6–10；HUD 红警到脱轨仅 **0.10–0.20s**。
2. **松油救不回**：gripUse 阈值 1.0 / 0.55 / 0.35 三档，阁楼均每圈 3 次脱轨；同脚本 figure8
   在 0.55 阈值下 **0 脱轨**（3 圈 24.91s，8.76/8.07/8.07）。根因：THROTTLE_FALL=8.33/s
   （0.12s 才落油）+ 救车刹车要等 car.throttle≤0.02 才生效，收油减速晚于 offset 累积。
   → 阁楼上的"松油可救"承诺兑现不了：要么改救车触发（按目标油门立即施加 SAVE_BRAKE）、
   要么改 HUD 文案，不要把可救窗口指给玩家。
3. **赛道公平**：按刹车距离提前收油的 autopilot，阁楼 3 圈 **44.23s**（15.15/14.55/14.53），
   0 脱轨，均速 250，slipPeak 0.18 → 弯道全部可通过，难在反应而非无解。
4. **震动衰减依赖帧率**：按帧 ×0.86，220fps 下 >1 世界单位只持续约 **0.05s**，几乎看不见。
   已改为按真实时间衰减（等价 60Hz 每帧 ×0.86），复测 0.15–0.19s；峰值相机位移
   5.3 世界单位 ≈ 720p 下 **4.5px**——持续时间和幅度仍是"轻"档，幅度是否上调待定。
5. **尾迹被埋在路面下**：尘片 y=elev+0.6，路面 y=1+elev，整轮第十七轮的尾迹一直被深度
   测试埋掉（品红染色 + depthTest:false 诊断确认渲染目标正确）。修为 y=elev+1.2。
   修复后实机 1x 仍只有 3–4px，故按固定机位投影重新定档：巡航 6–8.5 / 峰值 0.34 /
   1.1–1.5s / 70ms，打滑 8–11.5 / 0.5，落地爆 10–14，池 24/车；2D 同步。实机 1x
   已能看到淡拖尾（克制档）。

### 验证
- node --test 14/14；_boot-sim 全流程；_feel-cdp baseline/auto/lift/snap 复跑通过。
- 脚本 ?v=17，build 标记 15。

### 待定（需拍板）
- 救车窗口：改物理（目标油门触发 SAVE_BRAKE / 加快 THROTTLE_FALL）还是只改 HUD 文案。
- 震动幅度 9/5 是否上调（当前 720p 峰值约 4.5px）。
- 尾迹浓度是否符合"克制"预期，还是再浓一档。

## 2026-10-29 第十九轮：上坡俯仰反向修正（用户反馈）

### 现象与根因
- 用户："小车上坡时的动作不对"。
- 车头是 +X，绕 Z 正角才是抬头；而两处坡度俯仰都写成了 `-Math.atan(slope)`：
  - gl-cars.js syncCar：行驶中车身俯仰；
  - flight-physics.js 起跳初始姿态：绕 Z 轴的坡度分量同样反向。
- 实测（阁楼，冻帧）：上坡 s=151 处 slope=+0.257，车身 rotZ=-0.251（车头下压）；
  下坡 s=529 处 slope=-0.244，rotZ=+0.241（车头上扬）——两处都与预期相反。修复后
  同一位置分别为 rotZ=+0.251 / -0.239。

### 修复
- gl-cars.js：`pitch = Math.atan(slope)`，注释写明车头 +X / Z 正角抬头的约定。
- flight-physics.js：起跳初始俯仰改为 `+Math.atan(slopeRoot)`，与赛道系渲染一致
  （上坡甩出时车头朝上）。
- 轮底与坡面的贴合验算：绕地面原点转 atan(slope) 时前后轮心落点与坡面差约 0.2px，
  无需额外抬升；未改车身高度逻辑。

### 验证
- node --test 14/14；_boot-sim 全流程；_feel-cdp snap 复测上下坡 rotZ 符号正确。
- 截图：_debug/feel-zoom-attic-1.jpg（上坡抬头，航拍特写可辨）。
- 脚本 ?v=17 → 18，build 15 → 16。

## 2026-10-29 第二十轮：车模重制为玩具槽车（用户反馈：不要粗模）

### 需求
- 用户："接下来优化一下小车模型，往真实的玩具小车方向优化，不要粗模"。
- 约束：不改物理（刚体盒仍是 44×13×26，半高 6.5），file:// 可运行、零素材、零构建；
  车模仍是程序化 Three.js 几何。

### 方法
- 先给 `_debug/_feel-cdp.js` 加两种模式，用截图代替盲调：
  - `beauty`：冻帧后换成诊断相机，绕 P1 拍 `side/front/rear/top` 四视角；偏移按车身 yaw
    旋转（换赛道/朝向角度一致），crop 中心跟随车模 Group 的投影位置。
  - `inspect`：重置车模变换后用 `Box3().setFromObject` 逐子件打印 type/geometry/颜色/包围盒，
    用来量 bevel 外扩、翼子板穿插这类看不见的问题。
- 每改一轮：`node --test` + 重拍 figure8/attic 近景 + `LIVE=1` 1x 实机截图对照。

### 车壳：从平板拼装改为一整块挤出轮廓
- 新增 `bodyShape()`（低鼻、长引擎盖、后置座舱、短尾的闭合侧面剪影）+ `bodyMesh()`
  （沿车宽 Z 挤出 depth 18 + 双面倒角 1.7×2 段 3 → 总宽 21.4）。
- 删除 `roundedShape` / `slab` 与原来的方块堆叠。车头/车尾、前后翼子板位置的圆角由挤出
  倒角一次做出。
- **bevel 外扩（本轮最容易踩的坑）**：`ExtrudeGeometry` 的 `bevelSize` 会把轮廓整体沿法线
  外扩 `BODY_BEVEL = 0.7`（实测 1.3 时车身 x 到 ±23.3、y 到 22.6）。第一版贴面件（风挡/条纹/
  圆标/车灯/保险杠）全按原轮廓高度摆，结果整批埋进车壳里"凭空消失"。改为所有贴面件按
  `BODY_BEVEL + 自身半厚` 抬升，车头车尾五金推到外扩后的表面（x≈22.95/23.1）。
- 风挡/后窗/条纹用 `slopedPanel()`（两点定方向、沿法线抬起）；侧窗是贴车身侧平面 z=±10.7
  的挤出玻璃带（外表面 10.72），中间加 B 柱。
- 车顶号码用 128×128 canvas 圆标贴片（米白圆 + 深色描边 + 84px 粗体字）。

### 细节件（全部顶到外扩后的表面）
- 头灯：镀铬圈 Cylinder(2.3/1.0) + 自发光灯泡；尾灯：深色底座 + 红色灯面（emissive）。
- 镀铬格栅 + 前后保险杠 + 双边排气；后视镜（支臂 + 镜盒）；引擎盖/尾箱米白双条纹。
- P1：整片米白车顶 + 1 号圆标 + 米白大尾翼；P2：车顶双条纹 + 2 号圆标 + 蓝尾翼 + 车头进气口。
- 尾翼改为**翼型截面沿车宽挤出**：此前"平板放平后再 rotation.z"会把迎角变成偏航；现在
  `rotation.z` 就是迎角，端板/支柱贴翼展两端。
- 车轮：轮胎 + 镀铬轮辋 + 中心盖，外侧面 5 条深色槽做五辐；`wg.rotation.x = π/2` 让
  圆柱轴沿 Z，同步时 `rotation.y += spin` 仍是滚动。**镀铬件不能高金属度**：没有环境贴图时
  metalness 0.9 直接发黑，收敛到 color 0xdfe4ea / roughness 0.22 / metalness 0.35。
- 翼子板迭代三次：① 椭球鼓包会穿进轮胎（黑胎上冒红碎片，已删除 SphereGeometry 用法）→
  ② 挤出弧形带：侧面像轮眉，但顶视是比轮胎宽的厚"肉套"，后翼子板还伸出车身 → ③ 最终
  **圆管弧 Torus**：radius 8.9 / tube 0.8 / arc π−0.9 / rotation.z 0.45 / scale.z 3.5
  （车宽方向约 5.6，比 6.2 的轮胎窄一圈，露出胎面），端头自然圆收，不再有厚切面。
- 风挡/后窗加一圈米白密封框（比玻璃大 0.25–0.28、法线方向低 0.09），玻璃像嵌在胶条里。

### 回归网
- `test/gl-scene.js`：删掉 SphereGeometry 桩，新增 TorusGeometry 桩；makeCar 的全部几何/
  材质调用仍走冒烟（车 Group 子件数断言不变）。

### 验证
- node --test 14/14。
- 截图（_debug/，未入库）：
  - figure8 `feel-car-figure8-{side,front,rear,top}.jpg`；attic 同四视角。
  - `LIVE=1` 实机 1x：`feel-snap-figure8-6.jpg` / `feel-zoom-figure8-6.jpg`——双车
    米白车顶 + 号码、红/蓝涂装、尾翼与轮组在实机尺度可读，翼子板收敛为细弧。
- 脚本 ?v=18 → 19，build 16 → 17。

### 待人工确认
- 翼子板管径/车宽缩放（0.8 / 3.5）、密封框厚度、轮辋槽数：都是观感参数，放一句话可调。
- 近景（beauty crop）细节已较完整；实机 1x 车长约 40–60px，主要靠剪影/配色/号码区分。

## 2026-10-30 第二十一轮：标题三选项菜单 + 教程/设置页 + 纸卡转场（用户需求）

### 需求
- 用户："接下来优化ui。我希望的效果：开始菜单：有开始游戏、教程、设置三个选项。
  沿用当前风格，但点击后可以增加转场效果增加趣味性，前提是风格统一"。
- 约束：纸卡风格不变、触控目标 ≥44、转场期间不误触、`file://` 可运行、零素材。

### 结构：一张纸卡，三页内容
- 新增 `menuView`（`menu` / `tutorial` / `settings`），三页共用 900×470 纸卡
  （`CARD_X/Y/W/H/R = 190/125/900/470/16`），只是页内内容不同：
  - 菜单页：左列赛道预览 + 右列选择器/统计，卡底并排「开始游戏」（木色主按钮，334,502,300×56）
    与「教程」「设置」两枚纸色次按钮（650/806, 504, 140×52）。
  - 教程页：标题「教程」，两栏「怎么开 / 怎么赢」，底部黄色提示条（脱轨/救车一句话），
    返回按钮（`menuBack`，560,520,160×48）。
  - 设置页：三行开关——音效、圈数（3/5 圈）、镜头震动（800, y292/366/440, 180×48），
    木色=开/选中；返回按钮同上。设置页不再画右上角静音芯片，避免与「音效」行重复。
- 纸卡底色不透明度 .94 → .97（.94 时桌面木纹透上来，字发灰）。
- 页内小件抽成 `drawCardShell` / `drawPageHeader` / `drawSectionTab` / `drawBulletList` /
  `drawCallout`，三页共用同一套描边、圆角、阴影和行距。

### 转场（render 只读时间戳算进度，main 负责时序）
- 换页：0.46s，旧页向左/右滑出（位移 `PAGE_SLIDE=1020`，旋转 ±0.05rad，透明度降到 0.35），
  新页从另一侧滑入；方向按 `MENU_ORDER`（menu 0 / tutorial 1 / settings 2）决定，返回菜单反向。
- 进入标题（含比赛结束回标题）：0.5s，纸卡从上方落下（dy 54→0、旋转 0.028→0、缩放 0.97→1、
  透明度 0.4→1）。
- 开始游戏：0.42s，纸卡向镜头推近（缩放 1→2.2、透明度 1→0、轻微反旋），结束后才 `startRace()`，
  所以点「开始游戏」到倒计时之间有 0.42s 的离场动画。
- 命中区注册门槛：`animP>=1 && enterP>=1 && !startFx`——转场中按钮既不可点也不闪 hover；
  转场中再点页面/按方向键被忽略（`showMenuView` 有 0.46s 冷却）。
- 右上角静音芯片作为"桌面固定件"在落桌/换页时也保持可点（设置页除外）。

### main.js 状态与持久化
- 新状态：`menuView`、`menuAnim {from,to,t0,dir}`、`startFx {t0}`、`menuEnter`（时间戳）。
- 新动作：`showMenuView(next)`、`beginStart()`、`setLaps(3|5)`、`setShake(bool)`；
  `backToTitle()` 重置菜单页并记 `menuEnter=time`。
- 设置读写在 init：`slotrace.laps`（3/5）、`slotrace.shake`（1/0），与 `slotrace.muted`、
  `slotrace.track` 并列；URL `?laps=` 仍可临时覆盖本局圈数。
- `tick` 里两个计时器到点即清：`startFx` → `startRace()`，`menuAnim` → null。
- `snapshot()` 增补 `menuView/menuAnim/startFx/menuEnter/settings`，便于测试与外部探针。
- 输入：菜单页 Enter/空格→开始、←/→→切赛道、M→静音；教程/设置页 Esc/Enter→返回菜单；
  开始转场期间吞掉全部标题输入；非标题阶段行为不变。

### 验证
- `node --test test/race.test.js test/gl-scene.js` → **13/13**。
  UI 用例覆盖：菜单三键命中、教程页只有返回/静音、设置页三开关与无角落静音、
  换页 0.1s 内不注册页内按钮（静音仍可点）、0.5s 后恢复、开始转场期间全部屏蔽、
  回标题落桌进行到 0.2s 时（time 1.2 / menuEnter 1）页内按钮不注册。
- `node _debug/_boot-sim.js` 全流程通过，新增 0e：真实点按教程/设置/三开关/返回，
  经 localStorage 验证音效 0→1→0、`laps 3→5`、`shake 1→0→1`（再开恢复默认）。
- 新增临时脚本 `_debug/_tmp-ui-shots.js`（headless Edge + 真实 PointerEvent）：
  按 `RaceRender.hitTestUI` 轮询按钮出现再截图，产出
  `_debug/ui-menu.png` / `ui-transition.png` / `ui-tutorial.png` / `ui-settings.png` /
  `ui-menu-5laps.png` / `ui-startfx.png` / `ui-after-start.png`；实机验证设置持久化与
  无控制台错误，最终 phase=countdown。
- 脚本 `?v=19 → 20`，build 17 → 18。

### 踩过的坑
- 无头软件渲染下游戏时间远慢于墙钟（dt 夹 0.05s），固定 `sleep(750ms)` 截不到稳定画面，
  截到过"设置页还停在菜单"——改为轮询 `hitTestUI` 等目标按钮注册后再截。
- 残留 Edge 实例/同步页会抢调试端口，`RaceRender` 变成 undefined——改用每次唯一端口、
  全新 profile、`--disable-sync`、target 过滤 `/index\.html/`，退出时 `taskkill /T` 杀进程树。
- 开始按钮现在先播 0.42s 转场再进 `countdown`，boot-sim 中所有"点开始后立即断言开赛"的
  流程都要多等 40 帧，坐标也从旧的 (640,536) 改为 (480,530)。
- 裸跑 `node --test` 会把 `_debug/_tmp-root-test.js`（10 月 26 日留下的 flight-physics 副本，
  已被忽略）也当成测试文件，计数会多 1；验证统一用显式文件路径
  `node --test test/race.test.js test/gl-scene.js`。

### 待人工确认
- 换页滑动的幅度/旋转（1020px、±0.05rad、0.46s）与开始推近（2.2 倍、0.42s）是否够"有趣但不闹"。
- 教程页两栏文字密度、设置页三行间距在手机横屏下的可读性。
- 「开始游戏」到倒计时的 0.42s 离场是否显慢；若嫌拖，可缩到 0.3s。
