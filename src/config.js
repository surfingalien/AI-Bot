// Central configuration. Everything is env-driven so the same build runs
// locally (`npm start`) and on a host without code changes.

function bool(value, fallback) {
  if (value == null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function list(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const env = process.env;

export const config = {
  port: int(env.PORT, 8787),
  host: env.HOST || '0.0.0.0',
  logLevel: env.LOG_LEVEL || 'info',
  // Anything past this is logged with its path, so slowness is attributable.
  slowRequestMs: int(env.SLOW_REQUEST_MS, 2000),

  // Browsers hitting the API from another origin (e.g. the HTML opened from
  // disk). Requests without an Origin header are always allowed.
  corsOrigins: list(env.CORS_ORIGINS),

  fetch: {
    timeoutMs: int(env.FETCH_TIMEOUT_MS, 15000),
    maxBytes: int(env.FETCH_MAX_BYTES, 2 * 1024 * 1024),
    maxRedirects: int(env.FETCH_MAX_REDIRECTS, 3),
    maxTextChars: int(env.FETCH_MAX_TEXT_CHARS, 20000),
    userAgent:
      env.FETCH_USER_AGENT ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
    // Off by default: without it, /api/fetch is an SSRF hole into whatever
    // network the server sits on.
    allowPrivateEgress: bool(env.ALLOW_PRIVATE_EGRESS, false),
  },

  notify: {
    webhook: env.NOTIFY_WEBHOOK || '',
    // A webhook supplied in the request body can point anywhere, so it is
    // opt-in rather than the default.
    allowRequestWebhook: bool(env.NOTIFY_ALLOW_REQUEST_WEBHOOK, false),
    // Rewrite alerts into one readable line before sending. An alert is read
    // on a phone, away from a screen, so a metric dump is wasted.
    voice: bool(env.NOTIFY_VOICE, true),
  },

  // Upstream OpenAI-compatible endpoint. When a key is set here the browser
  // can talk to /api/v1/chat/completions and never sees the credential.
  brain: {
    base: (env.BRAIN_BASE || '').replace(/\/+$/, ''),
    key: env.BRAIN_KEY || '',
    model: env.BRAIN_MODEL || 'gpt-4o-mini',
    timeoutMs: int(env.BRAIN_TIMEOUT_MS, 120000),
    referer: env.BRAIN_REFERER || 'https://surfingalien.local',
    title: env.BRAIN_TITLE || 'SurfingAlien AI',
  },

  market: {
    // Overridable for a mirror, an offline replay, or a test stub.
    base: (env.YAHOO_BASE || 'https://query1.finance.yahoo.com').replace(/\/+$/, ''),
    chartRange: env.YAHOO_CHART_RANGE || '2y',
    chartInterval: env.YAHOO_CHART_INTERVAL || '1d',
    cacheMs: int(env.MARKET_CACHE_MS, 60000),
    // Much shorter than the generic fetch timeout: a quote is on the critical
    // path of a question someone is waiting on, and the ladder has fallbacks.
    timeoutMs: int(env.MARKET_TIMEOUT_MS, 6000),
    // Budget for the whole quote fallback ladder, so a first call cannot stack
    // three timeouts back to back.
    quoteBudgetMs: int(env.MARKET_QUOTE_BUDGET_MS, 9000),
    // How long a symbol whose whole ladder failed is answered fast instead of
    // making the next caller wait out the same dead endpoints.
    failureTtlMs: int(env.MARKET_FAILURE_TTL_MS, 30000),
    // Consecutive ladder failures before the feed is treated as down.
    breakerThreshold: int(env.MARKET_BREAKER_THRESHOLD, 2),
    breakerMs: int(env.MARKET_BREAKER_MS, 30000),
    // Keeps watchlist symbols warm so the first dossier is not the slow one.
    warmMs: int(env.MARKET_WARM_MS, 300000),
  },

  autonomy: {
    enabled: bool(env.AUTONOMY_ENABLED, true),
    tickMs: int(env.AUTONOMY_TICK_MS, 30000),
    maxActivity: int(env.AUTONOMY_MAX_ACTIVITY, 200),
    stateFile: env.STATE_FILE || 'data/state.json',
  },

  rateLimit: {
    windowMs: int(env.RATE_LIMIT_WINDOW_MS, 60000),
    max: int(env.RATE_LIMIT_MAX, 120),
  },

  predictions: {
    // Append-only, so a scorecard can always be recomputed from the raw record
    // rather than trusted.
    file: env.PREDICTIONS_FILE || 'data/predictions.jsonl',
    // Log a call only when the signal is one somebody would act on.
    logSignals: bool(env.PREDICTIONS_LOG_SIGNALS, true),
  },

  email: {
    // Resend needs no dependency, so it is the path that always works. SMTP
    // needs nodemailer, which is an optional install.
    resendKey: env.RESEND_API_KEY || '',
    // Overridable for a relay, a self-hosted gateway, or a test stub.
    resendUrl: env.RESEND_ENDPOINT || 'https://api.resend.com/emails',
    from: env.EMAIL_FROM || 'SurfingAlien <onboarding@resend.dev>',
    to: env.EMAIL_TO || '',
    timeoutMs: int(env.EMAIL_TIMEOUT_MS, 15000),
    smtp: {
      host: env.SMTP_HOST || '',
      port: int(env.SMTP_PORT, 587),
      secure: bool(env.SMTP_SECURE, false),
      user: env.SMTP_USER || '',
      pass: env.SMTP_PASS || '',
    },
  },

  analysis: {
    // Framing for written analysis. Never changes the figures.
    persona: env.ANALYSIS_PERSONA || 'neutral',
    // Half Kelly, capped: full Kelly assumes the probability is exactly right.
    kellyFraction: Number(env.KELLY_FRACTION) || 0.5,
    kellyMaxFraction: Number(env.KELLY_MAX_FRACTION) || 0.2,
    kellyMinSamples: int(env.KELLY_MIN_SAMPLES, 15),
  },

  voice: {
    // How long speech may wait on the model before the rules script is spoken
    // instead. Silence while a brief is written is worse than a plainer brief.
    deadlineMs: int(env.VOICE_DEADLINE_MS, 2500),
  },

  auth: {
    // Unset means open, which is fine on loopback and nowhere else: anyone who
    // can reach the port can arm goals and spend the model budget.
    token: env.API_TOKEN || '',
    cookieName: 'sa_token',
    cookieMaxAgeSec: int(env.API_TOKEN_COOKIE_MAX_AGE, 30 * 24 * 3600),
  },
};

export function authRequired() {
  return Boolean(config.auth.token);
}

export function brainConfigured() {
  return Boolean(config.brain.base);
}
