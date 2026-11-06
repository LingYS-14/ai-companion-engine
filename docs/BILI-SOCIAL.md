# B 站社交主动性

2026-11 起，她的「主动」不再主要花在给你发消息上：常驻自主进程会按配置去 B 站刷视频、
发弹幕、发评论、点赞，把外部互动当作主动性的主要出口；QQ 主动开口则降为「确实有事、
并且间隔够久」时才发生。本文说明能力边界、配置项与排障方式。

设计上刻意**没有**「一天最多 3 条」之类的硬编码 if：节奏来自 `AutonomyConfig`，是否
出门还取决于能量、睡眠、审核票据与当天账本。改配置即可调稀或关掉，不需要改代码。

## 1. 她能做什么

| 动作 | 接口 | 说明 |
| --- | --- | --- |
| `watch` | `x/web-interface/view`、热门/搜索 | 读标题、简介、分 P、时长；这是每次社交的第一件事 |
| `like` | `x/web-interface/archive/like` | 只在**没点过赞**的视频上做，每视频一次 |
| `danmaku` | `x/v2/dm/post` | 弹幕 ≤20 字（接口上限 100），落在视频约 30% 处 |
| `comment` | `x/v2/reply/add` | 评论 ≤60 字（接口上限 1000），每天默认最多 1 条 |

优先级：弹幕 → 评论 → 点赞 → 只看不写。弹幕额度默认给点赞留了一个位置，避免「额度
全被弹幕吃掉、永远轮不到评论」。

写操作需要登录态（`sessdata` + `bili_jct`）；没有登录态时只做匿名 `watch`，不会退化成
「假装发出去」。凭据只进 Cookie header 与 csrf 表单，日志/错误信息里会被抹掉。

## 2. 配置

### 2.1 B 站节奏（`data/autonomy.env` 或进程环境变量）

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `ACE_SOCIAL_INTERVAL_MIN` | `20` | 两次社交尝试的最小间隔（分钟） |
| `ACE_SOCIAL_DAILY_MAX` | `4` | 每天最多几个「对外动作」（弹幕 + 评论 + 点赞都算）；`0` = 关掉社交 |
| `ACE_SOCIAL_COMMENT_DAILY_MAX` | `1` | 每天最多几条评论 |

弹幕的日额度由另外两个值推导：`max(0, dailyMax - commentDailyMax - 1)`，默认
`4 - 1 - 1 = 2`——最后那一格留给点赞。

这些值最终进入 `AutonomyConfig` 的 `socialIntervalMs` / `socialDailyMax` /
`socialCommentDailyMax`（默认值同表，见 `src/autonomy/config.ts`）。写入 `autonomy.env`
后需要重启常驻进程；`scripts/autonomy/start.ps1` 会加载该文件。

### 2.2 消息侧节奏（`cordis.patch.yml` 的 `qq.proactive`）

```yaml
proactive:
  enabled: true       # 总开关
  minGapMin: 120      # 两次真的开口之间至少 2h
  maxPerDay: 3        # 每天最多 3 条
  checkEveryMin: 20   # 每 20min 才看一次要不要说话
```

常驻进程启动时会读这一段，同时喂给循环规划（多久检查一次）与 `OneBotBridge.proactive`
（真正的机械门）。静默时段固定为本地 23:00–07:00（`src/contracts/quiet-hours.ts`）。

门控在**调用模型之前**：`decideProactive` 先判 disabled/quiet/gap/daily/energy/trust 等，
只有判定要开口时才 compose + 调 LLM。所以调稀不会浪费模型额度。

### 2.3 能量

`ENERGY_COST_SOCIAL`（默认 `0.004`，与主动开口同价）只在真的发出弹幕/评论/点赞后扣；
`watch` 与 `skip` 不收费。社交规划还有一道能量下限：低于 `0.2` 时直接休息，不刷也不写。
睡眠中同样直接跳过——这两道门都在 `socialImpl` 之前的纯逻辑里，和参数无关。

## 3. 登录态

运行时从 `data/bili-<characterId>.json` 读取：

```json
{ "sessdata": "…", "biliJct": "…" }
```

- 该文件**不属于仓库**，不要提交、不要贴进日志或 issue。
- 缺 `biliJct` 时写操作会以 `code=-3` 失败，匿名浏览不受影响。
- 登录态失效时 B 站会返回业务 code；账本记下 code，下一拍继续跑（不会中断循环）。

## 4. 账本与日志

`data/social-<characterId>.ndjson`，一次社交追加一行：

```json
{"at":1761912000000,"bvid":"BV1xx411c7mD","action":"danmaku","ok":true,"code":0,"reason":"弹幕额度未满","generated":true}
```

当天预算从这份账本现算（按本地日界切分）。日志里对应一行：

```
[social] action=danmaku bvid=BV1xx411c7mD ok=true code=0 generated=true reason=弹幕额度未满
```

排障时先看 `[social]`：`skip` 会带原因（睡眠/能量/冷却/额度/今天已互动过）。

## 5. 调稀或关闭

| 目标 | 做法 |
| --- | --- |
| 少发消息、保留 B 站互动 | 调大 `minGapMin`（如 240）、调小 `maxPerDay`（如 1） |
| 完全不发主动消息 | `qq.proactive.enabled: false`，或 `maxPerDay: 0` |
| 少刷 B 站 | 调大 `ACE_SOCIAL_INTERVAL_MIN`、调小 `ACE_SOCIAL_DAILY_MAX` |
| 只浏览不写 | `ACE_SOCIAL_DAILY_MAX=0`（连匿名浏览也停）或把 `socialDailyMax` 设 0 |
| 只停评论 | `ACE_SOCIAL_COMMENT_DAILY_MAX=0` |
| 临时停一切主动性 | `ACE_AUTONOMY=0`（整个自主循环停） |

## 6. 失败与已知限制

写客户端的结构化返回（都不抛异常）：

| code | 含义 | 是否重试 |
| --- | --- | --- |
| `-1` | 网络/传输失败 | 是 |
| `-2` | 返回不是 JSON / 缺 `code` | 是 |
| `-3` | 缺登录态或 `bili_jct` | 否，先补登录 |
| `-4` | 入参不合法（空文案、缺 cid 等） | 否 |
| B 站 `code` | 业务拒绝（如评论区关闭、风控） | 否 |

已知限制：

- 候选视频来自热门榜/关键词搜索，不接推荐流；避免一上来就碰风控最重的接口。
- 发弹幕/评论可能触发 B 站风控（验证码、频率限制）。本项目不绕过验证码；失败记账后
  下一拍再试，不重试同一请求。
- 文案由模型按人格卡生成，内容责任在部署者；默认额度刻意很小。
- 只支持单账号、单进程（既有单写者假设）；多开会抢同一份账本。
- 点赞是「一次对外动作」，也计入 `dailyMax`；不喜欢可把 `likeEnabled` 关掉
  （目前只有 `planActivity` 的注入侧可关，脚本默认开启）。

## 7. 部署

```bash
npm run build
node scripts/autonomy/publish-runtime.mjs --guard-only
node scripts/autonomy/publish-runtime.mjs
node scripts/autonomy/health.mjs
```

发布脚本会复制 `dist/`、`spec/`、`scripts/`；本次改动新增的
`dist/bili/write.js`、`dist/bili/activity.js`、`dist/autonomy/onebot-config.js`
都要在运行目录里，否则常驻进程启动会报模块找不到。`data/` 不在发布范围内，登录态与
账本会原地保留。
