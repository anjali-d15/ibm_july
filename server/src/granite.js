'use strict';

/**
 * Granite alternative-generation via watsonx.ai.
 *
 * buildPrompt()         — constructs the user message for Granite
 * generateAlternative() — calls the watsonx inference API, returns { alternative }
 *                         Throws on network / parse error; caller handles status=failed.
 */

const { getBearerToken } = require('./token-manager');

const WATSONX_MODEL = 'ibm/granite-3-8b-instruct';
const GENERATION_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Dev-only response cache (keyed on prompt content).
// Guarded by NODE_ENV check — never runs in production.
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
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * @param {string} selectedText
 * @param {string|undefined} instruction  — optional free-form user instruction
 * @returns {string}
 */
function buildPrompt(selectedText, instruction) {
  const directive = instruction && instruction.trim()
    ? `Rewrite the following passage so that it ${instruction.trim()}.`
    : `Write an alternative version of the following passage that preserves its general tone and intent.`;

  return (
    `${directive}\n` +
    `Return ONLY the rewritten text as JSON in this exact format: {"alternative": "..."}\n` +
    `Do not include any explanation, preamble, or markdown.\n\n` +
    `Passage:\n${selectedText}`
  );
}

// ---------------------------------------------------------------------------
// Granite call
// ---------------------------------------------------------------------------

/**
 * @param {string} selectedText
 * @param {string|undefined} instruction
 * @returns {Promise<string>}  the alternative text
 * @throws if the call fails, times out, or the response can't be parsed
 */
async function generateAlternative(selectedText, instruction) {
  const prompt = buildPrompt(selectedText, instruction);

  const cached = devCacheGet(prompt);
  if (cached !== undefined) {
    console.log('[granite] cache hit');
    return cached;
  }

  const token = await getBearerToken();
  const projectId = process.env.WATSONX_PROJECT_ID;
  const baseUrl = process.env.WATSONX_URL || 'https://us-south.ml.cloud.ibm.com';
  const url = `${baseUrl}/ml/v1/text/generation?version=2023-05-29`;

  const payload = {
    model_id: WATSONX_MODEL,
    input: prompt,
    parameters: {
      decoding_method: 'greedy',
      max_new_tokens: 400,
      stop_sequences: ['\n\n'],
    },
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
  const rawText = data?.results?.[0]?.generated_text ?? '';

  // Defensive parse: must be valid JSON with a non-empty `alternative` field
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
  devCacheSet(prompt, result);
  return result;
}

// ---------------------------------------------------------------------------
// Why summary
// ---------------------------------------------------------------------------

/**
 * Build the prompt for the why-summary call.
 * @param {string} originalSnippet
 * @param {string} branchContent
 * @returns {string}
 */
function buildWhyPrompt(originalSnippet, branchContent) {
  return (
    `You are a writing assistant. Explain in one or two sentences why the author might have preferred the alternative passage over the original.\n` +
    `Return ONLY the explanation as JSON in this exact format: {"why": "..."}\n` +
    `Do not include any explanation, preamble, or markdown.\n\n` +
    `Original:\n${originalSnippet}\n\n` +
    `Alternative:\n${branchContent}`
  );
}

/**
 * Ask Granite to draft a one-to-two sentence rationale for choosing
 * branchContent over originalSnippet.
 *
 * @param {string} originalSnippet
 * @param {string} branchContent
 * @returns {Promise<string>}  the why text
 * @throws if the call fails, times out, or the response can't be parsed
 */
async function draftWhySummary(originalSnippet, branchContent) {
  const prompt = buildWhyPrompt(originalSnippet, branchContent);

  const cached = devCacheGet(prompt);
  if (cached !== undefined) {
    console.log('[granite] why cache hit');
    return cached;
  }

  const token = await getBearerToken();
  const projectId = process.env.WATSONX_PROJECT_ID;
  const baseUrl = process.env.WATSONX_URL || 'https://us-south.ml.cloud.ibm.com';
  const url = `${baseUrl}/ml/v1/text/generation?version=2023-05-29`;

  const payload = {
    model_id: WATSONX_MODEL,
    input: prompt,
    parameters: {
      decoding_method: 'greedy',
      max_new_tokens: 200,
      stop_sequences: ['\n\n'],
    },
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
    if (err.name === 'AbortError') throw new Error('Granite why-summary call timed out after 20s');
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Granite API error: ${res.status} ${text}`);
  }

  const data = await res.json();
  const rawText = data?.results?.[0]?.generated_text ?? '';

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
  devCacheSet(prompt, result);
  return result;
}

module.exports = { generateAlternative, buildPrompt, draftWhySummary, buildWhyPrompt };
