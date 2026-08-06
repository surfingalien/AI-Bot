// Out-of-tab alerting. One place decides which webhook a message goes to and
// what shape it takes, so both the HTTP route and the autonomy loop behave
// identically.

import { config } from '../config.js';
import { postJson } from './safeFetch.js';
import { briefFor } from './voiceBrief.js';
import { log } from './log.js';

/**
 * @param {string} text
 * @param {string} [requestWebhook] Caller-supplied target, honoured only when
 *   NOTIFY_ALLOW_REQUEST_WEBHOOK is on — otherwise anyone with access to the
 *   API could use the server as a relay.
 */
export async function sendNotification(text, requestWebhook = '', options = {}) {
  let message = String(text || '').trim();
  if (!message) return { delivered: false, reason: 'empty message' };

  // Rewrite before the webhook, not after: the message that lands on a phone
  // is the only one anyone reads.
  let voiced = null;
  if (config.notify.voice && options.voice !== false) {
    const brief = await briefFor(message, { style: 'alert' });
    if (brief.script) {
      voiced = brief.source;
      message = brief.script;
    }
  }

  let hook = config.notify.webhook;
  if (requestWebhook) {
    if (!config.notify.allowRequestWebhook) {
      return { delivered: false, reason: 'request-supplied webhooks are disabled', message, voiced };
    }
    hook = requestWebhook;
  }
  if (!hook) {
    return {
      delivered: false,
      reason: 'no webhook configured (set NOTIFY_WEBHOOK)',
      message,
      voiced,
    };
  }

  try {
    // `text` suits Slack, `content` suits Discord; sending both keeps one
    // payload working against either.
    await postJson(hook, { text: message, content: message });
    return { delivered: true, message, voiced };
  } catch (err) {
    log.warn(`notification delivery failed: ${err?.message || err}`);
    return { delivered: false, reason: err?.message || String(err), message, voiced };
  }
}
