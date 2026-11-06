# 架构

本文描述 AI Companion Engine 的分层、依赖规则与运行形态。目标是让「一个有状态的伙伴」在长期运行中保持可预测：状态只有一个写者，副作用集中在装配层，其余部分尽量是纯函数。

## 1. 分层与依赖规则

```
        ┌─────────────────────────────────────────────┐
        │ 装配层 assembly/ + scripts/autonomy/main.mjs │  ← 唯一允许"接线"的地方
        └───────┬───────────────┬──────────────┬───────┘
                │               │              │
        ┌───────▼──────┐ ┌──────▼──────┐ ┌─────▼──────┐
        │ orchestrator │ │  dialogue   │ │  plugin    │
        │  intent /    │ │  prompt /   │ │  工具面 /   │
        │  turn        │ │  identity   │ │  Web 路由   │
        └───────┬──────┘ └──────┬──────┘ └─────┬──────┘
                │               │              │
        ┌───────▼───────────────▼──────────────▼───────┐
        │        ports/（端口接口，brain ↔ spine 的唯一门面）│
        └───────┬───────────────────────┬───────────────┘
                │                       │
        ┌───────▼──────────┐   ┌────────▼─────────┐
        │  engine/（纯状态） │   │ memory/ learning/ │
        │  energy sleep    │   │ maintenance/ ...  │
        └──────────────────┘   └───────────────────┘
```

三条硬规则（`spec/config/layers.json` + `tools/lint/edges.mjs` 强制执行）：

- **R1**：`brain`（orchestrator / dialogue / engine 等）不得直接 import `spine`（autonomy）或 `tools`（plugin）。
- **R3**：`tools` 只能通过 `src/ports/` 访问引擎能力，不直接 import brain。
- **R4**：装配点（`src/assembly/`、`scripts/autonomy/main.mjs`）不允许写业务逻辑，只做接线与参数传递。

改动后跑 `npm run edges:check`；新增跨层边必须在 `spec/config/layers.json` 白名单里说明理由，且 `edges:check` 会校验债务清单不被扩大。

## 2. 单写者模型

- **只有一个进程写 `data/`**：自治运行时（`scripts/autonomy/main.mjs`）。
- DSH 插件进程（`src/plugin/`）只读数据 + 通过**写通道**（HTTP，`write-server.ts` / `write-client.ts`）把「写请求」投递给运行时；它自己绝不落盘。
- 写通道的操作集合（`WRITE_OPS`）是白名单：chat / web_search / web_fetch / remember / consolidate 等；未知 op 返回 400，旧 daemon 返回 `CHANNEL_UNSUPPORTED` 时插件会提示"daemon 版本过旧"。
- 好处：文件一致性、睡眠态判断、额度与节流都只有一个决策点；插件重启不影响数据。

## 3. 一次 tick 里发生什么

`src/autonomy/loop.ts` 每 5 分钟跑一拍（`Loop` 带重入闸，上一拍未结束则本拍判 `busy` 跳过）：

```
runOnce
 ├─ 加写锁（lock.ts）
 ├─ 刷新状态快照：能量、睡眠相位、关系、presence
 ├─ intentTick（orchestrator/intent/tick.ts）
 │   ├─ 组装 SituationSignals（时间快照、recall、历史）
 │   ├─ 累积器竞争 → top 意图
 │   ├─ 刹车：睡眠 / quiet / 额度 / gap / 同类重复 / lookahead 到点
 │   └─ 产出 actions（speak / journal / idle）
 ├─ 执行动作：speak → compose → LLM → QQ/网页 → 记记忆 → 记账
 ├─ 夜间分支：asleep 时走 sleepAdvance（恢复能量 + 首拍功课）
 └─ 心跳与历史
```

## 4. 时间与状态

- 时间一律由**装配层传入**（`Clock`），brain 内部用 `localHour` / `nowMs` 参数，不自己读系统时钟。
- `TemporalSnapshot`（`src/orchestrator/intent/temporal.ts`）把"现在几点、醒了多久、距上次对话多久、这之后主动了几次没回"变成纯数据，供提示词与刹车使用。
- 状态持久化：`Persisted`（`src/plugin/runtime.ts`）序列化到 `state-<character>.json`；写文件统一走原子写（temp + rename + 重试）。

## 5. 记忆

- 写：`MemoryStore.write` → 防火墙（来源、内容、关系）→ WAL 追加（JSONL）→ SQLite 索引。
- 读：`recall()` 加权排序（specificity / semantic / vividness / recency / access），并支持来源过滤（`excludeSources` / `backfillSources`）。
- 生命周期：`src/memory/lifecycle.ts`（遗忘、冷归档、hard delete 保留期），夜间由维护任务消费。
- 所有记忆都有 `source` / `direction` / `encode_ctx`（可携带 `timeOfDay`、`goalAtTime`、`goalId`、`kind` 等），用于回声防护与时间一致性。

## 6. DSH 插件形态

- Host 插件：注册 `soul_*` 工具（27 个）、面板数据路由、`/soul` 工作台静态页与 JSON 路由。
- 面板是只读投影；唯一改写入口是对话页（经写通道）。
- 插件配置见 `cordis.patch.yml`。

## 7. 目录速查

| 目录 | 职责 |
| --- | --- |
| `src/engine/` | 纯状态机：能量、睡眠、关系、情绪（无 IO） |
| `src/memory/` | 记忆存储、回忆、再巩固、生命周期 |
| `src/orchestrator/` | 意图引擎、时间观、turn |
| `src/dialogue/` | 提示词、身份协议、清理、回声守卫 |
| `src/autonomy/` | 运行时：LLM、循环、chat、pricing、日志 |
| `src/qq/` | QQ 桥与宿主控制 |
| `src/web/` | 网页搜索/抓取 |
| `src/plugin/` | DSH 工具面、面板、Web 路由、写通道 |
| `src/ports/` | 端口接口 |
| `src/assembly/` | 装配 |
| `src/maintenance/` | 夜间功课、selftalk、dream |
| `src/learning/` | B 站学习、知识库、好奇心 |
| `src/firewall/` | 内容/来源防火墙 |
| `scripts/autonomy/` | 运行时装配点、启动/停止/健康/publish |
| `spec/` | 规格台账、注册表、分层规则 |
| `tools/` | 门禁、审计、报告、维护工具 |
