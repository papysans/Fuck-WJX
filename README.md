# 复习面板 · 问卷星开卷答题辅助插件

本地开卷复习辅助的 Chrome MV3 扩展。喂一份当天 markdown 笔记，一键读取问卷星答题页的全部题目，用**你自己配置的 OpenAI 兼容接口**生成参考答案，展示在一个可调透明度/亮度、可快捷键秒隐的悬浮窗里。答案以主观简答/论述题为主。

> ⚠️ 仅供本人开卷复习 / 自测使用。请遵守所在考试与学校的规定，自行承担使用后果。

## 功能

- **笔记优先**：整份 markdown 直接进上下文，AI 优先据笔记作答，未覆盖的题标注【笔记未覆盖】。
- **扫题**：解析 `.div_question`，识别单选/多选/判断/简答/表格/下拉/量表。
- **悬浮窗**：集中列表、按题号、长文可滚动、每题一键复制；透明度/亮度可调；鼠标移开自动淡出。
- **快捷键**：`Ctrl+Shift+X` 秒隐/显，`Ctrl+Shift+S` 扫题求答案（Mac 为 `Cmd+Shift+*`）。
- **不切屏**：AI 请求走后台 service worker，不新开标签/窗口，规避问卷星切屏检测。
- **破反粘贴**：解除问卷星的复制/粘贴/选中限制，答案可直接粘进 textarea。

## 安装（开发者模式）

1. Chrome 打开 `chrome://extensions/`，右上角开启「开发者模式」。
2. 「加载已解压的扩展程序」，选本项目根目录。
3. 点扩展图标，在弹窗里填 Base URL / API Key / Model，粘贴当天笔记，保存。
   - DeepSeek：`https://api.deepseek.com` + `deepseek-chat`
   - OpenAI：`https://api.openai.com/v1` + `gpt-4o` 等
4. 在问卷星答题页按 `Ctrl+Shift+S`（或弹窗里点「扫题求答案」）。

## 本地联调（不装扩展先验接口）

```bash
cp .env.example .env   # 填入 key
node test/test-api.mjs
```
验证 OpenAI 兼容请求与 JSON 解析链路是否正常。

## 结构

```
manifest.json          MV3 清单：content 匹配 wjx.cn/wjx.com/wjx.top，后台 service worker，两个快捷键
src/background.js       唯一调 AI 的地方（避 CORS、不失焦），OpenAI 兼容 /chat/completions
src/content.js          扫题 + Shadow DOM 悬浮窗 + 破反粘贴
src/popup.*             设置弹窗：笔记 + API 配置 + 快捷入口
test/test-api.mjs       本地接口联调脚本
```

## 配置导入 / 导出

弹窗底部「导出配置」把当前的接口配置（Base URL / API Key / Model / 温度）和笔记打包成 `review-panel-config.json` 下载到本地；更新扩展后点「导入配置」选中该文件即可一键恢复，无需重填。

> ⚠️ 导出的配置文件含**明文 API Key**，请自行妥善保管，勿随意分享或上传。

## 隐私

API Key 与笔记只存在浏览器本地 `chrome.storage.local`，除了你填的中转站地址，不发往任何第三方。
