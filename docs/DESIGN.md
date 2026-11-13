# dsh-boot-nexus 架构设计（评审稿）

> 版本：0.1.0 · 2026-11-09
> 状态：**评审稿，未安装、未替换、未修改 `dsh-boot-suite` / `dsh-boot-animation` 本体。**
> 工作区：`F:\dsh插件工作区\dsh-boot-nexus`
> 目标宿主：DSH desktop profile（Electron 44 / Node 24.21），同时兼容 Web profile。
> 致谢：本文讨论的两套引擎分别来自 [lxj5820/dsh-boot-animation](https://github.com/lxj5820/dsh-boot-animation) 与 [LeeRolling/dsh-boot-suite](https://github.com/LeeRolling/dsh-boot-suite)，均为作者开源；若你在用 nexus，请先去给这两个仓库点 ⭐。

---

## 1. 结论先行

两个插件不是"版本不兼容"，而是**同一时刻有两个主人**：

- 两个全屏层各自认为自己拥有 `z-index` 的最高值；
- 两套注入行各自往同一个 `index.html` 里塞运行时；
- 两个配置面各自认为自己是唯一真相；
- 两套计时器各自决定"什么时候该退场"；
- 两个插件都写了 `html` 锁 / `caption` / 媒体节点，后写者覆盖先写者。

合并的正确形态不是"把两份代码拼起来"，而是**收成一个宿主侧权威 + 一个浏览器侧运行时**：

- 宿主侧只做四件事：解析配置、生成 plan、注入**一套**行、提供受控资源路由；
- 浏览器侧只做四件事：一个根节点、一个状态机、一个时钟、一个媒体宿主；
- 旧插件在 profile 里必须禁用；nexus 检测到旧注入行时**主动让位**，而不是与它们竞速；
- 旧配置只读迁移一次，新文件 `$DSH_HOME/dsh-boot-nexus.json` 是唯一真相。

---

## 2. 冲突分析（带证据）

### 2.1 双全屏层

| 插件 | 选择器 | z-index | 证据 |
|---|---|---|---|
| suite | `#dsh-startup-root` | `2147483000` | `lib/host-startup.js:290-295` |
| animation | `.dshba` | `2147483647` | `src/boot-screen.js:174` |
| animation 屏保 | `.dshsaver` | `2147483647` | `src/screensaver.js:276` |

animation 恒盖住 suite。但 suite 的运行时并没有停：188 KB 的 `splash.js`、60 KB 的 CSS、音频与语音仍然加载并执行；suite 默认 `sound=true`、`voice=true`（`host-startup.js:76-81`）。用户看到的是 animation，听到的可能是 suite。

**后果**：视觉上"只有一个"，资源上"两个都在跑"，退出时两套 DOM 互相踩。

### 2.2 双锁 / 双根 / 双 caption

- suite 用 `html.dsu-lock` 锁滚动，`finish()` 无条件 `remove`（`lib/splash.js:3966`）。如果 animation 还开着，滚动锁被提前释放。
- animation 不锁 `document`，只靠 `.dshba { overflow: hidden }`。
- caption 被三方写：
  - suite：`#dsh-startup-caption`（`host-startup.js:305`）
  - animation：`CAPTION_CSS` + `style[data-dshba-caption]`（`boot-screen.js:106-107, 1012-1027`）
  - suite 壁纸：固定色（`client.js:2621-2624`）

三处都是 `!important`，后写者赢。没有仲裁者。

### 2.3 注入顺序不可控

`webserver/index-inject` 的行序就是**订阅者激活顺序**（`@deepseek-ai/dsh-host-webserver/lib/index.js:517-527`）：

- animation 在 `apply()` 里同步 `ctx.on(...)`（`entry.js:1585`）；
- suite 延迟到 `ctx.inject(['webServer'])` 才订阅（`host-startup.js:1252-1278`）。

所以 animation 的行永远在 suite 前面，且这个顺序**不是任何一方能配置的**。合并成一个 subscriber 后，行序由 nexus 自己的静态数组决定，才第一次变成可推理的。

### 2.4 三份配置真相

| 来源 | 位置 | 证据 |
|---|---|---|
| suite 启动屏 | `$DSH_HOME/dsh-startup.json` | `host-startup.js:22-23` |
| suite 壁纸 | `$DSH_HOME/chat-wallpaper.json` | `lib/index.js` |
| animation | settings 命名空间 `boot-animation`（= patch id），只有 `.volatile()` 字段投影 | `entry.js:16-37` |

改 nexus 的 insert id 会静默孤儿化 animation 的设置卡；旧值不迁移就会"看起来还在、实际不生效"。

### 2.5 定时器互斥

- suite：9 秒无条件兜底，到点 `remove` root、`remove` `dsu-lock`、置 `__DSH_STARTUP_FAILED__=true`（`host-startup.js:307-309`）。
- animation：`HOLD_MS=15000` 才显示提示，`ENDLESS_MS=20000`（`boot-screen.js:40`）。

9–15 秒之间会出现**两次退场**：suite 先拆，animation 后拆；中间露出内核卡或半成品 shell。

### 2.6 交接语义不同

只有 animation 有真正的交接条件：

```js
// boot-screen.js:349-351, 603-620
exitWhen = clipDone && failed === false && bootedAt !== null
```

suite 是纯时间线，iframe 另有 90 秒安全阀（`splash.js:2074`）。nexus 必须采用 animation 的语义，再加硬上限；否则"素材播完但 client 还没好"会露出半成品，或者"client 好了但素材没播完"被硬切。

### 2.7 路由命名空间冲突

- suite：`/dsh-startup/*`，约 40 条，其中 5 条 prefix（`/asset`、`/voice`、`/template-asset`、`/template-file`、`/template-frame`）。
- animation：`/plugins/dsh-boot-animation/*`。
- webserver 对重复 `(kind, path)` 直接 `throw`（`webserver:326-334`）。
- animation 曾因在 `/plugins/` 上开 prefix 吞掉 `/plugins/<pkg>/client.js`（`entry.js:1063-1070`）。

合并后必须换独立前缀，且**只对媒体目录开 prefix**，其余全部 exact。

### 2.8 资源写入 `node_modules`

animation 的 `/optimize` 原地改 `node_modules` 里的素材（`entry.js:1230-1296`，`remux.js:356-373`），`/reveal` 直接 `spawn explorer`（`entry.js:1324-1371`）。这两个能力在 nexus 中**移除**：素材池改到 `$DSH_HOME`，宿主不写安装目录。

### 2.9 inject 并集

- suite：`inject=['webServer','connection']`，路由用 `connection.requestRejection` fail-closed，缺 `connection` 时全 403（`host-startup.js:357-391`）。
- animation：只 `['webServer']`。

nexus 取并集 `['webServer','connection']`。这是安全取舍：宁可路由 403，也不做无鉴权的同源资源服务。

### 2.10 桌面注入通道的两条路径

桌面不走 `file://`，也不走 `tapIndex`，而是：

```text
Host collectIndexInjections()
  → dsh-desktop-host/lib/index.js:346
  → preload dshDesktopBoot.ready()
  → 前端 UZ() 逐行应用
  → new AppWebEntry
```

关键事实：

- `kind:'html'` 行用 `insertAdjacentHTML`，其中 `<script>` **不执行**（suite `host-startup.js:1210-1216` 实测）。
- `kind:'script'` 行用 `createElement` + `textContent`，内联脚本**会执行**（Desktop Engineer 读 dist 确认）。
- `script-src` 失败会导致整页 `Failed to load plugins`；`script-preload` 被 UZ 忽略。

所以 suite 注释里"桌面不能用内联脚本"只对 **html 行**成立；nexus 用 **`kind:'script'` 行**，自包含、无网络单点、根节点由 JS 创建，避开 html 行的问题。

---

## 3. 系统架构

```text
┌──────────────────────────── Host (Node) ────────────────────────────┐
│                                                                    │
│  src/index.js  (composition root)                                  │
│    ├─ config.js      唯一 schema / 迁移 / 原子写                    │
│    ├─ assets.js      媒体 allowlist / MIME / Range                  │
│    ├─ rows.js        4 行注入（style + 2 global + 1 script）        │
│    └─ routes.js      boot.js / plan.json / health / config / media  │
│                                                                    │
│  ctx.on('webserver/index-inject')  ← 只订阅一次                     │
│  webServer.register(...)           ← 一个 disposer 数组逆序释放     │
└───────────────┬────────────────────────────────────────────────────┘
                │  index rows（web: HTML；desktop: IPC 结构化行）
                ▼
┌──────────────────────────── Browser ────────────────────────────────┐
│                                                                    │
│  #dbn-root  (唯一全屏层, z-index 2147483000)                        │
│    ├─ #dbn-stage    片头 / 屏保媒体                                 │
│    ├─ #dbn-veil     黑幕与淡出                                      │
│    ├─ #dbn-chrome   caption / 跳过按钮                             │
│    ├─ #dbn-saver    屏保层                                          │
│    └─ #dbn-diag     诊断 HUD（?dbn=diag）                           │
│                                                                    │
│  core/fsm  ← 唯一状态机        clock ← 唯一 setTimeout/rAF 袋       │
│  media host ← 唯一 video/image 工厂   stage ← 唯一 DOM 写者         │
└────────────────────────────────────────────────────────────────────┘
```

### 3.1 模块划分

| 层 | 模块 | 职责 | 对外接口 | 测试面 |
|---|---|---|---|---|
| 核心控制层 | `src/runtime/10-fsm.js` | 状态、不变量、超时裁决 | `dbnCreateBootMachine({deadlines, now})` → `send/on/snapshot` | 纯函数，假时间驱动 |
| 核心控制层 | `src/runtime/20-clock.js` | 唯一 timer/interval/rAF 袋 | `dbnCreateClock(win)` → `after/every/frame/dispose` | 假 timer 计数 |
| 动画渲染层 | `src/runtime/30-media.js` | 选片、video/image 适配、autoplay 降级 | `dbnCreateMediaHost(doc, clock, plan)` → `create/mount/stop` | 假 DOM video |
| 动画渲染层 | `src/runtime/40-stage.js` | 唯一 root、锁、caption、phase、屏保层 | `dbnCreateStage({doc,win,clock,plan})` | 假 DOM 断言节点数 |
| 动画渲染层 | `src/runtime/50-boot.js` | 门控、编排、clientReady、交接、屏保 | `dbnBootMain(win, doc, options)` | vm + 假 DOM 全流程 |
| 配置解析层 | `src/host/config.js` | 唯一 schema、clamp、迁移、digest、原子写 | `normalize/migrateLegacy/toRuntimePlan/read/write` | 纯函数 + 临时目录 |
| 资源服务层 | `src/host/assets.js` | 扫描、allowlist、Range | `buildMediaPlan/resolveMedia/parseRange` | 纯函数 |
| 资源服务层 | `src/host/routes.js` | 5 条路由、trust fence、206/416 | `createRoutes/mountRoutes` | 假 req/res |
| 注入层 | `src/host/rows.js` | 4 行生成、幂等、旧哨兵让位 | `buildRows/contribute` | 纯函数 |
| 组合根 | `src/index.js` | 读配置、迁移、扫描、订阅、挂路由 | `apply(ctx, config)` | 真宿主集成 |

### 3.2 深模块与 seam

- **深模块 1：`dbnCreateBootMachine`。** 外部只有 `send/on/snapshot`，内部封装 7 个状态、5 条不变量、3 个 deadline。调用方（`50-boot`）不需要知道"fail 为什么不能直接 reveal"。
- **深模块 2：`createRoutes`。** 外部只给 `getPlan/mediaPlan/runtime/getConfig/saveConfig`，内部处理 trust、缓存、Range、206/416、方法白名单。
- ** seam：Host `plan` → Browser runtime。** 这是唯一跨进程契约；浏览器侧不读配置文件、不拼路径、不判断迁移。
- **第二个 adapter：Web 与 Desktop 注入通道。** 同一份 `rows` 由 HTML 渲染器或 IPC 渲染器消费，行 schema 是 seam；两个 adapter 才证明这个 seam 是真的。

---

## 4. 状态机

```text
idle ──arm──▶ arming ──start──▶ playing ──clientReady && clipDone──▶ handoff
                 │                  │                                   │
                 │ fail/skip        │ fail/skip/hardCap                 │ reveal
                 ▼                  ▼                                   ▼
              handoff ◀─────────────┘                               revealed
                                                                       │ saver
                                                                       ▼
                                                                    saver
                                                                       │ wake
                                                                       ▼
                                                                   revealed
```

| 状态 | 进入条件 | 允许的退出 | 说明 |
|---|---|---|---|
| `idle` | 初始 | `arm` | 未接管 DOM |
| `arming` | `arm` | `start` / `fail` / `skip` | 已建 root、锁滚动、黑幕；等第一帧 |
| `playing` | `start` | `clientReady+clipDone` / `skip` / `fail` / hardCap | 片头在播 |
| `handoff` | 双方就绪或强制 | `reveal` | 淡出中；**此时才允许拆层** |
| `revealed` | `reveal` | `saver` / `dispose` | app 已可见；屏保待命 |
| `saver` | 空闲超时 | `wake` / `dispose` | 屏保层；输入唤醒 |
| `disposed` | `dispose` | 终态 | 清监听、删 root |

不变量：

1. **I1 单层**：`playing` 不会二次进入；`arm` 只从 `idle`，`start` 只从 `arming`。
2. **I2 双条件交接**：`handoff` 只由 `clientReady && clipDone`、`skip`、`fail`、hardCap 触发；素材早结束不揭幕。
3. **I3 失败不拆层**：`fail` 只进 `handoff`；`reveal` 是唯一拆层转移。渲染器抛错时黑幕保留，app 在下面启动，超时再揭幕。
4. **I4 时间注入**：`send(type, at)` 接收时间戳，测试可在微秒内跑完整启动。
5. **I5 dispose 终态**：清空监听；之后任何转移都被拒绝。

deadline（实现值）：

| 参数 | 默认 | 位置 |
|---|---|---|
| `armMs` | 4000 | `10-fsm.js:29` |
| `handoffMs` | 4000 | `10-fsm.js:30` |
| `hardCapMs` | `plan.boot.maxMs`（默认 30000） | `50-boot.js` 构造 |
| tick | 250ms | `50-boot.js` |
| saver idle | 180000ms | `config.js` DEFAULTS |

> 评审点：`armMs=4000` 比早期设想的 1200ms 宽松，给慢机/冷启动留余量；如果希望更快失败，只改 `50-boot.js` 的构造参数，不动状态机。

---

## 5. 启动时序

### 5.1 Web

```text
HTML 解析
  ├─ <style> 4KB 关键 CSS
  ├─ <script> global __DBN_PLAN__ / __DBN_VERSION__
  └─ <script> lib/runtime.js  (IIFE, 36.8KB)
        ├─ 读 plan，门控（session/daily/always，?dbn=）
        ├─ 建 #dbn-root，加 html.dbn-lock
        ├─ arming：黑幕，等首帧
        ├─ playing：选片 → video/image
        ├─ app bundle 加载 → client apply() → __BOOT_NEXUS__.clientReady()
        ├─ clipDone && clientReady → handoff → 淡出
        └─ revealed → 卸锁；空闲 → saver
```

### 5.2 Desktop

```text
Host collectIndexInjections()
  → IPC rows
  → preload dshDesktopBoot.ready()
  → UZ():
      style  → <style>
      global → window[name] = value
      script → createElement('script'); textContent = text; append
  → AppWebEntry
```

nexus 只发 **4 行**，其中运行时是 `kind:'script'` 内联。这样：

- 不依赖 `/dsh-boot-nexus/boot.js` 的网络请求（桌面反代失败不会整页白）；
- 不会被 `kind:'html'` 的 `innerHTML` 语义吞掉；
- 行数、行序、体积都可静态断言。

---

## 6. 注入协议

`buildRows()` 固定输出：

| # | kind | 内容 | 作用 |
|---|---|---|---|
| 1 | `style` | `CRITICAL_CSS` | 根节点、phase、锁、reduced-motion |
| 2 | `global` | `__DBN_PLAN__` | JSON plan（含 media allowlist） |
| 3 | `global` | `__DBN_VERSION__` | 诊断/缓存 |
| 4 | `script` | `lib/runtime.js` 全文 | 唯一运行时 |

幂等三层：

1. **行级**：`tableHasNexus()` 查 `global.__DBN_PLAN__`、脚本文本含 `__BOOT_NEXUS__`、html 含 `dbn-root`。
2. **脚本级**：`50-boot` 检测 `window.__BOOT_NEXUS__`，已存在直接返回 `already-running`。
3. **订阅级**：`src/index.js` 只注册一次 `ctx.on('webserver/index-inject')`，disposer 随 `ctx.effect` 释放。

旧插件让位：

```js
tableHasLegacy(table) // __DSH_STARTUP_BOOT__, dsh-startup-root, /dsh-startup/splash.js, __DSH_BOOT_ANIM__, dshba
  ? { added: 0, skipped: 'legacy-present' }
  : push(rows)
```

这是**有意的降级**：检测到旧行时不抢、不并存，结果是"这次没有开机动画"，而不是"两个动画打架"。

---

## 7. 配置与迁移

唯一文件：

```text
$DSH_HOME/dsh-boot-nexus.json
{
  "schemaVersion": 2,
  "enabled": true,
  "boot": { "mode": "session", "clip": "auto", "holdMs": 0, "fadeMs": 900, ... },
  "saver": { "enabled": false, "idleMs": 180000, ... },
  "wallpaper": { "enabled": false, ... },
  "media": { "disabledClips": [], "disabledSavers": [] },
  "advanced": { "diag": false, "trace": false },
  "extensions": {},
  "legacy": { "suite": {}, "animation": {}, "wallpaper": {}, "migratedAt": 0 }
}
```

关键字段：

| 字段 | 默认 | 范围/枚举 | 说明 |
|---|---|---|---|
| `enabled` | `true` | bool | 总开关 |
| `boot.mode` | `session` | `session/daily/always` | 播放频率 |
| `boot.clip` | `auto` | 字符串 | `auto` 或素材 id/文件名 |
| `boot.holdMs` | 0 | 0..120000 | 片头播完后的停留 |
| `boot.fadeMs` | 900 | 200..5000 | 交接淡出 |
| `boot.sound` | false | bool | 片头声音 |
| `boot.volume` | 0.6 | 0..1 | |
| `boot.trigger` | `auto` | `auto/click` | `click` 需点击才播 |
| `boot.clickToEnter` | true | bool | 点击画面跳过 |
| `boot.showHint` | true | bool | 显示跳过提示 |
| `boot.hintAfterMs` | 12000 | 0..60000 | |
| `boot.maxMs` | 30000 | 3000..120000 | 硬上限 |
| `boot.reducedMotion` | `auto` | `auto/on/off` | |
| `saver.enabled` | false | bool | 屏保默认关闭 |
| `saver.idleMs` | 180000 | 5000..3600000 | |
| `saver.rotateMs` | 0 | 0..600000 | 0 = 不轮换 |
| `wallpaper.*` | 关闭 | | P1 渲染，配置/迁移已保留 |

迁移归属（按字段，不按文件）：

| 旧来源 | 旧键 | 新键 |
|---|---|---|
| animation | `enabled` | `enabled`（与 suite OR） |
| animation | `fadeMs` | `boot.fadeMs`（优先） |
| animation | `enterMode=click` | `boot.trigger=click`；`tail/end` → `auto` |
| animation | `sound/volume` | `boot.sound/volume`（suite 优先 volume） |
| animation | `clickToEnter/showHint` | 同名 |
| animation | `screensaver*` | `saver.*` |
| animation | `disabledClips/disabledScreensaver` | `media.disabledClips/disabledSavers` |
| suite | `holdMs/clip/mode` | `boot.*` |
| suite | `enabled/sound/volume/fadeMs` | 与 animation 合并 |
| wallpaper | `enabled/image/color/opacity` | `wallpaper.*` |

`enabled` 用 **OR**：两个旧插件各自独立，关掉其中一个不应静默删掉另一个提供的开机动画。两个都明确 `false` 才关闭；都没有布尔值时用默认 `true`。

迁移安全：

- 旧文件**只读不写**；未知键保留在 `legacy.*`；
- `legacyDigest` / `configDigest` 防止重复迁移；
- 新文件损坏 → 备份 `dsh-boot-nexus.json.corrupt-<ts>` → 写默认；
- 原子写：`tmp` + `rename`；
- `POST /config` 串行化写链，避免读改写竞态。

---

## 8. 资源与安全

### 8.1 素材池

```text
$DSH_HOME/boot-nexus/media/
  clips/    片头视频/图片
  savers/   屏保视频/图片
```

扫描规则：

- 只接受已知 MIME：mp4/webm/mov/png/jpg/webp/gif/avif（**SVG 拒绝**，因为可携带脚本）；
- 跳过隐藏文件、目录、>512 MB 文件；
- 生成稳定 id `clip-1` / `saver-1`，排序后编号。

### 8.2 路由

| 方法 | 路径 | 缓存 | 说明 |
|---|---|---|---|
| GET | `/dsh-boot-nexus/boot.js` | `immutable` + ETag | 运行时（兼容路径；当前注入用内联） |
| GET | `/dsh-boot-nexus/plan.json` | `no-store` | 调试/诊断 |
| GET | `/dsh-boot-nexus/health` | `no-store` | 版本、启用、素材数、uptime |
| GET/POST | `/dsh-boot-nexus/config` | `no-store` | 设置卡读写 |
| GET/HEAD | `/dsh-boot-nexus/media/*` | 206/416 | 唯一 prefix；id 走 allowlist |

安全边界：

- `createTrustFence(ctx.connection)`：缺服务、抛错、拒绝 → 403 fail-closed；
- `resolveMedia` 只查 allowlist，**不拼接用户路径**；
- `parseRange` 只接受单 range，拒绝多 range/非法/不可满足（416）；
- `safeId`：`^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$`；
- 不写 `node_modules`、不 `spawn` 外部程序、不提供任意文件读取。

---

## 9. 关键决策记录

### D1 单插件 + 单运行时，而不是适配器桥接

- **选择**：一个 `apply()`、一个 subscriber、一个根节点。
- **理由**：两个独立插件即使互相感知，也无法仲裁 webserver 的行序（§2.3）和 z-index 的"最后写者"；桥接只能让冲突更隐蔽。
- **代价**：需要一次性迁移配置与素材；不能"只装 nexus 就自动带上旧插件"。

### D2 内联 `kind:'script'`，而不是 `script-src`

- **选择**：运行时以 36.8 KB 内联脚本注入。
- **理由**：桌面 `kind:'script'` 走 `createElement + textContent`，会执行；`kind:'html'` 的 `innerHTML` 不执行；`script-src` 失败会让整页 `Failed to load plugins`。内联自包含、无网络单点。
- **代价**：index 响应多 ~37 KB；CSP 若未来禁止内联，需要切回 `script-src`（保留 `boot.js` 路由）。

### D3 唯一 z-index `2147483000`

- **选择**：不再使用 `2147483647`，也不用 `!important`。
- **理由**：留出 647 个层级给宿主对话框/审批浮层；旧插件的 `2147483647` 在禁用后不再存在。
- **代价**：若宿主未来有更高层，需要重新评估；目前以 DSH 的 `--dsw` 层级为准。

### D4 单根节点 + `data-phase`，不卸载

- **选择**：`#dbn-root` 常驻，`off/arming/playing/handoff/saver` 切属性。
- **理由**：卸载/重建会造成焦点丢失、视频重载、caption 闪烁；phase 切换让过渡可控。
- **代价**：空节点常驻（约 5 个 div），可忽略。

### D5 `enabled` 迁移用 OR

- **选择**：任一旧插件启用 → nexus 启用。
- **理由**：见 §7。用户"关掉 suite 但留着 animation"是常见组合，不能因为 suite 的 false 把 animation 也关掉。
- **代价**：如果用户确实想全关，需要在 nexus 里再关一次；设置卡会显示"已启用"。

### D6 行为配置放文件，不放 patch

- **选择**：`Config` 只有 `configFile` / `mediaDir`；行为字段全部在 `$DSH_HOME/dsh-boot-nexus.json`。
- **理由**：patch 配置和设置卡同时写行为字段会重新制造"两份真相"。
- **代价**：设置卡必须走 HTTP 路由；首次打开需要 Host 已挂载。

### D7 不复制旧素材

- **选择**：nexus 不打包 animation 的 5 个视频 / 7 个屏保。
- **理由**：animation 素材是非商用许可，不能并入 MIT 包；复制还会让 tarball 膨胀。
- **代价**：用户需要把素材放到 `$DSH_HOME/boot-nexus/media/`；旧插件禁用后素材仍在原目录，可手动复制。

### D8 壁纸渲染放到 P1

- **选择**：P0 只做片头 + 屏保 + 单覆盖层；`wallpaper.*` 配置与迁移已保留。
- **理由**：本任务是"开机启动动画"合并；壁纸是 suite 的附加能力，且涉及 chat 节点，独立风险面。
- **代价**：P0 不恢复聊天气泡壁纸；需要时在 `40-stage` 之外加一个 wallpaper renderer，不碰状态机。

---

## 10. 降级矩阵

| 条件 | 行为 | 用户看到 |
|---|---|---|
| 旧插件行仍在 | `contribute` 返回 `legacy-present` | 无 nexus 动画；不冲突 |
| 旧插件禁用 + nexus 启用 | 正常 | 片头/屏保 |
| 浏览器不支持 video | `onError` → `fail` → 黑幕 → 超时揭幕 | 短暂黑屏，不白屏 |
| 无素材 | `clip-done` 直接进 handoff，等 clientReady | 黑幕，app 就绪后揭幕 |
| clientReady 永不发 | hardCap（30s）→ skip → handoff → reveal | 最多 30s 黑屏 |
| `connection` 缺失 | 所有路由 403 | 设置卡不可用；动画仍由注入行运行 |
| 配置损坏 | 备份 `.corrupt-<ts>` + 默认 | 默认动画 |
| `prefers-reduced-motion` | 关过渡/降级 | 无淡出 |
| `?dbn=off` | 不接管 | 原生启动 |
| `?dbn=preview` | 绕过 session/daily | 每次刷新都播 |

---

## 11. 验收映射

| # | 验收点 | 证据 |
|---|---|---|
| 1 | 只有一条 insert 行 | `cordis.patch.yml` |
| 2 | inject 并集 | `src/shared/constants.js` |
| 3 | 注入唯一 | `test/rows.test.mjs` |
| 4 | 唯一 z-index/解锁 | `src/host/css.js` + `test/runtime.test.mjs` |
| 5 | 播放语义 | `test/runtime.test.mjs` session；daily 逻辑在 `50-boot` |
| 6 | 退出零 timer/listener | `test/runtime.test.mjs` dispose |
| 7 | 配置迁移 | `test/config.test.mjs` |
| 8 | 写入竞态 | `src/index.js` writeChain |
| 9 | 信任栅栏 | `test/routes.test.mjs` |
| 10 | 路径穿越 | `test/assets.test.mjs` + `test/routes.test.mjs` |
| 11 | 206/416 | `test/assets.test.mjs` + `test/routes.test.mjs` |
| 12 | 桌面双路径 | 设计 §5.2；待实机 |
| 13 | 单一设置卡 | `src/client/index.js` |
| 14 | 诊断可读 | `#dbn-diag` + `?dbn=diag` |
| 15 | 卸载干净 | `ctx.effect` 返回的 disposer |
| 16 | 旧测试纳入 | suite 15 smoke + animation 5 verify **未直接复用**，改为等价新测试（见 TEST-PLAN） |

---

## 12. 风险与开放问题

1. **桌面实机未验证**：内联 `kind:'script'` 的行为来自 Desktop Engineer 读 dist 的结论；需要在 `dsh web` 与 desktop 各跑一次 TEST-PLAN 的 T1/T2。
2. **`plugins.item` 卡的 slot 契约**：实现按 animation 的形态写，但未在真实 shell 渲染过；若 `slots.register` 要求 `locale/scope`，需要补。
3. **壁纸 P1**：`wallpaper.*` 目前只迁移不渲染。
4. **`?dbn=diag`**：运行时已强制 `plan.advanced.diag=true`；诊断 HUD 的样式/内容需要在实机确认。
5. **动画素材授权**：不随包分发；用户自备。
6. **`engines`**：取交集 `>=22.19.0`；若宿主低于此版本，`plugin add` 会拒绝。

---

## 13. 变更范围

**已写（工作区，未安装）：**

```text
dsh-boot-nexus/
  package.json
  cordis.patch.yml
  assets/icon.svg
  src/index.js
  src/shared/constants.js
  src/host/{config,css,rows,assets,routes}.js
  src/runtime/{00-constants,10-fsm,20-clock,30-media,40-stage,50-boot}.js
  src/client/index.js
  scripts/build-runtime.mjs
  lib/runtime.js
  test/*.test.mjs
```

**未动：**

```text
%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-boot-suite
%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-boot-animation
%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml
```

**下一步（需用户批准）：**

1. 在 desktop profile 里禁用旧插件、安装 nexus tarball；
2. 实机跑 T1–T8；
3. 决定是否把壁纸/素材复制纳入 P1。
