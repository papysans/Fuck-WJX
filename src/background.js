// 后台 service worker：唯一负责调用 AI 的地方。
// 放在 background 而不是 content 有两个原因：
//   1. 绕开页面 CORS / CSP —— 扩展后台 fetch 不受页面策略限制；
//   2. 不触发页面 window 的 blur / visibilitychange —— 规避问卷星「切屏检测」。

const DEFAULTS = { baseUrl: "", apiKey: "", model: "", temperature: 0.3, wordLimit: 300 };

const TYPE_LABEL = {
  single: "单选",
  multi: "多选",
  judge: "判断",
  text: "简答/填空",
  matrix: "表格",
  select: "下拉",
  slider: "量表",
  unknown: "题目",
};

async function loadConfig() {
  const { config = {}, notes = "" } = await chrome.storage.local.get(["config", "notes"]);
  return { config: { ...DEFAULTS, ...config }, notes };
}

// 把用户填的 baseURL 归一化成 chat/completions 端点。
// 兼容：https://api.deepseek.com  /  https://api.openai.com/v1  /  已经带 /chat/completions 的完整地址。
function toChatEndpoint(baseUrl) {
  let u = (baseUrl || "").trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(u)) return u;
  if (/\/v\d+$/.test(u)) return u + "/chat/completions";
  return u + "/chat/completions";
}

// 把一道题渲染成文本（含题号、题型、题干、选择题选项）。
function questionToText(q) {
  let s = `第${q.index}题（${TYPE_LABEL[q.type] || "题目"}）：${q.stem}`;
  if (q.options && q.options.length) {
    s += "\n选项：" + q.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join("   ");
  }
  return s;
}

// 单次调用、整卷上下文：把整份试卷（含个人信息/案例背景/作答题）一起喂给模型，
// 让模型区分「上下文」与「要答的题」，依赖题一次性统筹连贯作答，并把每题答案压进字数上限。
function buildMessages(notes, questions, wordLimit) {
  const system =
    "你是开卷考试答题助手。我会给你【笔记】和【整份试卷】，请一次性作答全部题目。\n" +
    "规则：\n" +
    "1. 试卷条目分三类：①个人信息（姓名/工号/学号/班级/部门等）；②考试说明或案例背景（它们是贯穿全卷的上下文，本身不是要回答的题目）；③真正需要作答的题目。\n" +
    "2. 请先通读整份试卷，把说明和案例背景当作上下文来理解。\n" +
    "3. 只对『真正需要作答的题目』给出答案；对个人信息条目、以及纯说明/背景条目，answer 一律返回空字符串 \"\"。\n" +
    "4. 凡是相互依赖的题目，一次性统筹作答：后面的题要复用前面题目的分析，角色、模块、流程、命名等保持前后一致，逻辑连贯，绝不自相矛盾。\n" +
    `5. 字数硬性要求：每道题的答案严格控制在不超过 ${wordLimit} 字，分点精炼、只写要点、不展开举例、不写空话套话；宁可精简也绝不超出字数。\n` +
    "6. 优先依据【笔记】作答；笔记没有覆盖到的地方，用你自己的专业知识补充，并在该题答案开头标注【笔记未覆盖】。\n" +
    "7. 严格只输出一个 JSON 对象，不要输出 markdown 代码块围栏或任何多余文字。\n" +
    "8. 每道题的 answer 一律用纯文本，禁止任何 Markdown 语法：不得出现 #、*、-、`、> 等标记，不加粗、不斜体、不写标题、不用 Markdown 列表；需要分点时用「1. 2. 3.」或顿号，用普通中文标点。格式为：\n" +
    '{"answers":[{"index":题号,"answer":"答案文本"}]}\n\n' +
    "【笔记开始】\n" + (notes || "（用户未提供笔记）") + "\n【笔记结束】";

  const qText = questions.map(questionToText).join("\n\n");

  const user =
    "下面是【整份试卷】，已按题号顺序排列。请按上述规则区分上下文与作答题，依赖题一次性统筹连贯作答，" +
    `每题答案不超过 ${wordLimit} 字，只返回规定的 JSON：\n\n` +
    "【试卷开始】\n" + qText + "\n【试卷结束】";

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

// 尽量把模型返回解析成 [{index, answer}]，失败则原样回传由前端展示。
function parseAnswers(content) {
  const tryParse = (t) => {
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  };
  let obj = tryParse(content);
  if (!obj) {
    const m = content.match(/\{[\s\S]*\}/);
    if (m) obj = tryParse(m[0]);
  }
  if (obj && Array.isArray(obj.answers)) {
    return { mode: "structured", answers: obj.answers };
  }
  return { mode: "raw", raw: content };
}

// 整卷单次调用：一次把所有题目送进去，一次性拿回全部答案。
async function askAll(questions) {
  const { config, notes } = await loadConfig();
  if (!config.baseUrl || !config.apiKey || !config.model) {
    throw new Error("未配置 baseURL / apiKey / model，请点扩展图标在弹窗里填写");
  }
  const wordLimit = Number(config.wordLimit) || 300;
  const endpoint = toChatEndpoint(config.baseUrl);
  // 整体放宽 token 上限，够放下所有题的答案：按 题数 × 每题字数 × 3 估算，夹在 [1024, 8192]。
  const maxTokens = Math.min(8192, Math.max(1024, questions.length * wordLimit * 3));
  let resp;
  try {
    resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: config.temperature ?? 0.3,
        max_tokens: maxTokens,
        messages: buildMessages(notes, questions, wordLimit),
      }),
    });
  } catch (e) {
    throw new Error("网络请求失败（检查 baseURL / 网络）：" + (e.message || e));
  }
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`API ${resp.status}：${t.slice(0, 300)}`);
  }
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content ?? "";
  if (!content) throw new Error("模型返回为空");
  return parseAnswers(content);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "ASK_ALL") {
    askAll(msg.questions)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true; // 异步响应
  }
});

// 全局快捷键 → 转发给当前标签页的 content script
chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const type = command === "scan-now" ? "SCAN_NOW" : "TOGGLE_OVERLAY";
  chrome.tabs.sendMessage(tab.id, { type }).catch(() => {});
});
