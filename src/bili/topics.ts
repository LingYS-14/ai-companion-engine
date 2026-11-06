/**
 * 「有目标地学习」的固定学习计划：先把崩坏三的设定与二创看一圈，再看泛二次元。
 *
 * 为什么是一条**常量**而不是配置：现在要的是「先学这个」，不是「可编排的学习系统」；
 * 常量改一行就能调，等真的需要按角色/按周换计划时再挪进 engine.json。
 *
 * 计划顺序就是轮转顺序：崩坏三的 5 个关键词排在最前面，所以 rotation=0 一定落在
 * 崩坏三（「优先」不是权重，是顺序 + 占比）。`pickKeywords` 按扁平后的关键词表
 * 取模，调用方每次 +1 就能一条条轮下去，到末尾自动绕回崩坏三。
 */

/** 一个学习方向：topic 进工具输出的首行，keywords 依次拿去搜 */
export interface LearningTopic {
  readonly topic: string;
  readonly keywords: readonly string[];
}

/**
 * 导出常量：以后要改学什么，改这里；`pickKeywords` 与工具层都不写死内容。
 *
 * 「二次元」组为什么**只留**有内容属性的词（2026-10-29 两次事故后改）：裸搜「二次元」
 * 命中的是算法推过来的擦边/标题党（详见 `ingest.ts` 的质量闸门）；第一次只是把它
 * 挪到最后，第二次 rotation=10 又轮到它、又漏进 3 条，所以泛词直接**删掉**。
 * 现在这组 5 个词（动画短片/手书/剧情解析/圣地巡礼/国创）都带明确内容属性，
 * 轮转怎么绕都不会再拿泛词去搜。
 */
export const LEARNING_PLAN: readonly LearningTopic[] = [
  { topic: "崩坏三", keywords: ["崩坏3", "崩坏三", "AI助手", "逐火十三英桀", "往世乐土"] },
  {
    topic: "二次元",
    keywords: ["动画短片", "手书", "剧情解析", "圣地巡礼", "国创"],
  },
];

/** 一次轮转的结果：给搜索用的关键词，以及它属于哪个方向 */
export interface LearningPick {
  readonly topic: string;
  readonly keyword: string;
}

/**
 * 按序轮转取下一个关键词。
 *
 * - `rotation` 是**扁平关键词表**的下标，不是 topic 下标：rotation=5 是「二次元/动画短片」；
 * - 越界与负数按取模回绕（-1 是最后一个关键词；扁平表 10 个词，所以 rotation=10 回到
 *   崩坏三、rotation=-9 落在「崩坏三/崩坏三」）；非有限数/小数先归一到整数；
 * - 计划为空（或全是空关键词）时抛 `RangeError`：没有关键词就没法搜，静默返回空串
 *   会让调用方拿空关键词发一次必定 400 的请求。
 */
export function pickKeywords(plan: readonly LearningTopic[], rotation: number): LearningPick {
  const flat: LearningPick[] = [];
  for (const entry of plan) {
    const topic = entry.topic.trim();
    for (const keyword of entry.keywords) {
      const trimmed = keyword.trim();
      if (trimmed !== "") flat.push({ topic, keyword: trimmed });
    }
  }
  if (flat.length === 0) throw new RangeError("学习计划为空：至少需要一个 topic 与一个 keyword");

  const raw = Number.isFinite(rotation) ? Math.trunc(rotation) : 0;
  const index = ((raw % flat.length) + flat.length) % flat.length;
  const picked = flat[index];
  if (picked === undefined) throw new RangeError(`学习计划索引越界：${String(index)}`);
  return picked;
}
