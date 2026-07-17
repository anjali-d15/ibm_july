'use strict';

/**
 * Granite calls via watsonx.ai chat endpoint.
 *
 * Uses /ml/v1/text/chat with response_format: { type: "json_object" } so the
 * API-level JSON mode is the primary guarantee — prompt structure is
 * defence-in-depth, not the sole guard.
 *
 * Exports:
 *   generateAlternative(selectedText, instruction?) → Promise<string>
 *   draftWhySummary(originalSnippet, branchContent) → Promise<string>
 *   buildPrompt / buildWhyPrompt — exported for tests only
 */

const { getBearerToken } = require('./token-manager');

const WATSONX_MODEL = 'ibm/granite-3-8b-instruct';
const GENERATION_TIMEOUT_MS = 20_000;
const CHAT_API_VERSION = '2024-05-31';

// ---------------------------------------------------------------------------
// Dev-only response cache — never runs in production
// ---------------------------------------------------------------------------
const devCache = new Map();

function devCacheGet(key) {
  if (process.env.NODE_ENV === 'production') return undefined;
  return devCache.get(key);
}
function devCacheSet(key, value) {
  if (process.env.NODE_ENV !== 'production') devCache.set(key, value);
}

// ---------------------------------------------------------------------------
// Shared: call the chat endpoint
// ---------------------------------------------------------------------------

/**
 * Low-level chat call. Returns the raw generated text string from the first
 * choice. Throws on network error, timeout, or non-2xx response.
 *
 * @param {{ role: string, content: string }[]} messages
 * @param {number} maxNewTokens
 * @returns {Promise<string>}
 */
async function callChat(messages, maxNewTokens) {
  const token = await getBearerToken();
  const projectId = process.env.WATSONX_PROJECT_ID;
  const baseUrl = process.env.WATSONX_URL || 'https://us-south.ml.cloud.ibm.com';
  const url = `${baseUrl}/ml/v1/text/chat?version=${CHAT_API_VERSION}`;

  const payload = {
    model_id: WATSONX_MODEL,
    messages,
    parameters: {
      decoding_method: 'greedy',
      max_new_tokens: maxNewTokens,
    },
    response_format: { type: 'json_object' },
    project_id: projectId,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Granite call timed out after 20s');
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Granite API error: ${res.status} ${text}`);
  }

  const data = await res.json();
  // Chat endpoint: choices[0].message.content
  const content = data?.choices?.[0]?.message?.content ?? '';
  if (!content) throw new Error('Granite returned an empty response');
  return content;
}

// ---------------------------------------------------------------------------
// Alternative generation
// ---------------------------------------------------------------------------

const ALTERNATIVE_SYSTEM = [
  'You are a precise creative writing assistant.',
  'You always respond with valid JSON only — no prose, no markdown, no explanation outside the JSON.',
  'Your response must be a single JSON object with exactly this key: "alternative".',
  'The value of "alternative" is the rewritten passage text, as a plain string.',
].join(' ');

/**
 * Build the user message for alternative generation.
 * @param {string} selectedText
 * @param {string|undefined} instruction
 * @returns {string}
 */
function buildPrompt(selectedText, instruction) {
  const directive = instruction && instruction.trim()
    ? `Rewrite the following passage so that it ${instruction.trim()}.`
    : `Write an alternative version of the following passage that preserves its general tone and intent.`;

  return (
    `Your response must be a JSON object with exactly this structure:\n` +
    `{"alternative": "<your rewritten passage here>"}\n\n` +
    `Example of a correct response:\n` +
    `{"alternative": "She arrived at noon, just as the clock struck twelve."}\n\n` +
    `${directive}\n\n` +
    `Passage to rewrite:\n${selectedText}`
  );
}

/**
 * @param {string} selectedText
 * @param {string|undefined} instruction
 * @returns {Promise<string>}  the alternative text
 * @throws if the call fails, times out, or the response can't be parsed
 */
async function generateAlternative(selectedText, instruction) {
  const userMessage = buildPrompt(selectedText, instruction);
  const cacheKey = userMessage;

  const cached = devCacheGet(cacheKey);
  if (cached !== undefined) {
    console.log('[granite] alternative cache hit');
    return cached;
  }

  const rawText = await callChat(
    [
      { role: 'system', content: ALTERNATIVE_SYSTEM },
      { role: 'user', content: userMessage },
    ],
    400
  );

  let parsed;
  try {
    parsed = JSON.parse(rawText.trim());
  } catch {
    throw new Error(`Granite response is not valid JSON: ${rawText.slice(0, 200)}`);
  }

  if (typeof parsed.alternative !== 'string' || parsed.alternative.trim() === '') {
    throw new Error(`Granite response missing "alternative" field: ${rawText.slice(0, 200)}`);
  }

  const result = parsed.alternative.trim();
  devCacheSet(cacheKey, result);
  return result;
}

// ---------------------------------------------------------------------------
// Why summary
// ---------------------------------------------------------------------------

const WHY_SYSTEM = [
  'You are a precise writing assistant.',
  'You always respond with valid JSON only — no prose, no markdown, no explanation outside the JSON.',
  'Your response must be a single JSON object with exactly this key: "why".',
  'The value of "why" is one or two sentences explaining the rationale, as a plain string.',
].join(' ');

/**
 * Build the user message for the why-summary call.
 * @param {string} originalSnippet
 * @param {string} branchContent
 * @returns {string}
 */
function buildWhyPrompt(originalSnippet, branchContent) {
  return (
    `Your response must be a JSON object with exactly this structure:\n` +
    `{"why": "<your one-to-two sentence explanation here>"}\n\n` +
    `Example of a correct response:\n` +
    `{"why": "The alternative shifts the emotional register from anxious to resolute, giving the character more agency."}\n\n` +
    `Explain in one or two sentences why an author might have preferred the alternative passage over the original.\n\n` +
    `Original:\n${originalSnippet}\n\n` +
    `Alternative:\n${branchContent}`
  );
}

/**
 * @param {string} originalSnippet
 * @param {string} branchContent
 * @returns {Promise<string>}  the why text
 * @throws if the call fails, times out, or the response can't be parsed
 */
async function draftWhySummary(originalSnippet, branchContent) {
  const userMessage = buildWhyPrompt(originalSnippet, branchContent);
  const cacheKey = userMessage;

  const cached = devCacheGet(cacheKey);
  if (cached !== undefined) {
    console.log('[granite] why cache hit');
    return cached;
  }

  const rawText = await callChat(
    [
      { role: 'system', content: WHY_SYSTEM },
      { role: 'user', content: userMessage },
    ],
    200
  );

  let parsed;
  try {
    parsed = JSON.parse(rawText.trim());
  } catch {
    throw new Error(`Granite why-summary response is not valid JSON: ${rawText.slice(0, 200)}`);
  }

  if (typeof parsed.why !== 'string' || parsed.why.trim() === '') {
    throw new Error(`Granite why-summary response missing "why" field: ${rawText.slice(0, 200)}`);
  }

  const result = parsed.why.trim();
  devCacheSet(cacheKey, result);
  return result;
}

module.exports = { generateAlternative, buildPrompt, draftWhySummary, buildWhyPrompt };
