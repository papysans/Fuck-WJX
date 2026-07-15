# Journal - Napstablook (Part 1)

> AI development session journal
> Started: 2026-07-15

---



## Session 1: 问卷星 AI 开卷答题 Chrome 扩展：从 0 到公开发布

**Date**: 2026-07-15
**Task**: 问卷星 AI 开卷答题 Chrome 扩展：从 0 到公开发布
**Branch**: `main`

### Summary

从 explore(友商+逆向问卷星DOM) → PRD → MVP，迭代出完整 MV3 扩展并发布到公开仓库 github.com/papysans/Fuck-WJX。关键决策与验证：①扫题兼容新版模板 .field[topic]（老 .div_question 在 ks.wjx.com 失效，逆向真机确认）②上下文工程：整卷单次全送全答，模型统筹依赖题(#5→#6→#7)、背景/信息题留空、字数硬约束(实测 300 字压住)③UI 重做为「隐形便签」双主题(浅/深)丝滑切换④可选自动填充+每题单条填入⑤破问卷星反粘贴、AI 请求走 background 规避切屏检测⑥导入导出配置。AI 走 OpenAI 兼容接口(DeepSeek 中转，纯 OpenAI 格式无专属适配)，key 仅存 chrome.storage.local、.env 已 gitignore。收尾前跑了 Codex 只读安全审查：无硬泄漏(git 无真实 key/无遥测/无可触发 XSS)，遗留待修 M2(导出含明文key)/M3(强制HTTPS+禁重定向)/M1(content 不应读整个config含key)/L3(去除多余权限)。自动填充在问卷星考试模式的有效性尚需真机确认。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `325eb9d` | (see git log) |
| `1db2924` | (see git log) |
| `b8cce16` | (see git log) |
| `bf452ed` | (see git log) |
| `82834ef` | (see git log) |
| `9f57d33` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete
