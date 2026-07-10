'use strict';

/**
 * Token manager: IAM key → watsonx bearer token, cached, auto-refreshed.
 *
 * Per AGENTS.md rule: all IAM → bearer exchanges go through this module.
 * Route handlers must never call IAM directly.
 *
 * Lifecycle:
 *   - Token is fetched lazily on first call to getBearerToken().
 *   - Cached until 5 minutes before expiry (IBM tokens live ~1 hour).
 *   - Concurrent callers during an in-flight refresh await the same promise
 *     (no thundering herd).
 */

const IAM_URL = 'https://iam.cloud.ibm.com/identity/token';
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry

let cachedToken = null;       // string
let expiresAtMs = 0;          // epoch ms
let inflightPromise = null;   // deduplicate concurrent refreshes

async function fetchNewToken() {
  const apiKey = process.env.WATSONX_API_KEY;
  if (!apiKey) throw new Error('WATSONX_API_KEY is not set in environment');

  const body = new URLSearchParams({
    grant_type: 'urn:ibm:params:oauth:grant-type:apikey',
    apikey: apiKey,
  });

  const res = await fetch(IAM_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`IAM token fetch failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  // IBM IAM returns expires_in seconds from now
  cachedToken = data.access_token;
  expiresAtMs = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

/**
 * Returns a valid bearer token, refreshing if necessary.
 * @returns {Promise<string>}
 */
async function getBearerToken() {
  if (cachedToken && Date.now() < expiresAtMs - REFRESH_BUFFER_MS) {
    return cachedToken;
  }
  // Deduplicate: if a refresh is already in flight, wait for it
  if (!inflightPromise) {
    inflightPromise = fetchNewToken().finally(() => {
      inflightPromise = null;
    });
  }
  return inflightPromise;
}

module.exports = { getBearerToken };
