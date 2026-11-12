# dsh-boot-nexus 部署与测试方案（评审稿）

> 配套设计：`docs/DESIGN.md`
> 状态：**未安装、未替换原插件**。以下步骤在评审通过后执行。
> 目标：证明"合并后只有一个动画主人"，并且旧插件禁用/卸载后不残留。

---

## 0. 前置条件

| 项 | 要求 | 检查 |
|---|---|---|
| 宿主 | DSH desktop 或 web profile | `dsh --version` |
| Node | `>=22.19.0`（与 `engines` 一致） | `node -v` |
| profile | `%USERPROFILE%\.dsh\profiles\desktop` | 存在 `cordis.patch.yml` |
| 旧插件 | 先备份 profile | 复制 `cordis.patch.yml` 与 `package.json` |
| 媒体 | 可选；没有也能启动 | `$DSH_HOME/boot-nexus/media/clips` |

**不要**在 profile 目录里跑 `pnpm`；**不要**手写 profile 的 `package.json`。安装/卸载走 `plugin_manager`。

---

## 1. 构建与自测

```powershell
cd "F:\dsh插件工作区\dsh-boot-nexus"
npm test
```

期望：

```text
runtime: 36808 bytes (ok; budget 65536, hard 98304)
ℹ tests 34
ℹ pass 34
ℹ fail 0
```

再跑语法检查：

```powershell
node --check src/index.js
node --check src/client/index.js
node --check scripts/build-runtime.mjs
```

打包：

```powershell
npm pack --pack-destination "%USERPROFILE%\dsh-plugins"
```

产物：`%USERPROFILE%\dsh-plugins\dsh-boot-nexus-0.1.0.tgz`。

> 版本号变了就重新打包；pnpm 可能复用同名 tarball。不要复用旧包。

---

## 2. 安装（评审通过后）

### 2.1 禁用旧插件

在 DSH 会话里使用 `plugin_manager`（或设置页的插件管理）：

```text
plugin_manager remove_bundle dsh-boot-suite
plugin_manager remove_bundle dsh-boot-animation
```

如果只禁用不卸载，至少要保证 profile 的 `cordis.patch.yml` 里：

```yaml
- id: dsh-boot-suite
  disabled: true
- id: dsh-boot-animation
  disabled: true
```

> 当前 profile 里 `boot-animation` 有三条同 id 行，最后一条 `disabled: true` 生效；安装前务必确认"最后一条"是禁用，否则会出现同 id 多行。

### 2.2 安装 nexus

```text
plugin_manager install_bundle "%USERPROFILE%\dsh-plugins\dsh-boot-nexus-0.1.0.tgz"
```

读返回值：

- `application: installed` → 已登记；
- `restart-required` → **尚未生效**，重启 DSH；
- `failed` / `overridden` → 先诊断，不要继续。

### 2.3 重启后确认

```text
plugin_manager list
```

应只看到 `dsh-boot-nexus` 一个相关条目，没有 `dsh-boot-suite` / `dsh-boot-animation` 的启用行。

---

## 3. 首次启动与配置

1. 打开 DSH，观察首屏：应只有一层动画，没有第二层黑幕/第二套 caption。
2. 检查新配置是否生成：

```powershell
Get-Content "$env:USERPROFILE\.dsh\dsh-boot-nexus.json"
```

期望 `schemaVersion: 2`，且旧值已映射：

- animation 的 `fadeMs` → `boot.fadeMs`
- animation 的 `enterMode=click` → `boot.trigger=click`
- suite 的 `holdMs/clip/mode` → `boot.*`
- animation 的 `screensaver*` → `saver.*`
- `enabled` 为两者 OR

3. 旧文件应保持不变（只读迁移）：

```powershell
Get-Item "$env:USERPROFILE\.dsh\dsh-startup.json"
Get-Item "$env:USERPROFILE\.dsh\chat-wallpaper.json"
```

4. 放素材：

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\boot-nexus\media\clips"
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\boot-nexus\media\savers"
# 把 mp4/webm/png/jpg 放进去
```

支持：`mp4/webm/mov/png/jpg/webp/gif/avif`；**SVG 会被拒绝**；单文件 >512 MB 会被跳过。

5. 打开设置页的"开机动画"卡片，保存一次，确认 `GET/POST /dsh-boot-nexus/config` 正常。

---

## 4. 自动化测试（已通过）

```powershell
npm test
```

| 测试文件 | 覆盖 | 用例数 |
|---|---|---|
| `test/runtime.test.mjs` | 状态机全流程、失败、session、`?dbn=off`、屏保、dispose | 6 |
| `test/config.test.mjs` | clamp、迁移、OR、digest、plan、读写、原子写 | 7 |
| `test/rows.test.mjs` | 4 行、幂等、旧哨兵让位、空运行时 | 6 |
| `test/assets.test.mjs` | MIME、id、allowlist、Range 全分支 | 7 |
| `test/routes.test.mjs` | trust、boot/plan/health/config、206/416/HEAD、回滚 | 8 |
| **合计** | | **34** |

这些测试替代了旧插件的 smoke/verify：

- suite 的 15 个 smoke 断言的是单次 `ModuleLoader.load`、旧 id、旧 inject、两个 video 创建点——这些在合并后**本来就应该失效**；
- animation 的 5 个 verify 断言的是旧 `entry.js` 路径与旧素材目录；
- 新测试按**行为**重写：单层、双条件交接、失败不早拆、零残留。

---

## 5. 手工验收用例

### T1 Web 首屏：单层、单根、单脚本

**步骤**

1. `dsh --profile web`（或当前 Web profile）启动。
2. 打开 DevTools Console。

**断言**

```js
document.querySelectorAll('#dbn-root').length === 1
document.querySelectorAll('[id^="dsh-startup"], .dshba, .dshsaver').length === 0
window.__DBN_PLAN__ && window.__DBN_VERSION__
window.__BOOT_NEXUS__ && window.__BOOT_NEXUS__.state
```

- 页面只有一层动画；没有 suite 的黑幕/第二套 caption。
- Network 里没有 `/dsh-startup/splash.js`、`/plugins/dsh-boot-animation/*`。

### T2 Desktop 首屏：IPC 行可执行

**步骤**

1. 启动桌面 DSH。
2. 观察是否出现 `Failed to load plugins`。
3. Console 执行 T1 的断言。

**断言**

- 不出现整页 `Failed to load plugins`；
- `#dbn-root` 存在且只有一个；
- `__BOOT_NEXUS__.state` 从 `arming → playing → handoff → revealed`。

> 这是 B4 的实机裁决点：`kind:'script'` 内联在桌面应执行；`kind:'html'` 里的 `<script>` 不执行。nexus 只用前者。

### T3 冲突负向：旧插件仍在时主动让位

**步骤**

1. 临时启用 `dsh-boot-suite` 或 `dsh-boot-animation`（只启用一个）。
2. 重启，观察。

**断言**

- `#dbn-root` **不存在**；
- Console 无异常；
- 旧插件正常（或至少不出现两套层）。
- 如果看诊断日志，`inject` 结果为 `{"added":0,"skipped":"legacy-present"}`。

**通过标准**：不是"两个都跑"，而是"nexus 明确让位"。

### T4 交接：clientReady 与 clipDone 双条件

**步骤**

1. 用一个 3 秒短片，`boot.holdMs=0`，`boot.fadeMs=900`。
2. 观察退出时刻。

**断言**

- 片尾后**不立即**揭幕，等 app 的 `clientReady`；
- 两者都满足后才淡出；
- 若把 `boot.maxMs` 设为 5000，5 秒必揭幕（硬上限）；
- 不会出现"素材播完 → 黑屏 → 再黑幕"的二次退场。

Console 辅助：

```js
__BOOT_NEXUS__.on(e => console.log(e))
```

### T5 无素材

**步骤**

1. 清空 `clips/`（或全部禁用）。
2. 重启。

**断言**

- 黑幕出现，不白屏；
- `clip-done` 立即发生；
- `clientReady` 后淡出；
- 不抛异常，诊断日志含 `clip: none`。

### T6 播放频率

| 模式 | 步骤 | 期望 |
|---|---|---|
| `session` | 同一标签页刷新两次 | 第二次不播 |
| `daily` | 同一天刷新两次 / 改系统日期 | 当天只播一次；跨天再播 |
| `always` | 刷新两次 | 每次都播 |
| `?dbn=preview` | 任意模式 | 绕过频率，必播 |
| `?dbn=off` | 任意模式 | 不接管 |

### T7 屏保

**步骤**

1. `saver.enabled=true`，`idleMs=5000`，`rotateMs=3000`。
2. 静置 5 秒；移动鼠标。

**断言**

- 5 秒后进入屏保，视频循环/轮换；
- 任意 pointer/key/wheel/touch 唤醒；
- 唤醒后回到 `revealed`，不重新播片头；
- 屏保期间 `html.dbn-lock` 仍在，唤醒后解除。

### T8 卸载/清理

**步骤**

1. 记录 `__BOOT_NEXUS__` 和 `#dbn-root`。
2. 在设置页禁用 nexus，或 `plugin_manager remove_bundle dsh-boot-nexus`。
3. 重启。

**断言**

- 没有 `#dbn-root`、没有 `html.dbn-lock`；
- 没有 `__BOOT_NEXUS__` / `__DBN_PLAN__` 残留；
- 没有定时器继续触发（Console 无 `[dbn]` 日志）；
- 旧插件重新启用后能独立工作。

### T9 配置迁移与损坏恢复

| 场景 | 操作 | 期望 |
|---|---|---|
| 正常迁移 | 保留旧三份文件，首次启动 | 生成新文件；旧文件 mtime 不变 |
| 重复迁移 | 重启两次 | 第二次不覆盖新文件（digest 相同） |
| 未知键 | 旧文件加 `"foo": 1` | 新文件 `legacy.*` 保留 `foo` |
| 新文件损坏 | 写入 `{bad` | 备份 `.corrupt-<ts>`，写默认，能启动 |
| 并发保存 | 快速点两次保存 | 串行写，最后一次生效；不出现半截 JSON |

### T10 路由与安全

```powershell
curl.exe -i http://127.0.0.1:<port>/dsh-boot-nexus/health
curl.exe -i http://127.0.0.1:<port>/dsh-boot-nexus/plan.json
curl.exe -i http://127.0.0.1:<port>/dsh-boot-nexus/config
```

| 用例 | 期望 |
|---|---|
| `health` | 200，含 version/enabled/clips/savers |
| `plan.json` | 200，`no-store`，不含绝对路径 |
| `config` GET | 200，config/warnings/media/digest |
| `config` POST 合法 | 200，返回新 config |
| `config` POST 非法 JSON | 400 |
| `config` POST >64KB | 413 |
| `media/clip-1` | 200/206，`Content-Type` 正确 |
| `Range: bytes=0-99` | 206 + `Content-Range` |
| `Range: bytes=999999-` | 416 |
| `media/../../etc/passwd` | 404/400，绝不读文件 |
| `media/unknown` | 404 |
| 缺 `connection` 服务 | 403（fail-closed） |

### T11 设置卡

1. 打开设置页 → 插件 → 开机动画。
2. 改 `fadeMs=1200`、`saver.enabled=true`，保存。
3. 重新读取，值仍在；`dsh-boot-nexus.json` 已更新。
4. 点"预览"：URL 带 `?dbn=preview`，动画重播。
5. 禁用总开关，保存；刷新：不接管（`#dbn-root` 不存在或 phase=off）。

### T12 可访问性与降级

| 场景 | 操作 | 期望 |
|---|---|---|
| reduced motion | 系统开启"减少动态效果" | 无淡出/少动画；仍能交接 |
| 跳过按钮 | Tab 到"跳过" | 第一焦点；Enter 生效 |
| Escape | 播放中按 Esc | 立即 handoff |
| 点击画面 | `clickToEnter=true` | 跳过 |
| 视频解码失败 | 放一个坏 mp4 | 黑幕保留，超时揭幕，不白屏 |
| 私有模式 | 禁用 localStorage | 不抛异常；频率退化为每次都播 |

### T13 两幕（0.2.0）

1. 配置 `boot.suite=true`、`boot.suiteScene=archive-warm`、`boot.clip=auto`。
2. 启动：先出现暖白档案五步（需要访问许可 → 身份确认 → 接收需求 → 读取权限 → 核验通过），再切到随机视频。
3. 五步期间无旧 `dsh-startup-root`/`dsu-lock`；只有一个 `#dbn-root`。
4. 关闭 `boot.suite`：只播随机视频，不出现档案幕。
5. 把 `boot.suiteScene` 改成不存在的 id：只播视频，不白屏；diag 有 `scene` 跳过记录。

---

## 6. 冲突专项回归（最重要）

这一组不是"功能测试"，是证明**两个主人变成一个**：

| # | 场景 | 操作 | 期望 |
|---|---|---|---|
| C1 | 双旧插件 + nexus | 同时启用三者 | nexus `legacy-present` 让位；只有旧动画；无 `#dbn-root` |
| C2 | 双旧插件禁用 + nexus | 只启用 nexus | 只有 `#dbn-root`；无 `.dshba` / `#dsh-startup-root` |
| C3 | 注入表 | 重启后抓 `webserver/index-inject` 结果 | 只有 4 行；无 `__DSH_STARTUP_BOOT__` |
| C4 | 9 秒/15 秒 | 让片头持续 20 秒 | 9 秒不拆层；15 秒不二次退场；只在 handoff 拆 |
| C5 | 滚动锁 | 播放中/揭幕后检查 `html.classList` | 播放中有 `dbn-lock`；揭幕后无；滚动正常 |
| C6 | caption | 播放中查 `#dbn-caption` 与旧 caption | 只有 `#dbn-caption`，单一写者 |
| C7 | 路由 | 请求 `/dsh-startup/*`、`/plugins/dsh-boot-animation/*` | 404；nexus 不注册这些前缀 |
| C8 | 卸载 | 移除 nexus，启用旧插件 | 旧插件恢复；nexus 路由/行全部消失 |

**C1 是最关键的负向用例**：它证明 nexus 不会和旧插件"各跑一半"。如果 C1 失败，不要继续上线。

---

## 7. 验收清单

- [ ] `npm test` 34/34
- [ ] `npm pack` 产物可安装
- [ ] 旧插件已禁用/卸载，profile 无同 id 多行
- [ ] T1 Web 单层
- [ ] T2 Desktop 单层、无 `Failed to load plugins`
- [ ] T3 旧插件存在时 nexus 让位
- [ ] T4 双条件交接 + 硬上限
- [ ] T5 无素材不白屏
- [ ] T6 session/daily/always/preview/off
- [ ] T7 屏保进入/唤醒
- [ ] T8 卸载零残留
- [ ] T9 迁移/损坏/并发
- [ ] T10 路由/206/416/403
- [ ] T11 设置卡保存/预览
- [ ] T12 reduced motion / 跳过 / 解码失败
- [ ] T13 两幕：suite 档案 → 随机视频
- [ ] C1–C8 冲突专项
- [ ] 诊断日志可读（`$DSH_HOME/dsh-boot-nexus-diag.log`）
- [ ] 壁纸 P1 已明确"未实现"（不冒充已合并）

---

## 8. 回滚

nexus **不写**旧配置文件，也不改旧插件目录，所以回滚是纯安装层操作：

```text
plugin_manager remove_bundle dsh-boot-nexus
# 重新启用 dsh-boot-suite / dsh-boot-animation（去掉 profile patch 的 disabled: true）
# 重启 DSH
```

新配置 `$DSH_HOME/dsh-boot-nexus.json` 可保留（不影响旧插件），也可删除。旧配置未被修改，旧插件会按原值恢复。

---

## 9. 0.3.4 自包含验证（已执行）

把 `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-boot-suite` 与 `dsh-boot-animation` 临时改名为 `*.removed-test`，再运行：

```powershell
node scripts/verify-installed.mjs
```

结果：`ok: true`、4 行注入、5 clips/7 savers、7 条路由、`bootBytes: 57289`。说明：

- suite 引擎来自插件包内 `assets/suite`（`vendored: true`），不依赖原 `dsh-boot-suite`；
- animation 素材来自 `$DSH_HOME/boot-nexus/media`，不依赖原 `dsh-boot-animation`；
- 设置卡“素材池”区会显示这两个路径。

测试后目录已恢复。真正删除旧插件后，仍需完整重启一次做最终实机确认。

---

## 10. 已知未验证项

1. 壁纸渲染（P1，未实现）。
2. 动画素材授权：不随包分发；安装后需把旧 animation 的 5+7 个视频复制到 `$DSH_HOME/boot-nexus/media/{clips,savers}`（本机已完成）。
3. 0.3.4 的完整重启实机确认（当前运行进程仍是 0.3.3）。
