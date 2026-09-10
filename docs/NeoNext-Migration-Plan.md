# NeoNext 搬家执行计划

> 基线：当前分支 `main` 的 PiDeck v0.7.1（`1979f98d`），迁移源为 `neo-legacy-20260906`（尖端 `81d84b1c`）。
>
> 本文是执行顺序和能力审计，不是把旧分支整体合并的授权。当前施工分支：`neo-next/migration-plan`。
>
> 盘点日期：2026-09-06

## 1. 不变边界

1. `main`/`neo/main` 保持 v0.7.1 稳定基线；旧分支不 merge、不 rebase、不用 `-X ours/theirs` 吞冲突。
2. PiDeck 只负责窗口、进程、Session catalog、远程服务和 UI；Agent 行为、人格、工具、会话读写仍由 pi 负责。
3. 新功能必须以 `sessionId + agentId + runtimeGeneration` 为运行时目标。Room 是外层编排器，不能重新建立一套按 agent 全局索引的会话状态。
4. Neo 的长期记忆仍只有 `X:\CC\memory\` + Houkai；ROCKET 使用自己的项目规则/记忆目录，不复制记忆库进仓库。
5. 凭据、token、Tunnel、真实局域网地址和代理配置不入 Git。Web Remote 先 localhost/LAN 验证，之后才手工接 Tunnel。
6. 不恢复旧 `App.tsx`、旧 `styles.css`、旧抽屉壳；UI 2.0 只迁品牌 token/资产和产品语义。
7. 每个可合并批次都必须通过 `npm run typecheck` 和 `npm test`；不以“旧屋曾经能跑”代替新架构回归。

## 2. v0.7.1 现状审计

| 能力 | 现状 | 结论 |
|---|---|---|
| Session 归属、嵌套项目 | `SessionCatalog` 按 session 文件来源/路径建 origin key；`SessionRuntimeCoordinator` 维护 session/runtime/generation；已有多组 identity/runtime 测试 | **保留，不搬旧实现**；补真实嵌套项目回归 |
| Agent 复用 | coordinator 按 Session 激活，`AgentManager` 有创建竞态去重和 runtime 绑定 | **保留**；验同一 session 多入口只产生一个 runtime |
| 压缩和完整历史 | 已有 compaction 生命周期、取消静默、分页/缓存/摘要卡片测试 | **保留**；对照旧 `2a5c8db5`/`66439d10` 做边界回归 |
| ask_question | `ask-panel-atoms`、`AskPanelOverlay`、底部待答卡、batch/select/input/editor/confirm/取消和 web response 均已存在 | **P0 已部分完成**；只迁旧取消/批量行为差异，禁止退回普通文本追问 |
| 自动中文标题 | 当前有 Session title/手动 rename，但未发现旧屋独立 AI 自动标题链路 | **P0 待重接**；必须有手动锁和重启持久化测试 |
| 会话侧栏置顶 | 当前的 `pinnedSessionTabIds` 是 Tab chrome；没有旧屋 `pinnedAt` 会话偏好层 | **P0 待重接**；不能把 Tab pin 当 session pin |
| 后台完成未读点/小问题提醒 | runtime 状态、系统通知和 ask pending 已有基础；没有确认旧屋绿色未读点的 session-owned 持久/清除语义 | **P0 待统一**；状态归属放 Session 层，不在 App 匿名回调里补丁 |
| 文件引用 | 新版 Composer/引用链路存在 | **保留新版**；只从 `a702619d` 提取路径含空格的行为测试/规则 |
| 任务产物卡 | 当前刻意移除会话上方独立摘要卡，diff 入口靠工具调用和 Files 工作区 | **P1 重新设计**；优先复用现有 FileDiff/安全 IPC，不搬旧卡片壳 |
| Git 工作区 | 新版 Files/diff/editor 能力更完整 | **P1 对照后补差异**；不搬旧 Git panel JSX |
| 更新检查 | 已有手动检查回归测试 | **保留**；不要因迁移旧 `App.tsx` 重新启用自动更新 |
| Web Remote | 新版已是 session-first API、opaque session identity、SSE 和目标校验 | **保留协议**；当前 `WebServiceManager` 需补回旧屋 token、timing-safe、限流、body 上限和鉴权测试 |
| Neo 品牌 | 当前 assets 只有通用字体/编辑器资源，未见 NeoNisch Logo A、Montserrat、头像/启动图整套 | **P0 待迁资产和 shell**；只做增量 UI 2.0 接入 |
| Neo × ROCKET Room | 当前没有 `src/main/room` | **PARKED/可选实验**；实用性不足，不阻塞 NeoNext，不能直接 cherry-pick 旧 RoomManager |
| Mobile Remote UI | 当前有新的 Web React 单栏壳，但旧 mobile token/PWA/移动 ask 改动不在现行链路 | **P1 后半段**；先安全协议，再按新 Web 组件改 UI |
| 用量统计 | 当前已有通用 pi-tracker `usageStats`；没有旧屋 DDD/SX/DeepSeek 三套余额服务 | **P2 分层迁移**；先确认 provider 凭据/口径，不能混算余额、订阅额度和 token |
| 每日总结/自主活动 | 当前未见 `src/main/automation` | **P2**；旧实现依赖独立 Agent、审核和严格节流，不能先塞进启动流程 |
| 官网/许可证/README | 当前 v0.7.1 文档是上游基线 | **P2 最后处理**；用 release-note 同步脚本，不手改亮点区块 |

## 3. 旧分支 65 个提交分类

分类含义：

- **P0-适配**：必须恢复，但按新版契约重写或提取纯逻辑。
- **P1-适配**：主力切换后优先恢复。
- **P2-后置**：旧屋可继续承担，不阻塞首个可日用版本。
- **保留/不迁**：新版已有、纯清理、设计演示或会破坏当前架构，不搬代码。

| 提交 | 分类 | 迁移动作 |
|---|---|---|
| `b4f5ac09` | P0-适配 | 提取 NeoNisch glass token/视觉规则；不用旧全局 CSS |
| `04da4053` | P0-适配 | 提取 titlebar brand lockup 资产和尺寸 |
| `94526fe0` | P0-适配 | 只迁品牌 shell 需求，重做为 AppShell/UI 2.0 |
| `a2d6018f` | P0-适配 | 迁启动资产/过渡状态，保留首帧超时和清理 |
| `c334ee76` | P1-适配 | 对照新版 SessionStartSurface/controls，提取行为而非 JSX |
| `a6673e77` | P0-适配/保留 | 归属修复由新版 identity 契约覆盖；只补嵌套项目回归 |
| `86774285` | P0-适配 | 与 `a2d6018f` 合并为一套启动体验，避免两套 splash |
| `d66b37e1` | P0-适配 | 迁移 collapsed sidebar 的品牌显示规则 |
| `d67b19db` | P0-适配 | 对照新版 ask 状态机补 batch + custom input 回归 |
| `46d11652` | P0-适配 | NUL redirect extension 和 symlink 扫描按现有 Extension/Skill 契约提取 |
| `a702619d` | P1-适配 | 只迁文件引用 token 行为和含空格路径测试 |
| `33e38ef1` | P1-适配 | 对照新版 usage/cache 口径，不能覆盖现有统计实现 |
| `a73f8e8f` | P0-适配 | 迁 Montserrat 字体及品牌短标题用法，不铺满正文 |
| `03978240` | 保留/不迁 | 合并提交本身不作为功能来源 |
| `2a5c8db5` | P0-保留 | 新版已有 compaction 修复；仅做对照回归 |
| `f23883df` | 保留/不迁 | 旧设计预览清理，不搬 |
| `4915ea5a` | P0-适配 | 以 Session-owned unread 状态重做绿色完成点 |
| `58a6b0ae` | P1-适配 | 对照新版 Files/diff/git 领域补 working tree/history/remote 差异 |
| `d18ad872` | P0-适配 | 对照新版 runtime 事件/发送行为，提取安全边界 |
| `609d569d` | P1-适配 | 只取 Git 信息架构和紧凑性，不搬旧组件 |
| `d7a6222e` | P1-适配 | 对照新版 stop/runtime dock 补时间/状态语义 |
| `93235755` | P0-适配 | 重写 session-owned 自动中文标题，独立 runtime，手动改名永久锁定 |
| `4458609e` | P1-适配 | 对照新版 drawer/composer 策略菜单补差异 |
| `ab4b6ca1` | P1-适配 | 只取 Git 区块密度/远端信息 |
| `d4ce237d` | P1-适配 | 缓存诊断口径对照新版 usageStats；更新仍保持手动 |
| `0999d098` | 保留/不迁 | 旧缓存诊断修补与旧结构绑定，按现有实现重新验证 |
| `5097d462` | P1-适配 | 产物识别/预览纯逻辑提取；复用现有项目路径校验和 diff viewer |
| `4817adcd` | P0-适配 | 小问题/等待回答映射到 session 状态和 ask pending，不依赖 toast |
| `ce5e70e8` | P2-适配 | 桌宠交互可后置；对照当前 PetStateBridge，不迁替代方案页面 |
| `4ca762c7` | P2-适配 | 只取宠物巡游方向修复逻辑，先确认新版宠物状态机 |
| `52e44f42` | PARKED | Room 暂不迁移；保留外层编排/隔离设计约束，确认真实使用场景后再做实验批次 |
| `66439d10` | P0-保留 | 新版分页/压缩历史已有对应契约，做完整历史回归 |
| `12d0e4c7` | P2-适配 | AGPL/README 定位最后处理，遵循发布流程 |
| `155e1b34` | 保留/不迁 | 旧临时产物清理不作为功能迁移 |
| `1420a068` | P2-适配 | 官网展示最后重做，不搬旧站点结构 |
| `d5c83c99` | P2-适配 | Pages 权限按最终站点部署配置单独处理 |
| `f4dfb2b0` | P2-适配 | 缓存/宠物小优化随对应模块迁移 |
| `b5ea1fd7` | P2-重写 | SX usage service 按新版 settings/IPC/usage domain 重做 |
| `f705a62f` | P2-重写 | DeepSeek service 按真实 provider/hostname 判定，补凭据脱敏测试 |
| `27052739` | P0-适配 | 自动标题持久化回归，确保重启不丢且手动标题不覆盖 |
| `da01075f` | P1-重写 | 只迁 token/timing-safe/限流/body 上限协议；适配 session API |
| `fc19937e` | P1-适配 | 移动单栏交互对照新版 Web UI |
| `8ae90315` | P1-适配 | 汉堡菜单/遮罩作为新版 Web 组件行为补充 |
| `101cf730` | P0-适配 | 移动端统一 Neo Logo A，依赖品牌资产批次 |
| `2ffa0906` | P1-适配 | 状态详情使用底部弹板，按新版 Web token 重做 |
| `fbf45545` | P1-适配 | manifest/icon 可迁；注明 LAN HTTP Android 安装限制 |
| `e14c89f2` | P0/P1-适配 | 移动 ask response 接入 session target + SSE 恢复 |
| `ba182822` | P0-保留 | 安全清理结论保留；逐项检查新架构是否已有，不能按旧删除清单反向删除 |
| `1355fff4` | P1-保留 | 新版 Web 已有 SSE；只补协议/断线回归 |
| `8dbd1069` | P0-重写 | `SessionPreferenceStore` + `pinnedAt`，与 Tab pin 分离 |
| `77e405c8` | P2-重写 | DDD usage/cache 服务按新版 usageStats 口径接入 |
| `5cba6065` | P1-保留 | 新版 SSE/event stream 已有；补断线、背压、EOF 测试 |
| `220fb31a` | P2-重写 | 每日总结独立 automation domain，审核后才写记忆 |
| `8b4fb1ff` | P2-重写 | 固定模型/单 Agent 约束作为 automation 设计门禁 |
| `2a7a1481` | P2-重写 | DDD 订阅额度单列，不和钱包/成本混淆 |
| `1b7b57d9` | P2-重写 | 自主活动完整重做，不能直接接启动生命周期 |
| `feeb6aad` | P2-保留 | 续轮节流回归：不能省略 |
| `ae5f571c` | P2-保留 | 最低 60 分钟续轮门禁 |
| `d13991b4` | P2-保留 | ISO/毫秒时间戳兼容回归 |
| `ce986df3` | P2-适配 | 自主活动模型作为独立设置，默认回退 pi 配置 |
| `9be9986e` | P0-适配 | 对照新版底部 ask card/取消状态机，必须保留真取消 |
| `0078eb6e` | P1-适配 | 模型配置 UI 对接新版 settings/Session launch preferences |
| `184ce2ca` | P2-保留 | 每日总结传文件路径，不把全文塞 prompt |
| `9c07b8aa` | P2-保留 | 当日预过滤和临时文件边界保留 |
| `81d84b1c` | 保留/不迁 | 本盘点来源，不 cherry-pick |

## 4. 执行批次

### Batch 0：基线与回归合同

- 仅在 `neo-next/*` 分支工作；先记录干净基线。
- 为新版现有能力补缺口测试：
  - 嵌套项目按 session 自身 `cwd/projectPath` 归属；
  - 同一 `sessionId` 的重复 activate/send 只绑定一个 Agent；
  - compaction 成功、失败、取消、重启后历史完整；
  - ask 单题、batch custom input、Stop/null、多 session 切换不串请求；
  - 手动更新检查没有自动触发。
- 门禁：`npm run typecheck`、`npm test`。

### Batch 1：P0 协作状态

1. 在 `shared/types/session.ts` 增加 session-owned 的最小字段/命令契约（优先确认是否能由现有 status/metadata 推导，避免新增重复状态）。
2. 增加独立纯策略模块和测试：
   - `pinnedAt` 排序且不被普通可见条数截断；
   - background completed/unread 的产生、清除和 session 切换；
   - pending ask 的提醒与 focus session 清除。
3. 自动标题通过独立 Agent/runtime 生成：输入只取稳定会话内容，写回 `SessionCatalog`；手动 rename 后设置锁，生成任务迟到也不能覆盖。
4. 任务产物先只抽“成功写文件 → 最多 3 个候选”的纯识别逻辑；预览/系统打开必须继续走项目路径校验和 sandbox。
5. ask 只做新版状态机的缺口修复，不恢复旧 `App.tsx`。

门禁：新增 `sessionPreferences`、`sessionUnread`、`sessionAutoTitle`、`askQuestion` 回归测试，加跑全量 typecheck/test。

### Batch 2：Neo 品牌与启动

- 从旧分支按文件提取以下无业务资产：
  - `neonisch-app-mark.svg`、深浅 Logo A 变体；
  - `Montserrat-SemiBold.otf`；
  - 必要的 splash/avatar/background（人物立绘和观察站背景默认不常驻）。
- 用新版 `AppShell`/`AppHeader`/`SessionStartSurface` 接入：
  - 深浅环境同一 Logo A；
  - 无闪白、首帧不被动画阻塞、超时安全退出；
  - collapsed sidebar/titlebar/mobile 三处同一品牌入口。
- 样式只新增 Tailwind utility 和 token；旧语义 CSS 触达处同步收窄，不能复制整个旧 `styles.css`。

门禁：品牌资源路径/build artifact 测试，桌面手工 smoke；不在此批次引入 Room/自动化。

### Batch 3：Remote 安全和移动 ask

- 适配新版 session-addressed Web API，而不是恢复 `/api/agents/:id` 旧入口。
- 迁入并测试：随机 token、`Authorization: Bearer`、timing-safe compare、按 IP 请求/鉴权失败限流、2MB body 上限、same-origin 策略。
- 网络端只接受 opaque `sessionId`；拒绝原始 session path、`..` 和跨项目引用。
- SSE：连接建立发送当前 state/message snapshot；断线/EOF/前后台恢复重连；背压只保留最新快照。
- `/api/ui-response` 必须携带 `sessionId + agentId + runtimeGeneration + requestId`，旧 runtime 一律拒绝。
- 移动 UI 在新版 Web React 组件上做单栏、汉堡抽屉、底部状态弹板和 ask 卡；PWA manifest/icon 可随后加入。

门禁：无 token、错 token、爆破、超大 body、路径泄漏、跨 runtime response、SSE 断线恢复测试；LAN 手工验证后才考虑 Tunnel。

### PARKED：Neo × ROCKET Room

暂不进入 NeoNext 主迁移线。保留来源 `52e44f42` 和以下设计约束，确认真实高频使用场景后再开独立实验批次：

- Room 只能是外层编排器，不能维护第二套消息缓存或绕过 Session runtime target。
- Neo 与 ROCKET 必须各自独立 Session/runtime、`PI_CODING_AGENT_DIR`、人格和记忆权限；不能靠 prompt 声明作为唯一隔离。
- `@Neo/@ROCKET/@两人` 必须是有限路由，禁止自动互相触发；清屏只清显示边界，新开一桌才新建上下文且旧历史不删。

### Batch 4：P1 工作台收口

- 文件引用、Git 信息、产物预览、桌宠按各自新版 domain owner 接入。
- 只迁 `a702619d`/`58a6b0ae`/`5097d462` 的行为规则和测试，不迁旧 UI 壳。
- 检查所有新增 IPC 是否同步 `shared/ipc.ts`、main handler、preload，订阅有 unsubscribe。

### Batch 5：P2 用量与自动化

1. 先接 provider adapter 和脱敏凭据读取，再接 UI；DDD/SX/DeepSeek 分别展示余额、订阅额度、成本和 cache 含义。
2. 每日总结：单 Agent、固定模型策略、时间戳兼容、临时文件、可编辑审核；只有确认后才调用权威记忆双写。
3. 自主活动：AWAY + Windows idle 40 分钟才启动；续轮至少 60 分钟；90 分钟/12 轮上限；主人回来、关闭或退出立即取消。
4. 官网、README、许可证、Pages 和发布说明最后处理，按脚本同步并核对中英文。

## 5. 禁止的迁移方式

- 不执行 `git cherry-pick neo-legacy-20260906~65..neo-legacy-20260906` 之类连续搬运。
- 不用旧 `App.tsx`/`styles.css`/`src/main/index.ts` 覆盖新版文件。
- 不把 `agentId` 当持久 Session ID，不把 Tab pin 当侧栏 session pin。
- 不把 Room 的两条消息复制成第三份长期历史，不让 ROCKET 共享 Neo 的 Agent 目录或记忆工具。
- 不为了“先能用”取消 runtime target 校验、Web 鉴权、ask 真取消或自动化审核。
- 不复制 `X:\CC\memory\`、Houkai 数据或任何凭据到仓库。

## 6. 完成判定

NeoNext 替代旧屋前，至少通过：

1. 品牌启动、深浅主题、桌面/移动 Logo 一致且无白屏/卡死。
2. 嵌套项目 session 归属正确，同 session 不重复 Agent。
3. 长流式、历史分页、压缩前后历史完整。
4. ask 单题/batch/custom/editor/confirm/取消/Stop/多会话切换，桌面和手机都能完成。
5. 自动标题、手动锁、置顶、未读、小问题提醒可跨重启恢复。
6. Web 无 token 不可用、不泄露路径，SSE 重连可恢复 pending ask。
7. 更新手动、凭据/记忆不入库、日志可诊断且不含 secret。
8. P2 收口时再验每日总结审核和自主活动全部节流边界。（Room 在 PARKED 期间不设验收项）

## 7. 当前下一步

1. 先实现 Batch 0 的缺口测试，确认哪些 P0 已由新版隐式覆盖。
2. 再做 Batch 1 的 session preference/unread/title 设计，不碰品牌和 Room。
3. 通过 P0 门禁后，再按 Batch 2→3→4 顺序迁品牌、Remote、工作台；Room 保持 PARKED，不进入主线。
4. 每批完成后保留工作树 diff，**不自动 commit**；需要提交时由主人明确指示。
