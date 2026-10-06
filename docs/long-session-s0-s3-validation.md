# 长会话稳定读取与传输：S0–S3 实施与验证

日期：2026-10-06。范围仅第一阶段；不是所有闪退已解决的声明。

## 边界与证据核对

- 读取了桌面《PiDeck-长会话记录可见性修复操作手册.md》与项目 AGENTS.md。
- 原有 `Package-PiDeck-Dev.bat`、`src/main/automation/DailySummaryTask.ts` 修改保留，未纳入本修复。
- 样本 A 的原 JSONL 路径已不存在，只找到 edit-backup。本轮没有把备份当作原记录，未验证旧手册的 21 轮和第 14 轮结论。
- 当前 package.json 的 Electron 是 43.4.0，不是 AGENTS/README 简介中的 38。源码和日志标记均为 0.7.1，但未验证打包二进制与当前源码完全一致。
- 本轮只读核对样本 B：450,804,057 字节，2,042 条非空 JSONL，1,840 个 message、5 个 compaction；语法解析失败 0；206 个 image，base64 共 446,305,288 字节；最大行 11,506,249 字节。语法有效不等于完成所有业务字段验证。
- 样本 B 前后 SHA256 一致：`860ac4458a187204bb11a7f8d1d0bf5282022c4135f054be5f59657ebf88dc5b`。
- 应用日志可确认 renderer 的 oom/crashed 记录及自动压缩成功后缺少历史完成记录；不能把这些关联当作最后一次整个进程退出的确定根因。本轮未重采 Windows AppHang/dump。
- 测试、类型检查和只读回放先列出范围，经用户确认后执行。实施与验证阶段没有 Git add/commit/push，没有构建、打包、覆盖产物、关闭/重启应用、真实 pi/模型调用；原会话和原图未修改。
- 后续用户另行授权的提交范围：仅将本次 S0–S3 修复合为一个本地 commit，排除原有两处工作区修改，不 push。

## 改动清单

### S0：固定复现与测量

- `tests/longSessionStability.test.mjs`：真实生产读取器覆盖活动分支、坏行/残行补全、UTF-8/CRLF、并发共享索引、追加、重写、预算错误及全文缓存。
- `tests/agentHistoryReload.test.mjs`：真实 AgentManager 的压缩事件重载、大文件叶节点查询、runtime 替换/代际变化/停止、并发重载、文件追加和流式消息保护。
- `tests/piRpcFraming.test.mjs`：真实 RPC 客户端覆盖分帧工作量、尾行、协议污染、请求身份、预算、关闭/错误；PiProcess 真实 owner 加 mock 子进程验证致命传输失效。
- `scripts/benchmark-session-history.mjs`：生产 Reader/Projector/RPC 独立 Node 回放，支持只读实样和合成冷/热/追加。
- `scripts/audit-session-history.mjs`：生产 JSONL 扫描器只读计数与哈希；只输出元数据，不输出正文或图片。

### S1：流式读取和统一轻量索引

- `src/main/pi/JsonlScanner.ts`：256 KiB 分块、完整字节 offset、跨块 UTF-8、CRLF、残行；逐条正文读取，不同时分配一页所有大行。
- `src/main/pi/SessionDisplayIndex.ts`：元数据索引、父链活动分支、同文件建索引请求合并、跨文件扫描串行、LRU/元数据预算、文件身份/版本与退出失效。
- 增量解析前流式校验完整旧前缀 SHA256，替代不足以证明纯追加的采样探针。避免漏掉未采样区域的同长度父链改写；代价是追加时仍有 O(旧文件大小) 哈希 IO。
- `src/main/pi/SessionHistoryReader.ts`：最近正文、身份、页读取、压缩摘要、按需全文共用索引；最近轮次来自活动父链，不再混入物理尾部的弃用分支；压缩摘要只取活动分支。
- 正文读取前后检查打开文件和路径快照；全文缓存按文件版本失效，并有数量/字节预算及 dispose。
- `src/main/ipc/sessionIpc.ts` 与 `src/main/index.ts` 各移除一处全文件预读，只保留读取器调用；`src/shared/types/session.ts` 仅更新不透明快照版本的契约注释。没有新增 IPC 或 UI 能力。

### S2：统一历史重载

- `src/main/pi/HistoryReloadController.ts`：公共大小准入、请求取代、session/runtime/process/client/代际保护、文件快照重试和加载中消息保留策略。
- `AgentManager.loadMessages` 是统一入口；首次打开不再预先绕过策略发 RPC。现有手动/自动重连、压缩成功/失败事件、编辑/删除/重发、模型刷新和恢复路径均调用此入口。
- 大于 5 MiB 的文件不发无界 get_messages/get_entries，直接读取有界最近展示消息和真实 entryId。RPC 失败后的文件 fallback 也有预算；未知文件大小不授予全量 RPC 权限。
- 编辑前获取真实 Pi leaf 时，大文件以本地尾条目作为 get_entries 的 since，避免为一个 leaf 运输全部图片历史。
- 被取代请求只丢弃结果；仍有效请求遇到文件变化，最多重读一次最新有界本地快照，持续变化则明确失败，不记录“成功但未加载”。
- 运行期新增/修改消息及进行中工具/assistant 身份被保护；assistant 的 partial/pending 快照按 entryId/精确 Pi 时间戳关联。事件侧保留 Pi 源时间戳；加载开始时捕获进行中身份，完成后也不丢更新。工具按 toolCallId 关联，但另外比较变化中的正文/状态，避免稳定身份指纹吞掉新结果。
- 历史失败不改变仍可用运行时的 idle 状态；后台启动重试也校验原 runtime/process。

### S3：线性 RPC 分帧

- `src/main/pi/RpcLineFramer.ts`：只扫描新块；小碎片分批归并，防止 1 字节分块造成无界数组槽位；整行到齐后合并，不重扫累计前缀。
- `src/main/pi/PiRpcClient.ts`：保留 StringDecoder/CRLF/尾行/id/pending/协议污染语义；行预算失败明确拒绝 pending、释放缓冲/listener/timer，不静默丢块。
- `src/main/pi/PiProcess.ts`：超限/流错误即时通知 owner，失效 runtime 并终止对应子进程，沿已有错误状态路径反馈。正常 EOF 先关闭 transport、拒绝 pending；等待最多 1 秒确认 child exit，正常 exit(0) 保留原恢复语义，超时才标错/终止；退出时清理 grace timer。AgentManager 不把 error runtime 的退出当作 clean exit 自动重连。
- 没有增加常开全文 RPC 诊断日志。

兼容测试更新：`agentHistoryThinking.test.mjs`、`agentManagerWslPaths.test.mjs` 使用真实拆分依赖图，WSL mock 改为有界文件接口；`agentManagerRuntimeCache.test.mjs` 严格验证强化后的文件版本；`sessionFileEditorAgentManager.test.mjs` 补领域依赖和文件大小替身。未放宽行为断言。

## 红 → 绿证据

初始 16 条测试 4 绿/12 红。其中压缩事件测试首次写错了方法名；该次错误不算产品复现。修正方法名、仍未修改生产代码时，4 条重载回归单独运行全部失败。

独立审查追加的 3 条回归（文件追加假成功、更新 assistant 双份、未采样中部改写）先失败，再修绿；RPC 致命关闭 owner 回归也先失败再修绿。最终复核补充真实事件时间戳/pending、正常 EOF 排序及超时、加载期间 assistant 完成的失败回归，再修绿。

新增工具更新保留用例初测也受测试夹具的通用错误翻译器影响；改用真实 mainProcessT 后，继续严格断言新工具正文。未把翻译器夹具错误冒充产品复现。

最终门禁：

- `npm run typecheck`：通过（tsc --noEmit）。
- `node --test tests/longSessionStability.test.mjs tests/piRpcFraming.test.mjs tests/agentHistoryReload.test.mjs`：33/33，通过。
- `npm test`：2,243/2,243，通过；0 失败、0 跳过。
- `git diff --check`：通过；既有 bat 的 CRLF 提示不表示该文件被本轮改写。

## 修复前后资源对比

同机 Windows，Node v24.15.0，独立顺序运行；未运行 Electron 窗口或真实 pi。下列是单次记录，不是统计置信区间/CI 毫秒阈值。

RSS 使用进程 `resourceUsage().maxRSS` 高水位，覆盖该次冷/热回放；heap 为 5 ms 与阶段边界采样最大值，不能视为同步解析瞬间的严格峰值。事件循环延迟覆盖回放及 TypeScript 测试加载器初始化，不全等于生产解析停顿。

### 样本 B（450.8 MB）

| 指标 | 修复前 | 修复后 |
|---|---:|---:|
| RSS 高水位 | 2,867 MiB | 214 MiB |
| 采样 heapUsed 最大值 | 2,264 MiB | 62 MiB |
| 冷恢复（最近正文＋索引身份＋压缩扫描） | 3,321 ms | 1,734 ms |
| 热恢复 | 2,113 ms | 35 ms |
| 事件循环延迟最大值 | 971 ms | 160 ms |
| 活动消息 / 压缩条目 | 1,840 / 5 | 1,840 / 5 |
| 最近消息条数 | 111 | 111 |
| 最近投影 JSON 字节数 | 126,129 | 128,127 |

投影载荷略增来自真实 entryId 身份；这是序列化的 IPC 载荷代理测量，不是 Electron 实际 IPC/renderer 内存测量。最终冷索引只扫描一次，元数据预算估算占用 1,558,902 字节，无 image base64。大行解析单项最大耗时本轮测到约 8 ms（前一次约 13 ms）；没有证据支持为此默认引入 worker，但总回放仍有停顿。

### RPC 有效 JSON 行，64 KiB 分块

| 行体积 | 修复前 | 修复后 | 修后确定性扫描字符数 |
|---|---:|---:|---:|
| 16 MiB | 577 ms | 28 ms | 16,777,247 |
| 32 MiB | 2,397 ms | 63 ms | 33,554,463 |
| 64 MiB | 9,427 ms | 81 ms | 67,108,895 |

每次只收到一个有效事件，最终缓冲为 0；不再近四倍递增。三档同进程回放 RSS 高水位由约 886 MiB 降到 463 MiB。完整大行 JSON.parse 仍有一次大分配，因此不能脱离 S2 去运输全历史。

### 合成 96 MiB 图片历史＋20 个最新文本轮次

| 指标 | 修复前 | 修复后 |
|---|---:|---:|
| RSS 高水位 | 848 MiB | 194 MiB |
| 冷恢复 | 529 ms | 374 ms |
| 热恢复 | 573 ms | 1 ms |
| 追加一条后的索引读取 | 9 ms | 202 ms |

**追加变慢是已知取舍，不粉饰为所有指标优化。** 原探针便宜但会漏中部改写；完整前缀校验重读旧字节，只对新增字节解析 JSON。未修改样本 B 来测试真实追加。

## 资源预算

- 文件单行：128 MiB；正文单次聚合：32 MiB（软分页预算仍为 256 KiB，保持轮次边界）。
- 单索引元数据估算：16 MiB；所有索引 LRU：最多 32 项且估算不超过 32 MiB。
- 单 compaction 摘要：65,536 字符；身份字符串：1,024 字符。
- 文件全文文本缓存：200 项且最多 8 MiB；RPC 单行：128 MiB。
- 超限返回明确资源错误，不把有效历史默默丢掉。极大单条/单轮需要后续按需阅读能力；本轮没有实现大条目占位 UI。

## 未解决/未验证的风险

1. 第二阶段 UI 完全未实施：独立完整目录、目标轮页、按钮双向分页、图片点击加载、历史阅读发送行为仍保持现状；样本 A 旧可见性问题未据此宣称解决。
2. 源码修复尚未构建/装入当前运行应用。未进行真实继续生成/压缩 smoke，也未测 renderer 或 pi 子进程；不能说所有闪退已解决。
3. pi 自身加载大历史、原有 SessionFileEditor 大文件编辑/重写、导出等其他业务路径仍可能全量处理文件，不属于本轮展示读取底座的内存保证。
4. 完整旧前缀哈希使追加后的索引读取有线性 IO 成本；持续追加期间最多一次快照重试仍可能失败，应显式重试，而非无限循环。
5. 最新页/实时事件的图片解码和 renderer 驻留未由本轮解决；超大合法 RPC 行会触发明确失效，需真实产品 smoke 观察阈值和错误体验。
6. 极多条目的元数据会触达预算；本轮给明确错误，不保证任意长度常量内存。单行 JSON.parse 与 GC 仍可能带来延迟。
7. 原先整进程退出的最终原因仍缺 dump/退出证据；Node 隔离资源改善不等于完整应用崩溃验证。

原始结果目录：`X:/CC/diagnostics/pideck-s0-20261006-1747/`（red-tests、red-reload-corrected、red-review-findings、red-fatal-owner、red-event-identity、red-eof-ordering、red-settled-preservation、before/after-history、before/after-rpc、before/after-synthetic、sample-audit、前后 SHA256、门禁日志）。没有私有 JSONL/图片拷贝进入仓库。
