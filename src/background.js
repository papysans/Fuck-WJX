// 后台 service worker：唯一负责调用 AI 的地方。
// 放在 background 而不是 content 有两个原因：
//   1. 绕开页面 CORS / CSP —— 扩展后台 fetch 不受页面策略限制；
//   2. 不触发页面 window 的 blur / visibilitychange —— 规避问卷星「切屏检测」。

const DEFAULTS = { baseUrl: "", apiKey: "", model: "", temperature: 0.3 };

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

function buildMessages(notes, questions) {
  const system =
    "你是开卷考试答题助手。下面【笔记】是我今天学习整理的资料（markdown 格式）。" +
    "请优先严格依据笔记回答后面的题目；笔记未覆盖到的题目，用你自己的知识作答，并在该题答案开头标注【笔记未覆盖】。" +
    "题目多为主观简答/论述题，答案要点清晰、条理化、可直接抄写，不要写空话套话。\n\n" +
    "【笔记开始】\n" + (notes || "（用户未提供笔记）") + "\n【笔记结束】";

  const qText = questions
    .map((q) => {
      let s = `第${q.index}题（${TYPE_LABEL[q.type] || "题目"}）：${q.stem}`;
      if (q.options && q.options.length) {
        s += "\n选项：" + q.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join("   ");
      }
      return s;
    })
    .join("\n\n");

  const user =
    "请回答下列题目。只返回一个 JSON 对象，不要输出任何多余文字或 markdown 代码块围栏，格式严格为：\n" +
    '{"answers":[{"index":题号数字,"answer":"答案文本"}]}\n\n' +
    qText;

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

async function askAI(questions) {
  const { config, notes } = await loadConfig();
  if (!config.baseUrl || !config.apiKey || !config.model) {
    throw new Error("未配置 baseURL / apiKey / model，请点扩展图标在弹窗里填写");
  }
  const endpoint = toChatEndpoint(config.baseUrl);
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
        messages: buildMessages(notes, questions),
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
  if (msg?.type === "ASK_AI") {
    askAI(msg.questions)
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
