// Temporary diagnostic for "ANTHROPIC_API_KEY is not set on the server".
//
// Reports which environment the deployment is running as and which
// credential-shaped variable NAMES reached it. It never returns a variable's
// value - only its length and whether it has the expected prefix.
//
// Delete this file once the key is working:
//   git rm api/debug-env.js && git commit -m "Remove env diagnostic" && git push
import { resolveApiKey } from './chat.js';

export default function handler(req, res) {
  const env = process.env;

  // JSON.stringify keeps the quotes, so a trailing space in a pasted variable
  // name shows up as "ANTHROPIC_API_KEY " instead of looking correct.
  const candidates = Object.keys(env)
    .filter(n => /anthropic|api|key|token|secret/i.test(n))
    .sort()
    .map(n => ({
      name: JSON.stringify(n),
      nameHasPadding: n !== n.trim(),
      valueLength: (env[n] || '').length,
      valueHasPadding: (env[n] || '') !== (env[n] || '').trim()
    }));

  const key = resolveApiKey();

  res.status(200).json({
    resolved: Boolean(key),
    keyLength: key ? key.length : 0,
    looksLikeAnthropicKey: key ? key.startsWith('sk-ant-') : false,
    deployment: {
      vercelEnv: env.VERCEL_ENV || null,       // production | preview | development
      branch: env.VERCEL_GIT_COMMIT_REF || null,
      commit: (env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null,
      url: env.VERCEL_URL || null
    },
    credentialVariablesSeen: candidates,
    totalEnvVars: Object.keys(env).length,
    hint: key
      ? 'Key resolved. If /api/chat still fails, the error is coming from the API call itself, not from configuration.'
      : 'No usable ANTHROPIC_API_KEY. Check credentialVariablesSeen: if the name is absent the variable is not set for this environment; if it appears with padding or a zero length, re-enter it.'
  });
}
