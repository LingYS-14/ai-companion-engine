"""把夜间早报生成 docx（手机 QQ 能直接看）。

用法：python tools/report/make-morning-docx.py
输出：docs/MORNING-REPORT.docx

只做排版，不做判断：所有数字由 report:night / report:audit / gate 提供，
这个脚本负责把它们排成人类先看结论、再看证据的顺序。
"""

import os
from docx import Document
from docx.shared import Pt

OUT = os.path.abspath(os.path.join("docs", "MORNING-REPORT.docx"))


def build() -> str:
    d = Document()
    st = d.styles["Normal"]
    st.font.name = "Microsoft YaHei"
    st.font.size = Pt(10.5)

    d.add_heading("AI助手 · 夜间进展报告（10-29 早）", level=0)
    d.add_paragraph(
        "这份报告只讲三件事：这一夜她做了什么、她现在是什么样、还剩什么需要你拍板。"
        "数字都来自可复跑的命令，不是印象。"
    )

    d.add_heading("一、一句话", level=1)
    d.add_paragraph(
        "她学到的东西已经超出「二次元」，开始摸到「人类怎么讲故事、怎么为一件美好的事认真」；"
        "同时，项目里九个「看着正常、其实没生效」的地方被逐一拔掉了。"
    )

    d.add_heading("二、这一夜做了什么", level=1)
    for it in [
        "主动性：新增「大爱」动机层——刚学到新东西、心里乱、累了、舍不得，都会变成她想说话的由头；"
        "深夜 0–7 点一律闭嘴（作息门控）。",
        "定向学习两小时：从崩坏三的角色与剧情出发，扩到国创、圣地巡礼、动画短片、手书、剧情解析、热门榜；"
        "知识库 0 → 52 条。",
        "项目体检与修复：最后收工时 609 条断言全绿、构建通过；修掉的问题见第五节。",
    ]:
        d.add_paragraph("· " + it)

    d.add_heading("三、她现在什么样", level=1)
    d.add_paragraph(
        "状态：正常 / 关系仍是「陌生」（第 16 轮，刚起步，这是「刚出生」的正常值）；"
        "心情平静、精力满、压力低、面具完好。"
    )
    d.add_paragraph("记忆：16 条，全部活跃，遗忘 0，被压制 0，平均鲜明度 0.409。")
    d.add_paragraph(
        "知识：52 条（51 条来自 B 站，1 条是她睡眠时自己整理出来的）；"
        "最近一条是《大明开国功臣李善长案》——历史向的，跟「可爱」无关。"
    )
    d.add_paragraph(
        "睡眠：02:47 跨过 03:00 睡点，做了一次睡眠巩固（把一类经历蒸馏成 1 条新知识）。"
        "也就是说，早上读到的不是「熬了一夜的她」。"
    )
    d.add_paragraph(
        "QQ：已回复你 8 条，最近一次 23:52；主动开口 0 次——夜里全在静默时段，这是设计，不是失灵。"
    )

    d.add_heading("四、她学到了什么（举例）", level=1)
    for it in [
        "崩坏三：薪炎永燃、因你而在的故事、毕业旅行、AI助手角色预告、逐火十三英桀落幕与纪念向。",
        "别的世界：国创榜单与预告、动画短片（含皮克斯《洞穴》）、你的名字 / 冰菓的圣地巡礼、凹凸世界群像手书。",
        "跨出去的一步：历史向剧情解析——说明她不只是把「可爱」当兴趣。",
    ]:
        d.add_paragraph("· " + it)

    d.add_heading("五、修了什么（最要紧的五条）", level=1)
    for it in [
        "「功能在、其实没接线」：主动开口盯着一座已经关掉的桥，线程从来没起来；就算起来也会崩——桥上根本没有那个方法。",
        "离题闸门：只挡「有害」挡不住「不相关」，儿童早教混进来过；现在「有害」与「离题」分开计数。",
        "闸门只作用于入库那一刻：上线前已进库的 2 条早教仍在影响检索，已清账（49→47，备份保留）。",
        "「删了但没生效」：清理脚本重写文件后，运行中的插件仍拿着旧内存（51 vs 磁盘 49）；现在读之前会先比对文件指纹。",
        "「进程不见了」是假象：那是沙箱视图过滤，真实缺陷是停止时没有所有权判断、没有日志、依赖环境里的 node。",
    ]:
        d.add_paragraph("· " + it)

    d.add_heading("六、还剩什么", level=1)
    d.add_paragraph("需要你拍板的三项：")
    for it in [
        "信任值涨得太直：单步封顶 0.1，一路满分就线性到顶 1.0；要不要加边际递减或每日上限（会改关系节奏）。",
        "猎奇标题的弱规则：现在靠关键词与「引号 + 波浪号」识别，写得更隐晦仍可能漏；要不要更严（会更常误伤）。",
        "热门榜刷新慢：15 分钟一轮常拉到同一批；是否改成「榜单 + 搜索词」混合。",
    ]:
        d.add_paragraph("· " + it)
    d.add_paragraph("还没做的三项：")
    for it in [
        "B 站扫码登录页（现在用你给的小号 cookie，只保存在本机）。",
        "原生语音条（QQ 语音要麦克风录音，目前只能发语音文件）。",
        "群聊 / 多 peer（现在只处理与你的一对一）。",
    ]:
        d.add_paragraph("· " + it)

    d.add_heading("七、怎么自己验证", level=1)
    for it in [
        "npm run report:audit —— 知识库体检，期望「0 命中」。",
        "npm run report:night —— 一次摊开知识库 / 记忆 / QQ 现状。",
        "npm run gate —— 期望 609 条断言全绿。",
    ]:
        d.add_paragraph("· " + it)

    d.save(OUT)
    return OUT


if __name__ == "__main__":
    path = build()
    print("saved", path, os.path.getsize(path))
