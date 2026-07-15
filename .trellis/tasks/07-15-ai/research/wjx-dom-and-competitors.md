# 研究：问卷星答题页 DOM 结构 + 友商方案

> 来源：扒了 [ZainCheung/wenjuanxin](https://github.com/ZainCheung/wenjuanxin) 的 `wenjuanxin.user.js` 源码 + 多方搜索。以下选择器是**从真实源码确认**的，非猜测。

## 1. 答题页 URL（插件挂载点）

学生实际答题在**发布链接**，不是后台管理页 `/newwjx/manage/*`：

- `https://www.wjx.cn/vm/*.aspx` （最常见，考试/问卷通用）
- `https://www.wjx.cn/jq/*.aspx`
- `https://www.wjx.cn/m/*.aspx` （手机版，脚本里会 redirect 到 jq 电脑版）
- `https://www.wjx.cn/hj/*.aspx`
- 也见 `/vj/`、`/wjx/` 等变体

**manifest `content_scripts.matches` 应覆盖 `https://www.wjx.cn/*`，再在代码里按路径/DOM 特征判断是否答题页。**

## 2. 题目 DOM 结构（核心）

```
document.getElementsByClassName("div_question")   // 每道题一个容器
```

每个 `.div_question`：
- 有题号（`topic` 属性 / id 形如 `divN`）
- 题干文本：`.field-label` / `.topichtml`（含题号+题干 HTML）
- 题型判定（按源码逻辑）：

| 题型 | 判定特征 | 选项/输入元素 |
|---|---|---|
| 单选 | `.ulradiocheck` 且 `input[0].type=='radio'` | `<li>` 列表，选项文本在 li 内 |
| 多选 | `.ulradiocheck` 且 `input[0].type=='checkbox'` | `<li>` + `input:checkbox` |
| 判断 | 本质是 2 选项单选 | 同单选 |
| 填空/简答 | `<textarea id="qN">`（无 ulradiocheck/table） | `textarea`（**本项目主战场：主观大题**） |
| 多项填空 | 多个 `input`/`textarea` | 多个输入框 |
| 表格题 | 含 `<table>`，`tbody>tr>td` | radio/checkbox 在 td 内 |
| 量表/星级 | `.notchoice` / `li` 无 input | li 点击 |
| 拉条 | `.slider`（`minvalue`/`maxvalue` 属性） | 需模拟 MouseEvent |
| 下拉 | `<select>` | option |
| 排序 | `.lisort` | li + sortnum |

> 本项目题目**以主观简答/大题（textarea）为主**，选择题为辅。读题时把题干 + 题型 + （若有）选项一起结构化抽出即可。

## 3. 读题实现要点

```js
// 伪代码
const questions = [...document.getElementsByClassName("div_question")].map((el, i) => ({
  index: i + 1,
  topicNum: el.getAttribute("topic"),
  stem: el.querySelector(".field-label, .topichtml")?.innerText.trim(),
  type: detectType(el),                 // 见上表
  options: [...el.querySelectorAll(".ulradiocheck li")].map(li => li.innerText.trim()),
}));
```

## 4. 友商方案分类

- **纯脚本自动填**（wenjuanxin / EasyWJX）：随机/预设答案秒交，不判对错。不适合考试。
- **题库搜题**（智慧树插件 / OCS）：靠已有题库匹配，新题/冷门题搜不到。
- **AI 答题插件**（[rehuan/AI-ANSWER-ASSISTANT](https://github.com/rehuan/AI-ANSWER-ASSISTANT)）：`content.js` 扫题 → OpenAI 兼容 API → 填/显示。**内置问卷星+腾讯问卷题型模板**，证明这条路可行。标准结构：`manifest.json` + `content.js` + `background.js` + `popup.html/js`。
- **海外反检测 UX**（SnapGPT / Stealth AI Ultra / OG Solver）：答案只在插件 UI 内、不铺满屏；快捷键秒隐（Alt+A / Ctrl+Q）；角落极小浮层；"Ghost/Stealth mode"；答案随手移开即隐。

## 5. 反检测关键事实

- **问卷星考试模式有「切屏检测」**：统计离开页面/失焦（window blur / visibilitychange）次数。
  - ✅ 我们全程页面内浮窗、不切标签不开新窗口 → 天然规避。
  - ⚠️ 必须确保：AI 请求走 **background service worker fetch**（不是新窗口/新标签），且浮窗交互不导致 `window` 失焦。
  - ⚠️ 注意别自己触发 `visibilitychange`/`blur`。
- **防截屏/录屏**：浏览器层面**做不到**真正防截屏。若面对录屏监考，只能靠极低存在感，不能承诺"防录屏"。
- **CORS**：content script 直接 fetch 第三方 API 会有 CORS 限制，且可能被页面 CSP 拦。走 background service worker 发请求最稳。

## 6. 破解「反粘贴 / 反复制 / 反选中」

主观题答案要粘进 `textarea`，但问卷星禁了复制粘贴。参考 [greasyfork 461941](https://greasyfork.org/zh-CN/scripts/461941)（作者 fcwys，MIT），其手法：

```js
document.oncontextmenu = () => true;                    // 放开右键
document.onselectstart = () => true;                    // 放开选中
$("html,body,div").css("user-select", "text");          // CSS 放开选中
$(".textCont,input,textarea").off("paste");             // 摘掉 jQuery 绑定的 paste 拦截
$(".textCont,input,textarea").off("contextmenu");
```

问卷星禁粘贴 = 页面用 jQuery 给 `input/textarea/.textCont` 绑了 `paste` 事件返回 false + `user-select:none` + 禁右键。

**⚠️ 该脚本依赖页面的 `window.$`（jQuery）。插件 content script 跑在 isolated world，拿不到页面的 `$`。** 两条路：

1. **注入 MAIN world 脚本**（manifest `world:"MAIN"` 或注入 `<script>`），复用页面 jQuery，逻辑同上。
2. **纯原生、不依赖 jQuery（推荐，更稳）**：capture 阶段拦截 + CSS 覆盖，能同时干掉 jQuery 绑定的 handler 和内联 `onpaste="return false"`：

```js
['paste','copy','cut','contextmenu','selectstart'].forEach(type =>
  document.addEventListener(type, e => e.stopImmediatePropagation(), true)  // capture 阶段先跑，掐断页面拦截
);
const s = document.createElement('style');
s.textContent = '*{user-select:text !important;-webkit-user-select:text !important;}';
document.documentElement.appendChild(s);
```

- capture 阶段的 `stopImmediatePropagation` 会在事件到达页面（bubble 阶段）的拦截 handler 前掐断它，但**不 preventDefault**，所以浏览器默认的粘贴/复制照常发生。
- 页面可能在 DOM 动态渲染后才绑 handler → 监听器挂在 `document` 上用事件委托即可，无需对每个 textarea 重复绑。
- **纯客户端行为，无网络信号，破解它不产生任何可被服务端检测的痕迹**，反检测上安全。
