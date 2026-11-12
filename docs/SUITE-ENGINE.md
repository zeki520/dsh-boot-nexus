# 用 suite 原版引擎替换原生近似 scene（v0.3 方案）

状态：设计稿（待评审）。目标版本 `dsh-boot-nexus@0.3.0`。
约束：不改 `dsh-boot-suite` 与 `dsh-boot-animation` 目录；单 Stage / 单锁；失败 fail-open。

---

## 1. 结论

| 决策点 | 选择 | 一句话依据 |
| --- | --- | --- |
| 引擎隔离 | **同源 iframe**，文档由 nexus 路由提供 | splash.js 无 dispose、直接改 `document.documentElement`，只有销毁文档能彻底卸载 |
| 资源供给 | nexus 新前缀 `/dsh-boot-nexus/suite/<token>/…`，只读 suite 包内文件 | 不碰 `/dsh-startup` 命名空间，不与 suite 路由冲突，也不命中 nexus 的 `LEGACY_SENTINELS` |
| 全局注入 | 在 **iframe 的 shell 文档**里注入 `__DSH_STARTUP__` / `__DSH_STARTUP_TEMPLATE__` / `__DSH_STARTUP_TEMPLATE2__` / `__DSH_STARTUP_TPL_BASE__` 等 | 这些是 splash.js 的 window 全局；注入到父文档会让 nexus 自己让位 |
| 两幕 | 交给 suite 自己的 `playSecondTemplate()`，nexus 只下发一个 `{kind:'suite'}` act | 第二幕的转场、BGM 切换、`#dsh-startup-act2` 覆盖层都在 suite 内部，外部拆分只会破坏它 |
| 随机 A/B | 宿主 `getPlan()` 用 `node:crypto.randomInt` 决定，写进 `plan.choice`，一次进程一次 | 计划可诊断、可复现，运行时不掷骰子 |
| 失败回退 | B 分支的 acts 天然是 `[suite, pool]`，suite 失败 → 走既有 `onError → nextAct()` | 复用现有 fail-open 通道，不新增回退语义 |

已排除的两条路：

- **父文档内联 `<script src=splash.js>`**：splash.js 会 `documentElement.classList.add('dsu-lock')`、`document.body.appendChild(root)`、绑 document 级 Esc，且没有 teardown；与 `40-stage.js` 的唯一 root/唯一锁直接冲突，失败时无法回滚。
- **独立进程/独立 BrowserWindow**：插件 API 只有 `webServer` + `connection`（`src/shared/constants.js` 的 `INJECT`），拿不到主进程窗口控制；跨进程也拿不到同一视口的焦点与遮挡。

---

## 2. 关键平台事实（决定了方案形状）

1. `dsh-app` 在桌面端注册为 `{ standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }`。因此 `dsh-app://app/` 是 **安全上下文**：其中的子框架若指向 `http://127.0.0.1:<port>` 属混合内容，会被拦截。→ iframe 必须与父文档同源（用根相对路径即可）。
2. `protocol.handle('dsh-app')` 对 `host === 'app'` 的非静态路径一律 `forwardWebRequest(request, hostUrl, hostCookie)`：**主进程给每个转发请求注入认证 cookie**。所以 iframe 及其文档内的 `<audio src>` / `<video src>` / `fetch()` 都能通过 `connection` 的信任栅栏 —— 这是"原版引擎能在 iframe 里正常取素材"的前提。
3. splash.js（2.16.11）的行为契约：
   - 无 dispose/teardown，只有 `__DSH_STARTUP_API__.replay()`；完成时 `root.remove()` + `window.dispatchEvent(new CustomEvent('dsh-startup:done'))`。
   - 完成时按 `C.mode` 写 `sessionStorage['dsh-startup-screen:shown']` / `localStorage['dsh-startup-screen:day']`（mode 为 session/daily 时）。
   - 资源 URL 是**硬编码绝对路径**：`/dsh-startup/voice/<pack>/line-N.mp3`、`/dsh-startup/asset/<name>`、`/dsh-startup/template-asset/<id>/<file>`、`/dsh-startup/music/file?name=`、`/dsh-startup/diag`、`/dsh-startup/frame-session`、`/dsh-startup/template-frame/<t>`、`/dsh-startup/template-file/<id>/<rel>`。
   - 存在覆盖点：`__DSH_STARTUP_TPL_BASE__`、`__DSH_STARTUP_API_BASE__`、`__DSH_STARTUP_SCRIPT_URL__`、`__DSH_STARTUP_JUMP__`。
   - `TEMPLATE2` 存在时 `playSecondTemplate()` 自动接第二幕（`dissolve` 默认 600ms 淡入/淡出 + `wait(650)`；`join/out` 支持 none/dissolve/flash/glitch/scanline/slide/iris/black）。
   - `splash.css` 内部只有 data-URI，无 `/dsh-startup` 引用 → **CSS 不需要改写**。

---

## 3. 架构

```
父文档（dsh-app://app/ 或 http://127.0.0.1:<port>）
 └ dbn-root (z 2147483000, 唯一锁)      ← 40-stage.js，未改动
    └ #dbn-stage
       └ <iframe src="/dsh-boot-nexus/suite/<token>/frame">   ← renderer.el
            ├ splash.css
            ├ shell 内联脚本：注入 __DSH_STARTUP__ / TEMPLATE / TEMPLATE2 / JUMP / bridge
            └ <script src="…/suite/<token>/splash.js">（服务端改写前缀）
```

- iframe 内的 `dsu-lock`、`#dsh-startup-root`、z-index 2147483000/2147483600 全部落在子文档，父文档仍然只有一层 stage。
- 卸载 = `renderer.dispose()` → `iframe.remove()` + 关掉计时器；这是唯一可靠的"拆掉 splash.js"方式。
- 玩家交互（Esc、点击进入）父层已实现（`50-boot.js` 的 Esc/pointerdown）；iframe 内的"跳过"按钮走 splash 自己的 `allowSkip`，只影响子文档。

---

## 4. 文件清单

### 新增

| 文件 | 行数量级 | 职责 |
| --- | --- | --- |
| `src/host/suite.js` | ~260 | 模板解析与校验、suite 配置只读继承与白名单投影、splash.js 前缀改写（按 `size+mtime+version` 缓存）、会话令牌、路径白名单 |
| `src/host/suite-routes.js` | ~180 | `/dsh-boot-nexus/suite/<token>/*` 路由族（复用 `assets.js` 的 MIME/`parseRange`、`routes.js` 的 `serveFile`） |
| `src/host/suite-shell.js` | ~120 | 生成 shell HTML（内联全局 + bridge），`JSON.stringify` 后把 `<` 转义为 `\u003c` |
| `src/runtime/37-suite.js` | ~200 | `dbnCreateSuiteRenderer({doc,win,clock,suite,onDone,onError,onDiag})`，契约 `{el, start(), dispose()}` |
| `test/suite.test.mjs` | ~180 | 纯函数单测 |
| `test/suite-routes.test.mjs` | ~140 | 路由单测（token/路径穿越/Range/404） |
| `docs/SUITE-ENGINE.md` | 本文件 | 方案与验收 |

### 修改

| 文件 | 改动 |
| --- | --- |
| `src/host/config.js:28` `DEFAULTS.boot` | 新增 `choice`、`clipSegment`、`suiteAct1`、`suiteAct2`、`suiteCfg`、`suiteOverrides`、`fallbackClip` |
| `src/host/config.js:76` `BOOT_KEYS` | 同步新增键名；`normalize` 增分支（`suiteScene` 读作 `suiteAct1.template` 的兼容入口） |
| `src/host/config.js:85` `SUITE_CONSUMED` | 迁移时把 legacy `suite.template/act2` 映射到新键（旧字段仍整份留在 `legacy.suite`） |
| `src/index.js:210` `getPlan()` | 随机选择、`plan.suite`、`plan.acts`、`maxMs` 预算、令牌 |
| `src/host/routes.js` | 追加 prefix 路由族（`mountRoutes` 不变） |
| `src/shared/constants.js` | `SUITE_PATH = '/dsh-boot-nexus/suite'`、`SUITE_MSG = 'dbn-suite'`、`SUITE_MSG_V = 1` |
| `src/runtime/50-boot.js:227` `startAct` | 增 `act.kind === 'suite'` 分支（与 scene 分支同构：建 renderer → `stage.setMedia` → `start()`） |
| `src/runtime/50-boot.js` arm | `query` 增 `dbnChoice=clip\|suite` 调试开关 |
| `scripts/build-runtime.mjs` | 文件清单加 `37-suite.js` |
| `src/client/index.js` | 设置卡加 3 个字段（选择模式 / 第一幕模板 / 第二幕开关+模板），可选 |
| `package.json`、`README.md`、`docs/DESIGN.md`、`docs/TEST-PLAN.md` | 版本与文档 |

`lib/runtime.js` 预算：现 36808 B / 65536 B，37-suite.js 预计 +6 KB，仍有余量；超限时把 bridge 逻辑留在 shell（宿主侧），runtime 只做收发。

---

## 5. 资源与协议

### 5.1 路由族（全部 `prefix`，路径 `/dsh-boot-nexus/suite/<token>/…`）

| 路径 | 源 | 头 |
| --- | --- | --- |
| `frame` | `suite-shell.js` 生成 | `text/html; charset=utf-8`、`no-store`、`X-Frame-Options: SAMEORIGIN`（同源父框架） |
| `splash.js` | suite `lib/splash.js` 改写后 | `application/javascript`、`no-store` |
| `splash.css` | suite `lib/splash.css` | `text/css`、`immutable` |
| `asset/<name>` | suite `lib/assets/<name>`（`.mp3` 白名单） | `audio/mpeg`、`no-store` |
| `voice/<pack>/<line>` | suite `lib/assets/voices/<pack>/line-N.mp3` | `audio/mpeg` |
| `template-asset/<id>/<file>` | `$DSH_HOME/startup-templates/<id>/assets/` → 包内 `templates/<id>/assets/` | 单 Range（206/416）、`nosniff`、`max-age=86400` |
| `music/file?name=` | `$DSH_HOME/startup-music/<name>`（`MUSIC_FILE_RE` 白名单） | 单 Range |
| `diag` | POST `text/plain` → 追加 nexus diag 日志，前缀 `suite:` | 204 |
| `frame-session`、`template-frame/*`、`template-file/*` | 明确 `501 unsupported` | 见 §9 范围外 |

安全：`token` = `randomBytes(32).toString('hex')`，apply 时生成一次（进程生命周期），路由用 `timingSafeEqual` 比较；模板 id 走 `/^[a-z0-9][a-z0-9-]{0,39}$/`；文件路径一律"映射白名单 → 拼绝对路径 → `path.relative` 校验不越界 → `realpath` 再校验"，绝不把请求字符串当路径；沿用 `routes.js` 的信任栅栏包裹（同源 iframe 由主进程注入 cookie，能通过；若被拒则 fail-open 到 pool 并记 diag）。

### 5.2 为什么不用 `/dsh-startup/*`

1. `src/shared/constants.js` 的 `LEGACY_SENTINELS` 含 `'/dsh-startup/splash.js'`、`'dsh-startup-root'`、`'__DSH_STARTUP__'`，`src/host/rows.js:tableHasLegacy` 命中即整表退让 —— nexus 若自己注入这些全局，会把自己关掉。
2. suite 若被启用，同前缀路由会撞车（`webServer.register` 重复注册）。
3. 独立前缀让"suite 只当引擎文件库"这件事在 URL 上就成立：读它的文件，不启用它的插件。

### 5.3 splash.js 前缀改写

只改一处输入：`'/dsh-startup` → `'/dsh-boot-nexus/suite/<token>`。断言：

- 原文出现次数 `N`（2.16.11 实测 15 处含 4 个 base 默认值，v1 全量以运行时统计为准），改写后 `/dsh-startup` 计数必须为 **0**；
- 新前缀计数必须 `>= N`；
- 结果缓存键 = `version + size + mtimeMs`；任一断言失败 → `suite` act 直接 `onError`，diag 记 `suite-rewrite-failed`，走 fail-open。

不改写 `splash.css`（无绝对 URL 引用）。

### 5.4 shell 文档注入项

```js
window.__DSH_STARTUP__ = { ...suiteCfgProjected, mode: 'always', enabled: true, allowSkip: true, requireInteraction: false }
window.__DSH_STARTUP_TEMPLATE__  = act1TemplateJson   // 已从 TEMPLATE_ROOTS 解析并校验
window.__DSH_STARTUP_TEMPLATE2__ = act2Enabled ? act2TemplateJson : null
window.__DSH_STARTUP_TPL_BASE__  = base   // base = '/dsh-boot-nexus/suite/<token>'
window.__DSH_STARTUP_API_BASE__  = base
window.__DSH_STARTUP_SCRIPT_URL__= base + '/splash.js'
// 可选：act1 只播某几幕（v1 steps）
window.__DSH_STARTUP_JUMP__ = { start, count }
```

要点：

- `mode: 'always'` 让 splash 的完成逻辑不写 `sessionStorage`/`localStorage`（避免污染宿主 origin 的会话门），跳不跳过由 nexus 自己的 `plan.boot.mode` 决定。
- shell 在加载 splash.js **之前**把 `sessionStorage` / `localStorage` 换成内存 stub（防御性：任何版本若新增 storage 门，也只影响子文档）。
- 模板 JSON 以 `JSON.stringify` 注入并做 `<` → `\u003c` 转义，防止 `</script>` 逃逸。
- shell 末尾挂 bridge（见 5.5），并在 `DOMContentLoaded` 后加载 `splash.js`。

### 5.5 postMessage 协议

| 方向 | 消息 | 用途 |
| --- | --- | --- |
| frame→parent | `{ns:'dbn-suite', v:1, nonce, type:'ready'}` | iframe 脚本已就绪（父层据此起"首个动画帧/首音频"看门计时） |
| frame→parent | `{..., type:'act', act:1\|2}` | 进入第二幕（diag、可选提前收起 hint） |
| frame→parent | `{..., type:'done'}` | 监听 `dsh-startup:done` 后上报 → `onDone()` |
| frame→parent | `{..., type:'error', detail}` | `window.onerror` / `unhandledrejection` / 模板校验失败 → `onError()` |
| frame→parent | `{..., type:'audio-blocked'}` | 首次 `play()` reject → 父层记 diag，不中断 |
| parent→frame | `{ns:'dbn-suite', v:1, type:'skip'}` | 父层 Esc 时顺带通知（幂等；实际销毁靠 dispose） |

父层校验：`e.source === iframe.contentWindow` 且 `e.data.ns === SUITE_MSG` 且 `v === 1` 且 `nonce` 匹配；其余一律丢弃并计数（`diag: suite-msg-dropped`）。

### 5.6 超时与预算

- renderer 内部：`hardStop = act1DurMs + act2BudgetMs + 2 * transitionMs + 4000`（`act1DurMs` 取模板 `duration`/`steps` 估算，缺省用 `plan.suite.budgetMs`）；到点 → `onDone()`（非失败）+ diag `suite-truncated`。
- `loading` 阶段：`start()` 后 8000ms 内没有 `ready` → `onError`（等价于 iframe 路由 404 / 栅栏拒绝）。
- 宿主：`plan.boot.maxMs = clamp(max(config.boot.maxMs, budgetMs + fadeMs), 5000, 120000)`；`50-boot.js` 的 `hardCapMs` 仍生效，超时只 `skip`（进 handoff），不写失败标记。

---

## 6. 随机与 plan.acts

### 6.1 配置面（`src/host/config.js`）

```jsonc
"boot": {
  "choice": "random",               // random | clip | suite
  "clipSegment": { "from": 0, "durMs": 0 },   // A 分支：只播一段；0 = 整段
  "suite": true,                    // 保留：是否允许 B 分支
  "suiteAct1": { "template": "archive-warm", "steps": { "start": 0, "count": 0 } },
  "suiteAct2": { "enabled": true, "template": "custom-mw4issgp", "maxMs": 6000 },
  "suiteCfg": "inherit",            // inherit | inline
  "suiteOverrides": { "sound": true, "volume": 0.5, "voice": true, "bgmEnabled": false },
  "fallbackClip": true,             // B 之后/失败后是否接一段 pool 片段
  "maxMs": 30000
}
```

`suiteCfg: "inherit"` 时只读 `$DSH_HOME/dsh-startup.json`，用白名单投影（`theme/speed/sound/soundVolume/voice*/sfx/voicePack/voiceFx/voiceLead/welcomeDelay/identity*/accessLevel/transition*/bgm*/act1VideoSound/act2VideoSound`），**绝不回写**；文件缺失/损坏 → 内置默认 + diag 一行。`act2.template` 同理只读 `$DSH_HOME/startup-templates/<id>/template.json` 或包内 `templates/<id>/template.json`。

### 6.2 `getPlan()` 逻辑（`src/index.js:210`）

1. `enabled === false` → 不注入 act 逻辑（现有行为不变）。
2. 选择：
   - `choice === 'clip'` → A；`'suite'` → B；`'random'` → `randomInt(0, 2)`，结果写 `plan.choice = 'clip' | 'suite'`。
   - 若 B 不可用（没有合法 act1 模板 / suite 包缺失 / 改写断言失败预检失败），降级 A 并记 `plan.choiceFallback = 'suite-unavailable'`。
3. `plan.suite = { token, base, nonce, act1: {templateId, durMs}, act2: {...}, budgetMs }`（仅 B 需要，A 也带上无害，便于 debug 里手动切）。
4. `plan.acts`：
   - A：`[{kind:'pool', pool:'clips', segment}]`
   - B：`[{kind:'suite', id:'suite:'+act1Id, suite: plan.suite}]`，`fallbackClip` 为真时再 push `{kind:'pool', pool:'clips'}`。
5. `maxMs` 按 §5.6 计算。

随机在宿主而非运行时：一次注入只掷一次，`plan.json` 与页面内 `__DBN_PLAN__` 一致；诊断日志能写清"这次为什么是 A/B"。

### 6.3 运行时接入（`src/runtime/50-boot.js:227`）

与 scene 分支同构：

- `act.kind === 'suite' && act.suite && typeof dbnCreateSuiteRenderer === 'function'` → 建 renderer；`onDone` → dispose + `nextAct()`；`onError` → `log('suite-failed …')` + dispose + `nextAct()`（沿用现有 fail-open 语义，绝不 `machine.send('fail')` 直接黑屏）。
- renderer.el = `<iframe style="border:0;width:100%;height:100%;display:block;background:#000" allow="autoplay; fullscreen">`；`start()` 里才设 `src = plan.base + '/frame'`，避免 stage 挂载前就开始加载。
- `dispose()`：移除 `message` 监听、清计时器、`iframe.src='about:blank'` 后 `remove()`。

---

## 7. 失败矩阵

| 失败点 | 检测 | 行为 |
| --- | --- | --- |
| suite 包不存在 / 版本不在 2.16.x | apply 时读 `package.json` | B 分支标记不可用 → 一律 A（不阻断启动） |
| splash.js 前缀改写断言失败 | serve 前 | B 的 act 预检失败 → 降级 A |
| iframe 8s 内无 `ready` | renderer 计时器 | `onError` → `nextAct()`（→ pool） |
| 模板 JSON 缺失/非法/超 512 KB | 宿主解析 | act1 删掉则降级 A；仅 act2 删掉则只播 act1 |
| 第二幕视频解码失败 | splash 内部捕获（它自己跳过第二幕） | 视为正常结束，`done` 照常上报 |
| 预算超时 | renderer `hardStop` | `onDone` + `suite-truncated`，进 handoff |
| 音频被策略拦截 | frame 上报 `audio-blocked` | 记 diag，继续（视觉不受影响） |
| 信任栅栏拒绝（403/401） | `ready` 未到达 → 8s 超时 | 同上 fail-open |
| 宿主整体异常 | `50-boot.js` 既有 try/catch | 既有 fail-open 到 handoff + reveal |

不变量：任何路径都不允许出现第二个 `#dbn-root`/第二次 `stage.lock()`；iframe 永远在 stage 内，销毁即消失。

---

## 8. 风险与取舍

1. **版本耦合**：前缀改写依赖 splash.js 的字符串形态。缓解：断言 + 版本白名单（`2.16.x`）+ 失败即降级 + `suite-unsupported-version` diag。这是本方案唯一的硬耦合，接受它换来"零改动使用原版引擎"。
2. **黑场**：splash 完成与第二幕交接处本身有 600ms dissolve 与 650ms wait；我们销毁 iframe 的瞬间父层是 stage 黑底，随后 `reveal(fadeMs)` 淡出——不会比 suite 原生更突兀，但 `fadeMs` 建议 ≥ 600。
3. **音频策略**：Electron 默认 `no-user-gesture-required`，但 iframe 是跨文档委托，需要 `allow="autoplay"`；若被拦只能看到静音（splash 内部 swallow），因此加 `audio-blocked` 上报，避免"以为坏了"。
4. **`transitionIn/Join/Out`**：沿用 suite 配置；nexus 不干预。若用户希望"B 的收尾不要闪白"，可通过 `suiteOverrides.transitionOut='dissolve'` 强制。
5. **与 suite 同装**：现状是 suite 启用则 nexus 因 `LEGACY_SENTINELS` 让位。本方案不改这条策略（避免双重启动），文档写明"既然接了引擎，就不要在 profile 里同时启用 suite"。
6. **HTML 型模板**（如 `division-bigfish-codex` 走 `/template-frame`）本版不支持：需要复刻 `frame-session` + CSP + `<base>` 注入，收益低、攻击面大。检测到该类型直接降级 A，并在 diag 写明。
7. **`reducedMotion`**：`plan.boot.reducedMotion==='on'` 时建议直接 A（跳过 suite 的动效密集场景），避免无障碍投诉。

---

## 9. 范围外（明确不做）

- 不复刻 suite 的设置页/编辑器/素材上传/应用商店路由。
- 不支持 HTML 型（iframe 内嵌网页）模板。
- 不改 `~/.dsh/dsh-startup.json`，不写 suite 的模板目录。
- 不做 B→A 的"幕间再插入"，两幕顺序固定 act1 → act2。

---

## 10. 测试方案

### 10.1 单测（`test/suite.test.mjs`）

- `resolveTemplate(id)`：用户目录优先、包内兜底、非法 id（`../`、大写、超长）→ null。
- `rewriteSplash(text, base)`：替换计数断言、幂等（对已改写文本再跑应报 `already-rewritten` 而不是二次替换）、缺前缀 → 抛。
- `buildSuitePlan(cfg, rng)`：注入固定 rng，验证 `random` 在 1000 次上 A/B 各 ~50%（容差 ±6%）；`choice:'suite'` 但无模板 → 降级 A 且带 `choiceFallback`。
- `mintToken` / `tokenMatches`：长度、`timingSafeEqual`、错 token 拒绝。
- `budgetMs`：act1+act2+转场+slack 的算式与 clamp。
- `projectSuiteCfg`：白名单外的键被丢弃；损坏 JSON → 默认值 + 一条 warning。

### 10.2 路由测（`test/suite-routes.test.mjs`）

用现有 fake req/res 打法：

- `frame` 200 + `text/html` + 含 `__DSH_STARTUP_TEMPLATE__` 与 nonce；
- `splash.js` 200，响应体不含 `/dsh-startup`，含 `<base>` 前缀；
- `template-asset/<id>/x.mp4` 的 `Range: bytes=0-1` → 206 与 `Content-Range`；多段 → 416；
- `voice/f/line-1.mp3` 200；`voice/../x` → 400/404；
- 错 token → 404；过期/撤销 → 404；
- `del` 目录穿越（`..%2f`、`%00`、反斜杠）一律 4xx，不触达 `fs` 之外的路径。

### 10.3 运行时测（扩 `test/runtime.test.mjs` + `helpers/fake-dom.mjs`）

- fake-dom 提供 `createElement('iframe')` 与 `postMessage` 注入：模拟 `ready`/`done` → 断言 `nextAct` 被调用、`stage.setMedia` 收到 `{el}`。
- 模拟 `error` → 断言 `log` 含 `suite-failed`、随后进入 handoff（fail-open）。
- 不 `ready`：推进 fake clock 8000ms → 同上。
- `dispose()` 后 `message` 监听数归零、iframe 从文档移除（断言事件不会二次触发）。
- acts 顺序：B 且 `fallbackClip:true` → suite 后仍播一段 pool。

### 10.4 端到端 / 手工（追加到 `docs/TEST-PLAN.md`）

1. `?dbn=preview&dbnChoice=suite` 连开 5 次：每次都播 act1 + 短 act2；`__BOOT_NEXUS__.logs` 里出现 `suite …` 与 `done`。
2. 去掉 query 连开 6 次：A/B 都有出现（约 3/3）。
3. 临时把 suite 包目录改名 → 一律走 A，启动无异常（不修改原目录，只在本机测试时移动后立即还原）。
4. 删掉 act2 模板的 mp4 → act1 正常，act2 被 suite 自行跳过。
5. 断网/占位 mp4 损坏 → fail-open 到 pool 或 handoff，绝无白屏超 2s。
6. 缩放 80% / 150% / 4K：iframe 无黑边、无缩放错位。
7. Esc 与"点击进入"两条 skip 路径都只卸一次层（`#dbn-root` 计数 = 1）。
8. 检查 `~/.dsh/dsh-boot-nexus-diag.log`：应有 `suite-plan choice=… budget=…`、`suite-act1 …`、`suite-done|suite-truncated`。

### 10.5 验收标准

- `npm test` 全绿（新增两个测试文件）；`node --test test/*.test.mjs` 无新增告警。
- `lib/runtime.js` ≤ 65536 B。
- 两个原插件目录 `git status` 无改动（用 `Get-FileHash` 或 mtime 快照证明）。
- 目视：A 分支一段视频；B 分支 act1 → 短 act2 → 淡出；两种都只出现一层覆盖。

---

## 11. 待用户确认

1. **「克莱因启动界面」具体是哪个模板**？suite 24 套模板与用户模板里没有 `klein/克莱因` 字样；从底色看唯一强克莱因蓝的是 `deep-sonar`（`#1e48ba/#72a2ea`），另有 `dsh-intro-welcome`（`#04070D/#72A2EA`）偏蓝黑。当前方案把 `boot.suiteAct1.template` 做成可配，默认沿用既有 `template: 'archive-warm'`，确认后改一个字符串即可。
2. **第二幕是否就用 `custom-mw4issgp`（8.06 s）**？`suiteAct2.maxMs` 默认 6000 会截断到 6 s；若要完整播完应设 8064 或 `maxMs: 0`（= 不截断，交给模板时长）。
3. A 分支的"一段"是否要固定时长（`clipSegment.durMs`）还是保持整段。
