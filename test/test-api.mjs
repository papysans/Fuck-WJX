// 本地联调脚本：读 .env，用 OpenAI 兼容格式打一次真实请求，验证 F3 链路（不依赖 Chrome）。
// 运行：node test/test-api.mjs
import fs from "node:fs";

function loadEnv() {
  const raw = fs.readFileSync(new URL("../.env", import.meta.url), "utf8");
  const env = {};
  for (const line of raw.split("\n")) {
    if (!line || line.trim().startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return env;
}

function toChatEndpoint(baseUrl) {
  let u = (baseUrl || "").trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(u)) return u;
  if (/\/v\d+$/.test(u)) return u + "/chat/completions";
  return u + "/chat/completions";
}

function parseAnswers(content) {
  const tryParse = (t) => { try { return JSON.parse(t); } catch { return null; } };
  let obj = tryParse(content);
  if (!obj) { const m = content.match(/\{[\s\S]*\}/); if (m) obj = tryParse(m[0]); }
  return obj && Array.isArray(obj.answers) ? { mode: "structured", answers: obj.answers } : { mode: "raw", raw: content };
}

const env = loadEnv();
const endpoint = toChatEndpoint(env.OPENAI_BASE_URL);
const notes = "# 计算机网络\nTCP 三次握手：SYN → SYN-ACK → ACK，目的是同步双方序列号、确认收发能力。\nTCP 与 UDP 区别：TCP 面向连接、可靠、有序、有拥塞控制；UDP 无连接、不可靠、开销小、实时性好。";
const questions = [
  { index: 1, type: "text", stem: "简述 TCP 三次握手的过程及其目的。" },
  { index: 2, type: "text", stem: "对比 TCP 与 UDP 的主要区别。" },
  { index: 3, type: "text", stem: "解释什么是量子纠缠。（笔记未覆盖，测试兜底标注）" },
];

const messages = [
  {
    role: "system",
    content:
      "你是开卷考试答题助手。下面【笔记】是我今天整理的资料。优先严格依据笔记回答；笔记未覆盖的用你的知识作答并在答案开头标注【笔记未覆盖】。答案要点清晰可直接抄写。\n\n【笔记开始】\n" +
      notes +
      "\n【笔记结束】",
  },
  {
    role: "user",
    content:
      '只返回 JSON：{"answers":[{"index":题号,"answer":"答案"}]}，不要多余文字。\n\n' +
      questions.map((q) => `第${q.index}题：${q.stem}`).join("\n\n"),
  },
];

console.log("→ endpoint:", endpoint, "| model:", env.OPENAI_MODEL);
const t0 = Date.now();
const resp = await fetch(endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENAI_API_KEY}` },
  body: JSON.stringify({ model: env.OPENAI_MODEL, temperature: 0.3, messages }),
});

if (!resp.ok) {
  console.error("✗ HTTP", resp.status, (await resp.text()).slice(0, 500));
  process.exit(1);
}
const data = await resp.json();
const content = data?.choices?.[0]?.message?.content ?? "";
const parsed = parseAnswers(content);
console.log(`✓ ${resp.status} in ${Date.now() - t0}ms | 解析模式: ${parsed.mode}`);
if (parsed.mode === "structured") {
  for (const a of parsed.answers) console.log(`\n【第${a.index}题】\n${a.answer}`);
} else {
  console.log("\n原始返回（未能解析成 JSON，前端会走 raw 兜底展示）：\n", content.slice(0, 800));
}
