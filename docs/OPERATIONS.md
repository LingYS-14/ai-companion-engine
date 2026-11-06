# 运维手册

本文说明如何部署、启动、观察与升级这个内核。目标读者是「要把她长期跑在自己机器上的人」。

## 1. 运行形态

有两种跑法：

1. **独立自治运行时**（推荐用于长期陪伴）：`scripts/autonomy/main.mjs` 作为常驻进程，每 5 分钟一拍，自己写数据、自己连 QQ。
2. **DSH 插件**：插件进程只做工具面与 Web 面板，数据由运行时持有（单写者），插件通过写通道调用。

两者可以同时使用：DSH 里聊天、看工作台；运行时在后台负责 tick、睡眠、学习。

## 2. 首次部署

```bash
# 1) 依赖与构建
npm install
npm run build

# 2) 配置数据目录（默认仓库下 ./data）
export ACE_DATA_DIR="data"
export ACE_CHARACTER_ID="assistant"

# 3) 配置模型（推荐环境变量，不要写进仓库）
export ACE_LLM_API_KEY="sk-..."
export ACE_LLM_BASE_URL="https://api.deepseek.com"
export ACE_LLM_MODEL="deepseek-flash"
export ACE_LLM_MODEL_PRO="deepseek-v4-pro"

# 4) 启动并检查
npm run start
node scripts/autonomy/health.mjs
```

Windows 上 `npm run start` 走 `scripts/autonomy/start.ps1`（隐藏窗口）；需要开机自启时用任务计划程序指向 `scripts/autonomy/start-hidden.vbs`（记得先改成你的 pwsh 路径）。

## 3. 日常命令

| 命令 | 作用 |
| --- | --- |
| `npm run start` / `npm run stop` | 启停自治运行时 |
| `node scripts/autonomy/health.mjs` | 健康检查（进程、心跳、写锁、QQ、写通道、最近异常） |
| `node scripts/autonomy/publish-runtime.mjs` | 把仓库构建发布到运行目录（带守卫：脏树/缺 dist 会拒发） |
| `npm run gate` | 11 道门禁（改代码后必跑） |
| `node tools/report/morning-report.mjs` | 生成晨报 `docs/MORNING-REPORT-<日期>.md` |

## 4. 发布流程（升级代码时）

```bash
npm run gate                       # 必须全绿
node scripts/autonomy/publish-runtime.mjs --guard-only   # 只检查，不发布
node scripts/autonomy/publish-runtime.mjs               # 停 → 复制 → 起
node scripts/autonomy/health.mjs
```

发布脚本的守卫：

- **硬拒**：工作树有未提交的 tracked 改动；目标目录缺少 `dist/`。
- **警告**：`dist` 比 `src` 旧（verifier 锁验证会回写源码 mtime，属正常）。
- 紧急出口：`--force-dirty`（不建议）；`--no-restart` 只复制。

发布目录结构（默认 `C:/ai-companion-runtime`）：`dist/ spec/ scripts/` + `data/` 链接 + `RUNTIME.json`（记录 `publishedAt` 与文件校验）。

## 5. 数据目录

```
data/
  state-<id>.json           状态（能量、睡眠、关系、turns）
  memory-<id>.ndjson        记忆 WAL（append-only）
  memory-<id>.db            SQLite 索引（可重建）
  knowledge-<id>.json       知识库
  autonomy-<id>.log         运行时日志（5 分钟一拍一行 [sleep]/[intent]/[llm]…）
  panel-<id>.json           面板快照
  intent-<id>.json          意图记录
  intent-acc-<id>.json      意图累积器
  selftalk-<id>.json        自述日记
  dream-shadow-<id>.ndjson  dream 审计（可选）
  web-usage-<id>.json       网页额度账本
  .bak-* / .writer-lock.*   备份与写锁
```

- **备份**：停写后复制 `data/` 整体即可（所有写入原子、单写者）。
- **清理历史**：`tools/maintenance/delete-memory.mjs`、`edit-memory.mjs`，都支持 `--plan`/`--dry-run`，`--apply` 需要 daemon 已停。

## 6. 日志与观察

运行时每拍打一行 `[sleep]`，另有：

- `[intent] tick top=… gate=… outlet=… wouldSpeak=… emitted=…` — 每拍意图决策
- `[situation] lines=N inferred=M` — 处境行事实率
- `[llm] task=… model=… in=… out=… cached=… miss=…` — 模型用量
- `[learn] energy=… tier=…` — 学习分档
- `[fade] / [sleep-work] / [sleep-work-onset] / [dream-shadow]` — 夜间功课
- `[proactive] opened=true/false reason=…` — 主动开口

排障顺序：`health.mjs` → 日志尾部 200 行 → `data/state-*.json` → 对应模块测试。

## 7. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| `health` 报「进程未运行」 | 看日志是否有启动异常；常见是 `dist` 未重建（先 `npm run build` 再 `npm run start`） |
| `[autonomy] proactive 失败` | 装配层闭包错误；看堆栈行号，召回最近改动 |
| 主动开口少 | 看 `[proactive] opened=false reason=outlet/gap/daily/sleeping`；`outlet` 表示这拍没有可说话的内容 |
| 夜间功课不触发 | 确认 `[sleep] phase=asleep` 后同拍出现 `[sleep-work-onset]`；无 `asleepSince` 会空转 |
| QQ 不回 | `health` 看 onebot 状态；`cordis.patch.yml` 的 `qq.enabled/dryRun/token` |
| 模型回复为空 | thinking 未显式声明（见 `docs/DESIGN.md` §7） |

## 8. 停止与安全停机

`npm run stop` 会发停止信号并等待进程退出；若超时，检查 `data/.writer-lock.*`。**不要在运行时未停时手动改 `data/` 下的文件**——单写者假设会被破坏，下次写盘可能覆盖你的修改。
