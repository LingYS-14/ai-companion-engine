# 设计说明

本文记录跨模块的关键设计取舍。每条都对应代码里的注释与测试，改设计时请同步改这里的理由。

## 1. 身份：协议，不是人格卡

早期版本用一张 JSON 人格卡（姓名、口癖、禁忌）注入提示词。问题是：卡一旦冻结，她就永远停在写卡的那一刻，既不会长大，也容易变成"扮演角色的助手"。

现在的做法：

- **身份协议**（`src/dialogue/protocol-identity.ts`）只有四条：第一人称、不自称 AI/程序、不客服化、身份来自记忆而不是设定。
- **人格由记忆与状态长出来**：关系进度、依恋参数、说话风格由 `modeStyle` / `stageStyle` 与真实互动累积形成；`SelfModel`（长期自我叙事）在数据足够后才会启用。
- 名字/头像只是 UI 标识（`displayName` / `characterId` / `assets/avatar.png`），可以随时换，不影响内核。

这条设计来自「移除人格卡、保留身份协议」的取舍。旧的 persona 文件已被删除；`persona/example.json` 只是 schema 示例。

## 2. 时间要当事实，不要当推测

模型很容易编时间（"现在晚上十一点"其实才九点）。因此：

- 每拍构造 `TemporalSnapshot`：本地时间、星期、醒着多久、距上次说话多久、这之后主动了几次没被回、上次睡眠、下一次睡眠窗口、presence。
- 提示词里的时间行由 `buildSituationNote` **只输出事实**，不写"也许""大概"；事实缺失就写"你还不知道"。
- 说话后可以校验"时间声称"：`speak-metrics` 提取"现在 N 点 / N 小时没说话"等表述，与快照比对，不一致时记录 `[time-claim]`。这是观测，不阻塞说话。

## 3. 能量与睡眠

- 能量 `energy ∈ [0,1]`。清醒每拍按 `wakeDrain × 基础率` 下降；drowsy 也算清醒（否则会锁死在半睡）；睡着时按恢复率上升。
- 睡眠状态机（`src/engine/sleep.ts`）：`awake → drowsy → asleep → waking → awake`。
  - 入睡需要 `sleepPressure > 0.8`（即能量约 <0.2）且安静 ≥ 20 分钟；
  - 睡着最短 4 小时（`min-window` 唤醒）、最长 9 小时；
  - 夜里被叫醒取决于消息与 `SLEEP_WAKE_ENERGY`（默认 0.65）。
- 夜晚预算（`SLEEP_NIGHT_BUDGET`，每晚 8 次）用于限制夜间模型调用（目前只有 dream 会消费）。

## 4. 夜间功课：挂在「入睡后首拍」

旧实现只在「跨本地 03:00」时做 fade / consolidate / dream。但她由能量驱动，通常 03:00 后才入睡，导致夜间功课实际从未触发。

现在的语义（`F340`）：

- 入睡后**第一拍**（`phase === "asleep"` 且 key 变了）执行一次 `runEpisodeWork`：fade → archiveCold → consolidate → sleepWork。
- 以 `asleepSince`（毫秒）作为 episode 键，先落盘 key + lastSleepAt 再跑功课；失败保留 key，本段不重试（避免重复扣 vividness）。
- 重启后 `backfillSleepWork` 对上一段睡眠补做一次；dream shadow 只在正常拍触发（回填不调度 dream）。
- 观测标记：`[sleep-work-onset]`（首拍）、`[fade]`、`[sleep-work]`、`[dream-shadow]`；`data/dream-shadow-<character>.ndjson` 是审计文件，不影响记忆。

## 5. 意图引擎

- **累积器**：每个意图类（reach_out / continue_thread / repair / idle / withdraw）有一个 `v`，每拍 `v = (1−λ)v + drift + ξ`（λ≈0.35/h，ξ 为噪声）。`drift` 只在「缺口扩大」时为正（例如很久没说话、关系变化），否则只有衰减。
- **竞争**：取最高分，超过阈值（`EMIT_THETA`，reach_out 0.6）且过完刹车才开口。
- **刹车**（缺一不可）：睡眠/quiet、额度（cap）、同类 30 分钟 gap、每日上限、F309 温和刹车、F350 重复抑制（同目标 24h 内说过就不说）、F341 lookahead（到点浮现）、F312 记账（attempts / 6h 窗口）。
- **F312 记账**：每次尝试（成功/held/blocked）都写回意图记录；5 次失败后降级/放弃，避免死循环重提。

> 取舍（D12=A）：接受"静默期不累积、只在有变化时开口"，不引入常驻底噪。

## 6. 回声防护（anti-echo）

问题：她会把自己说过/写过的句子再喂回提示词，形成"周末别排太满"式的复读。

三层防线：

1. **recall 来源过滤**：`excludeSources` 排除自述来源（selftalk / chat_reply / dream / proactive 在 T2 例外之外）；补位顺序 T1 真实互动 → T2 ≤1 条 proactive → 空。
2. **selftalk 选材**：`seedsFor(excludeSources)` + Dice 闸门（0.65 日记 / journal 去重）。
3. **重复抑制**：开口前 `findRecentRepeat` 对比 24h 内已发送记录（同 goal 或 source_ids 交集），命中降为 journal 不发送。

## 7. 模型调用策略

- 单供应商双档：`deepseek-flash`（默认；自述/主动/学习摘要）与 `deepseek-v4-pro`（对话、dream、整合、自我模型）。
- **thinking 必须显式声明**：请求体带 `thinking: { type: "enabled" | "disabled" }`；不传时思考链会吃满 `max_tokens` 导致空回复。thinking 开启时不传 temperature。
- 额度：峰时（北京时间 09–12、14–18 工作日）30 次/小时，谷时 60 次/小时，休息日 ×1.5；cap 是硬上限。
- 用量记账：`[llm] task=… model=… in=… out=… cached=… miss=…`（有缓存字段才输出），便于算成本与命中率。

## 8. 网页能力

- `src/web/` 只做「搜索/抓取」两件事，默认关闭（`WEB_SEARCH_ENABLED=0`），由 learning 与工具面共用同一套额度/域名策略。
- 抓取限制：https/443、重定向 ≤3、8s 单次超时、24s 总预算、256KB 截断、content-type 白名单。
- 外部内容一律标 `[web·untrusted]`，进知识库时按不可信来源打污点；不直接进对话记忆。

## 9. 观测与验收指标

设计目标的量化口径（`tools/observe/acceptance-metrics.mjs`）：

| 指标 | 含义 | 数据来源 |
| --- | --- | --- |
| M1 处境事实率 | 处境行里推断词占比 | `[situation] lines/inferred` |
| M2 夜间在场率 | 睡眠区间内 tick 覆盖与 shadow | `[sleep]`、dream shadow |
| M3 睡眠产出采纳率 | dream 成果被召回的比例 | `[recall-hit]` × dream 记录 |
| M4 能量动态范围 | energy 的 min/max/样本数 | `[sleep]` 行 |
| M5 时间一致性 | 时间声称与快照的一致性 | `[time-claim]` |
| M6 人格外部化率 | 说话中可观测的偏好/态度 | 周度人工消融 |
| M7 首条消息多样性 | 主动开口首句的熵 | `[qq]`/`[proactive]` 日志 |

## 10. 取舍记录

- **不引入图数据库/向量库**：单机、单用户、数据量小；JSONL + SQLite 足够，换底座成本大于收益。
- **不引入 Temporal/LangGraph**：tick 是单写者串行循环，编排复杂度在状态机内部；引入外部编排只会多一个故障点。
- **意图引擎是自研的**：外部 agent 框架的规划层面向任务，不面向"关系与情绪驱动的开口冲动"。
