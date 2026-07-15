# 问卷星 AI 开卷答题悬浮窗插件

## Goal

给问卷星考试/问卷做一个 Chrome 插件：喂一份**当天 markdown 笔记**，一键读取答题页**全部题目**，把「整份笔记 + 全部题目」丢给用户自配的 **OpenAI 兼容中转站**，AI 生成答案（**以主观简答/大题为主**），在一个**集中悬浮窗**里按题号展示。全程**页面内完成、不切屏**，配合低存在感 UI + 快捷键秒隐，避免被巡逻老师发现。同时**破解问卷星的反复制/反粘贴**，让用户能把答案粘进 textarea。

这是一个**开卷简答生成器**，不是选择题题库搜答案。

## Requirements

### F1 笔记输入
- 提供配置面板（插件 popup 或页面内侧栏），支持**粘贴 markdown** 文本；可选支持上传 `.md` 文件。
- 笔记存 `chrome.storage.local`，当天可复用、可随时更新/清空。

### F2 读题（扫题）
- content script 遍历 `document.getElementsByClassName("div_question")`，逐题结构化抽取：题号、题干文本、题型、（若为选择题）选项列表。
- 题型识别覆盖：单选 / 多选 / 判断 / **填空简答（textarea，主战场）** / 表格 / 量表 / 下拉 / 排序（识别规则见 `research/wjx-dom-and-competitors.md`）。
- 手动触发（不自动扫），避免过早暴露。

### F3 AI 调用
- 请求走 **background service worker fetch**（规避 CORS + 页面 CSP + 不触发页面失焦）。
- OpenAI 兼容 `POST {baseURL}/chat/completions`；用户在设置里自填 **baseURL / apiKey / model**（中转站），可选 temperature。
- Prompt：整份 markdown **直接进 context**（system 或 user 顶部，不做向量检索/分块）；全部题目结构化进 user；要求模型**按题号返回**每题答案，便于浮窗对齐。
- 配置持久化到 `chrome.storage.local`（apiKey 仅本地存储，不上传任何第三方）。

### F4 悬浮窗（答案展示）
- **集中式**可拖动浮层，按**题号列表**展示 AI 答案；主观题文本较长 → **可滚动**。
- 每题一个「**复制**」按钮（把该题答案写入剪贴板，配合 F6 粘进 textarea）。
- **透明度可调**（滑块）、**亮度/对比可调**。
- **快捷键秒隐/秒显**（如 `Ctrl+Shift+X`，可配置）。
- **鼠标移开自动降透明度/淡出**，靠近恢复。
- 加载/错误状态可见（如"AI 生成中"、"请求失败：原因"）。

### F5 反检测（威胁模型：①老师肉眼巡逻 ②问卷星切屏检测）
- **切屏检测**：全程页面内浮窗，**不切标签、不开新窗口**；AI 请求走 background，不触发 `window blur` / `visibilitychange`；代码不主动触发失焦事件。
- **肉眼**：低存在感 UI + F4 的透明度/亮度/快捷键秒隐/移开淡出。
- panic hotkey：一键把浮窗彻底隐藏（DOM 保留、仅不可见），再按恢复。

### F6 破解反复制/反粘贴/反选中
- 解除问卷星对 `textarea/input/.textCont` 的 `paste` 拦截、`oncontextmenu`/`onselectstart` 限制、`user-select:none`。
- **推荐纯原生实现**（不依赖页面 jQuery）：capture 阶段 `stopImmediatePropagation` 拦截 `paste/copy/cut/contextmenu/selectstart` + 全局 CSS `user-select:text !important`（详见 research 文档第 6 节）。
- 纯客户端、无网络信号，安全。

## Acceptance Criteria

- [ ] 在真实问卷星答题页（`/vm/`、`/jq/` 等）能正确扫出全部题目的题号+题干+题型，主观题不漏。
- [ ] 粘贴一份 markdown 笔记后，一键触发，能在浮窗里按题号看到 AI 生成的答案。
- [ ] AI 请求用自配 OpenAI 兼容 baseURL/key/model 成功返回；失败时浮窗显示可读错误。
- [ ] 浮窗可拖动、透明度可调、亮度可调；快捷键能秒隐/秒显；鼠标移开自动淡出。
- [ ] 每题「复制」能把答案写入剪贴板，且能**成功粘贴**进问卷星 textarea（反粘贴已破）。
- [ ] 整个流程不切换标签页/不新开窗口；不触发 window blur/visibilitychange（切屏计数不增加）。
- [ ] apiKey 只存在本地 `chrome.storage.local`，不发往除用户中转站以外的任何地址。

## Definition of Done
- 在 Chrome 加载未打包扩展（MV3）可跑通端到端流程。
- README 说明：如何配置中转站、如何喂笔记、快捷键、注意事项与免责声明。
- 关键模块（读题解析、题型识别、反粘贴）有可手动验证的方式或最小测试。

## Technical Approach

**形态**：Chrome MV3 扩展。
```
manifest.json          # MV3, content_scripts matches https://www.wjx.cn/*, background service worker, host_permissions 用户中转站域名（或 <all_urls> 由用户配）
content.js             # 扫题(F2) + 注入悬浮窗(F4/F5) + 反粘贴(F6)
background.js          # service worker：收 content 消息 → fetch AI(F3) → 回传
popup.html/js          # 设置：baseURL/key/model + 笔记输入(F1)
overlay.css/js         # 悬浮窗样式与交互
```
**数据流**：popup 存笔记+API 配置 → content 扫题 → 发消息给 background 带{笔记, 题目[]} → background fetch OpenAI 兼容接口 → 返回按题号的答案 → content 渲染进浮窗。

**关键决策**：
- 答案来源 = markdown 直接进 context（不做 RAG 检索），因题目偏主观大题，全文喂给模型即可。
- 只读不自动填：主观题自动填痕迹重且可能触发行为检测，改为「复制 + 手动粘贴」，故必须破反粘贴(F6)。
- AI 请求放 background 而非 content：同时解决 CORS 和「不触发页面失焦（切屏检测）」两个问题。

## Decision (ADR-lite)
- **Context**：需在"读题准确率 / AI 主观题质量 / 不被抓 / 操作速度"间权衡；题目以主观大题为主，考场有老师巡逻 + 问卷星切屏检测。
- **Decision**：开卷简答生成器形态；集中悬浮窗只读展示 + 复制粘贴；整份笔记进 context；OpenAI 兼容中转；反检测聚焦肉眼+切屏两类；额外破反粘贴。
- **Consequences**：不做题库/自动填/防录屏（浏览器做不到，不承诺）；主观题正确性依赖笔记质量与模型能力，用户需自行核对。

## Out of Scope
- 自动填写答案（尤其自动填 textarea）。
- 本地/在线题库匹配搜题。
- 防截屏 / 防录屏 / 对抗屏幕共享监考（浏览器层面无法真正实现，明确不承诺）。
- 向量检索 / RAG 分块 / 多轮追问。
- 多家模型 provider 可视化切换（MVP 只做单一 OpenAI 兼容配置；未来可扩展）。

## Research References
- [`research/wjx-dom-and-competitors.md`](research/wjx-dom-and-competitors.md) — 问卷星答题页真实 DOM 选择器（`.div_question` 等）+ 题型识别规则 + 友商方案分类 + 切屏检测事实 + 反粘贴破解手法（原生实现）。

## Technical Notes
- 答题页 URL：`/vm/ /jq/ /m/ /hj/` 等（**不是**后台 `/newwjx/manage/`）。
- 题目容器 `.div_question`；单/多选看 `.ulradiocheck` 内 `input.type`；填空是 `textarea#qN`。
- 反粘贴破解见 research 第 6 节；参考 greasyfork 461941。
- 合规：仅供本人开卷复习/自测使用，需在 README 加免责声明。
