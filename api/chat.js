import Anthropic from '@anthropic-ai/sdk';

// Models the browser is allowed to ask for. Anything else is rejected, so a
// leaked endpoint cannot be pointed at a more expensive model.
const ALLOWED_MODELS = new Set([
  'claude-sonnet-4-5',
  'claude-sonnet-5-5',
  'claude-opus-5-5',
  'claude-haiku-5-5'
]);

const ALLOWED_EFFORT = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

// claude-sonnet-4-5 rejects output_config.effort, so it is only sent to models
// that accept it rather than being assumed universal.
const NO_EFFORT = new Set(['claude-sonnet-4-5']);

const DEFAULT_MODEL = 'claude-sonnet-5-5';
const MAX_TOKENS_CAP = 16000;

// Pasting a name into a dashboard field easily leaves a stray space on it, which
// makes process.env.ANTHROPIC_API_KEY undefined while the variable looks right in
// the UI. Fall back to matching names by their trimmed form, and trim the value
// too, so that mistake does not take the whole endpoint down.
export function resolveApiKey(env = process.env) {
  const direct = env.ANTHROPIC_API_KEY;
  if (direct && direct.trim()) return direct.trim();
  for (const [name, value] of Object.entries(env)) {
    if (name.trim() === 'ANTHROPIC_API_KEY' && value && value.trim()) return value.trim();
  }
  return null;
}

function fail(res, status, message) {
  return res.status(status).json({ error: { message } });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return fail(res, 405, 'Method not allowed');
  }

  const apiKey = resolveApiKey();
  if (!apiKey) {
    // Name the environment, because a variable set only for Production looks
    // present in the dashboard while a preview deployment still has nothing.
    const where = process.env.VERCEL_ENV || 'unknown';
    return fail(res, 500,
      `ANTHROPIC_API_KEY is not set for the "${where}" environment. ` +
      'Open /api/debug-env on this same deployment to see what the server received.');
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
  const { system, messages, model, max_tokens, effort } = body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return fail(res, 400, 'messages must be a non-empty array');
  }
  if (model && !ALLOWED_MODELS.has(model)) {
    return fail(res, 400, 'model not allowed');
  }

  try {
    const client = new Anthropic({ apiKey });
    const chosen = model || DEFAULT_MODEL;
    const request = {
      model: chosen,
      max_tokens: Math.min(Number(max_tokens) || 12000, MAX_TOKENS_CAP),
      system,
      messages
    };
    // Effort controls how much reasoning the model spends. Weighing several
    // evidence tiers against each other is the kind of work that repays it.
    if (!NO_EFFORT.has(chosen)) {
      request.output_config = { effort: ALLOWED_EFFORT.has(effort) ? effort : 'high' };
    }
    // Streamed server-side so a long generation does not sit on an idle
    // connection; the browser still receives one JSON object.
    const stream = client.messages.stream(request);
    const message = await stream.finalMessage();

    return res.status(200).json({
      content: message.content,
      stop_reason: message.stop_reason,
      usage: message.usage
    });
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      return fail(res, error.status || 502, error.message);
    }
    return fail(res, 500, error.message || 'Upstream request failed');
  }
}
