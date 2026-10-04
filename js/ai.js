// 调用 DeepSeek（和物品档案同一套写法）。密钥由调用方传进来：先找账本仓库的 config/ai.json，没有就用物品档案仓库里的。

export class AiError extends Error {}

// 返回解析好的 JSON 对象。system / user 是提示词；会先思考再回答的模型（如 deepseek-flash）思考也占 max_tokens
export async function askJson({ key, model }, system, user, { maxTokens = 8000, timeout = 150000, history = [] } = {}) {
  if (!key) throw new AiError('还没有 DeepSeek 密钥（在物品档案的「设置 → AI」里填过就会自动用）');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST', signal: ctrl.signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || 'deepseek-flash',
        messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: user }],
        response_format: { type: 'json_object' },
        temperature: 0.6,
        max_tokens: maxTokens,
      }),
    });
  } catch (e) {
    throw new AiError(e.name === 'AbortError' ? 'DeepSeek 太久没响应' : '连不上 DeepSeek');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const msg = { 401: 'DeepSeek 密钥不对', 402: 'DeepSeek 余额不足', 429: 'DeepSeek 请求太频繁' }[res.status];
    throw new AiError(msg || `DeepSeek 返回 ${res.status}`);
  }
  const choice = (await res.json()).choices?.[0];
  if (choice?.finish_reason === 'length') throw new AiError('DeepSeek 想得太久，回答被截断了');
  try {
    return JSON.parse(choice.message.content);
  } catch {
    throw new AiError('DeepSeek 的回答格式不对');
  }
}
