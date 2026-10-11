import Anthropic from '@anthropic-ai/sdk';

// Models the browser is allowed to ask for. Anything else is rejected, so a
// leaked endpoint cannot be pointed at a more expensive model.
const ALLOWED_MODELS = new Set([
  'claude-sonnet-4-5',
  'claude-sonnet-5-5',
  'claude-opus-5-5',
  'claude-haiku-5-5'
]);

const DEFAULT_MODEL = 'claude-sonnet-5-5';
const MAX_TOKENS_CAP = 16000;

const client = new Anthropic();

function fail(res, status, message) {
  return res.status(status).json({ error: { message } });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return fail(res, 405, 'Method not allowed');
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return fail(res, 500, 'ANTHROPIC_API_KEY is not set on the server');
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
  const { system, messages, model, max_tokens } = body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return fail(res, 400, 'messages must be a non-empty array');
  }
  if (model && !ALLOWED_MODELS.has(model)) {
    return fail(res, 400, 'model not allowed');
  }

  try {
    // Streamed server-side so a long generation does not sit on an idle
    // connection; the browser still receives one JSON object.
    const stream = client.messages.stream({
      model: model || DEFAULT_MODEL,
      max_tokens: Math.min(Number(max_tokens) || 12000, MAX_TOKENS_CAP),
      system,
      messages
    });
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
