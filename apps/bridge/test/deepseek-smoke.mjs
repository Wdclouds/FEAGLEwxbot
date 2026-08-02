const apiBase = process.env.LLM_API_BASE
  || process.env.DEEPSEEK_API_BASE
  || 'https://api.deepseek.com/v1';
const model = process.env.LLM_MODEL
  || process.env.DEEPSEEK_MODEL
  || 'deepseek-v4-flash';
const key = process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY;

if (!key) {
  throw new Error('LLM_API_KEY is not set');
}

const response = await fetch(`${apiBase}/models`, {
  headers: { Authorization: `Bearer ${key}` },
  signal: AbortSignal.timeout(30_000),
});
const body = await response.json().catch(() => ({}));
const modelAvailable = Array.isArray(body.data)
  && body.data.some((item) => item?.id === model);

console.log(JSON.stringify({
  httpStatus: response.status,
  authenticated: response.ok,
  requestedModel: model,
  modelAvailable,
}));

if (!response.ok || !modelAvailable) process.exitCode = 1;
