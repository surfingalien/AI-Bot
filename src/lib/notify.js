// Out-of-tab alerting. One place decides which webhook a message goes to and
// what shape it takes, so both the HTTP route and the autonomy loop behave
// identically.

import { config } from '../config.js';
import { postJson } from './safeFetch.js';
import { log } from './log.js';

/**
 * @param {string} text
 * @param {string} [requestWebhook] Caller-supplied target, honoured only when
 *   NOTIFY_ALLOW_REQUEST_WEBHOOK is on — otherwise anyone with access to the
 *   API could use the server as a relay.
 */
export async function sendNotification(text, requestWebhook = '') {
  const message = String(text || '').trim();
  if (!message) return { delivered: false, reason: 'empty message' };

  let hook = config.notify.webhook;
  if (requestWebhook) {
    if (!config.notify.allowRequestWebhook) {
      return { delivered: false, reason: 'request-supplied webhooks are disabled' };
    }
    hook = requestWebhook;
  }
  if (!hook) {
    return { delivered: false, reason: 'no webhook configured (set NOTIFY_WEBHOOK)' };
  }

  try {
    // `text` suits Slack, `content` suits Discord; sending both keeps one
    // payload working against either.
    await postJson(hook, { text: message, content: message });
    return { delivered: true };
  } catch (err) {
    log.warn(`notification delivery failed: ${err?.message || err}`);
    return { delivered: false, reason: err?.message || String(err) };
  }
}
