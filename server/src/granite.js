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
  'You are a Narrative Architect — a master story co-author and dramatic analyst.',
  'Before rewriting, you silently analyze: character motivations and psychological states,',
  'underlying tensions and power dynamics, plot causality and dramatic stakes,',
  'and the potential for dramatic shifts (character decisions, alternate fates, plot twists, subversion of expectations).',
  'You handle both structural narrative changes (character choices, plot outcomes, fates, twists)',
  'and stylistic/tonal rewrites with equal authority.',
  'You always respond with valid JSON only — no prose, no markdown, no explanation outside the JSON.',
  'Your response must be a single JSON object with exactly this key: "alternative".',
  'The value of "alternative" is the rewritten passage text, as a plain string.',
].join(' ');

/**
 * Build the user message for alternative generation.
 * Acts as a Narrative Architect: analyzes character motivations, underlying tensions,
 * plot causality, and dramatic stakes before crafting the alternative.
 * @param {string} selectedText
 * @param {string|undefined} instruction
 * @returns {string}
 */
function buildPrompt(selectedText, instruction) {
  const directive = instruction && instruction.trim()
    ? `Creative direction: "${instruction.trim()}". Consider the character motivations, dramatic stakes, and plot causality present in the passage. You may alter character choices, fates, plot outcomes, introduce twists, or subvert expectations as needed.`
    : `Analyze the character motivations, tensions, and dramatic stakes in this passage, then write an alternative narrative path that explores a meaningfully different plot direction, character decision, or dramatic outcome.`;

  return (
    `Your response must be a JSON object with exactly this structure:\n` +
    `{"alternative": "<your rewritten passage here>"}\n\n` +
    `Example of a correct response:\n` +
    `{"alternative": "She arrived at noon, just as the clock struck twelve."}\n\n` +
    `Original passage:\n${selectedText}\n\n` +
    `${directive}\n\n` +
    `Do not write preamble or explanations. Return only the JSON object.`
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
    // Defensive fallback: try extracting JSON object with regex, then plain text
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try { parsed = JSON.parse(jsonMatch[0]); } catch { /* fall through */ }
    }
    if (!parsed) {
      // Last resort: use the raw text as the alternative itself
      const text = rawText.trim();
      if (text) {
        const result = text.slice(0, 8000);
        devCacheSet(cacheKey, result);
        return result;
      }
      throw new Error(`Granite response is not valid JSON: ${rawText.slice(0, 200)}`);
    }
  }

  if (typeof parsed.alternative !== 'string' || parsed.alternative.trim() === '') {
    // Defensive fallback: check for common field variants
    const alt = parsed.alternative ?? parsed.text ?? parsed.result ?? parsed.content;
    if (typeof alt === 'string' && alt.trim()) {
      const result = alt.trim().slice(0, 8000);
      devCacheSet(cacheKey, result);
      return result;
    }
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
  'You are a senior narrative editor and dramatic analyst.',
  'When comparing an original passage to an alternative, you evaluate the broader narrative impact:',
  'character motivations and psychological depth, pacing and tension, atmosphere, and plot consequences.',
  'You always respond with valid JSON only — no prose, no markdown, no explanation outside the JSON.',
  'Your response must be a single JSON object with exactly this key: "why".',
  'The value of "why" is one or two precise, insightful sentences about the narrative effect of the change,',
  'as a plain string. Focus on what meaningfully shifts — character agency, emotional register, plot stakes,',
  'or thematic direction — not surface-level wording differences.',
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
    `{"why": "<your one-to-two sentence narrative analysis here>"}\n\n` +
    `Example of a correct response:\n` +
    `{"why": "The alternative shifts the character from passive witness to active instigator, raising the moral stakes and accelerating the plot toward a confrontation the original passage delayed."}\n\n` +
    `Analyze how the alternative passage changes the narrative compared to the original.\n` +
    `Focus on: character motivation or agency, emotional/atmospheric shift, pacing impact, or plot consequences.\n` +
    `Do NOT summarize the text — explain the narrative effect of choosing one over the other.\n\n` +
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
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try { parsed = JSON.parse(jsonMatch[0]); } catch { /* fall through */ }
    }
    if (!parsed) {
      const text = rawText.trim();
      if (text) {
        const result = text.slice(0, 2000);
        devCacheSet(cacheKey, result);
        return result;
      }
      throw new Error(`Granite why-summary response is not valid JSON: ${rawText.slice(0, 200)}`);
    }
  }

  if (typeof parsed.why !== 'string' || parsed.why.trim() === '') {
    const why = parsed.why ?? parsed.text ?? parsed.result ?? parsed.rationale;
    if (typeof why === 'string' && why.trim()) {
      const result = why.trim().slice(0, 2000);
      devCacheSet(cacheKey, result);
      return result;
    }
    throw new Error(`Granite why-summary response missing "why" field: ${rawText.slice(0, 200)}`);
  }

  const result = parsed.why.trim();
  devCacheSet(cacheKey, result);
  return result;
}

// ---------------------------------------------------------------------------
// P5 — Consistency checker
// ---------------------------------------------------------------------------

const CONSISTENCY_SYSTEM = [
  'You are a meticulous story editor specializing in plot, timeline, and narrative fact continuity.',
  'You always respond with valid JSON only — no prose, no markdown, no explanation outside the JSON.',
  'Your response must be a single JSON object with exactly this key: "findings".',
  'The value of "findings" is an array (possibly empty) of objects each with "fork_id" (string) and "question" (string).',
].join(' ');

/**
 * Build the prompt for the consistency check.
 * @param {string} resolvedText  — the full resolved document text
 * @param {{ id: string, why: string }[]} decisions — active-path forks with non-null why, ordered by created_at ASC
 * @returns {string}
 */
function buildConsistencyPrompt(resolvedText, decisions) {
  const decisionList = decisions
    .map((d, i) => `Decision ${i + 1} (fork_id: "${d.id}"):\n  Narrative rationale: ${d.why}`)
    .join('\n\n');

  return (
    `Your response must be a JSON object with exactly this structure:\n` +
    `{"findings": [{"fork_id": "...", "question": "..."}, ...]}\n\n` +
    `An empty array means no contradictions were found.\n\n` +
    `You are a story editor reviewing a manuscript alongside the author's recorded narrative decisions.\n` +
    `For each decision, check whether the current document text contradicts or undermines the stated intent.\n` +
    `Specifically look for:\n` +
    `- Plot contradictions: a character acts in a way that conflicts with an earlier established decision or outcome\n` +
    `- Timeline mismatches: events occur in an order inconsistent with earlier text (e.g., an object is used before it was obtained)\n` +
    `- Fact continuity errors: physical details, character traits, locations, or item states that contradict earlier descriptions\n` +
    `- Tone/motivation drift: a character's emotional state or motivation contradicts what was established in the recorded decision\n` +
    `Only flag contradictions in content that follows the decision chronologically.\n` +
    `For each contradiction found, include the fork_id and a specific clarifying question that helps the author resolve the issue.\n\n` +
    `Recorded decisions (ordered oldest first):\n${decisionList}\n\n` +
    `Current document:\n${resolvedText}`
  );
}

/**
 * Run the plot/intent consistency check.
 * @param {string} resolvedText
 * @param {{ id: string, why: string }[]} decisions
 * @returns {Promise<{ fork_id: string, question: string }[]>}
 * @throws if the Granite call fails or the response can't be parsed
 */
async function checkConsistency(resolvedText, decisions) {
  const userMessage = buildConsistencyPrompt(resolvedText, decisions);
  const cacheKey = userMessage;

  const cached = devCacheGet(cacheKey);
  if (cached !== undefined) {
    console.log('[granite] consistency cache hit');
    return cached;
  }

  const rawText = await callChat(
    [
      { role: 'system', content: CONSISTENCY_SYSTEM },
      { role: 'user', content: userMessage },
    ],
    600
  );

  let parsed;
  try {
    parsed = JSON.parse(rawText.trim());
  } catch {
    throw new Error(`Granite consistency response is not valid JSON: ${rawText.slice(0, 200)}`);
  }

  if (!Array.isArray(parsed.findings)) {
    throw new Error(`Granite consistency response missing "findings" array: ${rawText.slice(0, 200)}`);
  }

  // Validate each finding has fork_id and question strings
  const findings = parsed.findings.filter(
    (f) => typeof f.fork_id === 'string' && typeof f.question === 'string'
  );

  devCacheSet(cacheKey, findings);
  return findings;
}

// ---------------------------------------------------------------------------
// Toolbar chip suggestions
// ---------------------------------------------------------------------------

const CHIPS_SYSTEM = [
  'You are a creative writing assistant generating concise action suggestions for a narrative editor toolbar.',
  'You always respond with valid JSON only — no prose, no markdown, no explanation outside the JSON.',
  'Your response must be a single JSON object with exactly this key: "chips".',
  'The value of "chips" is an array of exactly 3 objects.',
  'Each object has two string fields: "label" (short verb phrase, max 5 words, no character names) and "instruction" (specific rewrite directive for the AI, max 25 words).',
].join(' ');

/**
 * Build 3 contextual chip suggestions from a selected passage.
 * @param {string} selectedText
 * @returns {string}
 */
function buildChipsPrompt(selectedText) {
  return (
    `Your response must be a JSON object with exactly this structure:\n` +
    `{"chips": [{"label": "...", "instruction": "..."}, {"label": "...", "instruction": "..."}, {"label": "...", "instruction": "..."}]}\n\n` +
    `Analyze this passage and suggest exactly 3 specific, creative rewrite directions for an author.\n` +
    `Focus on narrative impact: character decisions, emotional stakes, pacing, plot consequences, or tone.\n` +
    `Labels must be concise verb phrases (no character names, max 5 words).\n` +
    `Instructions must be specific directives that guide an AI rewriter (max 25 words each).\n\n` +
    `Passage:\n${selectedText}\n\n` +
    `Return only the JSON object.`
  );
}

/**
 * Generate 3 contextual toolbar chip suggestions for a selected passage.
 * @param {string} selectedText
 * @returns {Promise<{label: string, instruction: string}[]>}
 */
async function suggestChips(selectedText) {
  const userMessage = buildChipsPrompt(selectedText);
  const cacheKey = `chips:${userMessage}`;

  const cached = devCacheGet(cacheKey);
  if (cached !== undefined) {
    console.log('[granite] chips cache hit');
    return cached;
  }

  const rawText = await callChat(
    [
      { role: 'system', content: CHIPS_SYSTEM },
      { role: 'user', content: userMessage },
    ],
    200
  );

  let parsed;
  try {
    parsed = JSON.parse(rawText.trim());
  } catch {
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try { parsed = JSON.parse(jsonMatch[0]); } catch { /* fall through */ }
    }
  }

  if (!parsed || !Array.isArray(parsed.chips)) {
    throw new Error(`Granite chips response missing "chips" array: ${rawText.slice(0, 200)}`);
  }

  const chips = parsed.chips
    .filter((c) => typeof c.label === 'string' && typeof c.instruction === 'string')
    .slice(0, 3);

  devCacheSet(cacheKey, chips);
  return chips;
}

module.exports = {
  generateAlternative,
  buildPrompt,
  draftWhySummary,
  buildWhyPrompt,
  checkConsistency,
  buildConsistencyPrompt,
  suggestChips,
};
