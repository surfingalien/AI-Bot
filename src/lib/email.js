// Email delivery, following FinSurfing's ladder: Resend's HTTP API first, SMTP
// second, and an honest log line when neither is configured.
//
// Resend needs no dependency, so it is the path that always works here. SMTP
// needs nodemailer, which is an optional install rather than something every
// deployment pays for — when it is missing that is reported plainly instead of
// failing at send time with a module error.

import { config } from '../config.js';
import { assertPublicUrl } from './safeFetch.js';
import { log } from './log.js';

let smtpTransport;
let smtpChecked = false;

async function getSmtp() {
  if (smtpChecked) return smtpTransport;
  smtpChecked = true;
  const { host, user, pass } = config.email.smtp;
  if (!host || !user || !pass) return null;
  try {
    const { default: nodemailer } = await import('nodemailer');
    smtpTransport = nodemailer.createTransport({
      host,
      port: config.email.smtp.port,
      secure: config.email.smtp.secure,
      auth: { user, pass },
    });
  } catch {
    log.warn('SMTP is configured but nodemailer is not installed — run: npm install nodemailer');
    smtpTransport = null;
  }
  return smtpTransport;
}

export function emailConfigured() {
  return Boolean(
    config.email.resendKey || (config.email.smtp.host && config.email.smtp.user),
  );
}

/** Minimal markdown -> HTML, enough for the reports this server produces. */
export function markdownToHtml(markdown) {
  const escape = (s) =>
    String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

  const lines = String(markdown || '').split('\n');
  const out = [];
  let table = null;

  const flushTable = () => {
    if (!table) return;
    const [head, ...rows] = table;
    out.push(
      '<table style="border-collapse:collapse;width:100%;font-size:13px;margin:12px 0">',
      `<thead><tr>${head
        .map(
          (h) =>
            `<th style="border:1px solid #d5dde8;padding:6px 9px;background:#eef3fa;text-align:left">${escape(h)}</th>`,
        )
        .join('')}</tr></thead><tbody>`,
      ...rows.map(
        (r) =>
          `<tr>${r
            .map((c) => `<td style="border:1px solid #d5dde8;padding:6px 9px">${inline(c)}</td>`)
            .join('')}</tr>`,
      ),
      '</tbody></table>',
    );
    table = null;
  };

  const inline = (s) =>
    escape(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/_([^_]+)_/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');

  for (const line of lines) {
    const cells = line.match(/^\s*\|(.+)\|\s*$/);
    if (cells) {
      const parts = cells[1].split('|').map((c) => c.trim());
      // The |---|---| separator carries no content.
      if (parts.every((p) => /^:?-{2,}:?$/.test(p))) continue;
      (table = table || []).push(parts);
      continue;
    }
    flushTable();

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(4, heading[1].length + 1);
      out.push(`<h${level} style="margin:16px 0 6px">${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      out.push(`<div style="margin:2px 0 2px 14px">• ${inline(line.replace(/^\s*[-*]\s+/, ''))}</div>`);
      continue;
    }
    if (!line.trim()) continue;
    out.push(`<p style="margin:8px 0">${inline(line)}</p>`);
  }
  flushTable();

  return [
    '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#16202e;max-width:680px">',
    out.join('\n'),
    '<hr style="border:none;border-top:1px solid #d5dde8;margin:20px 0">',
    '<p style="font-size:11px;color:#6b7c93">Sent by SurfingAlien. Rules-based analysis, not financial advice.</p>',
    '</div>',
  ].join('\n');
}

/**
 * @param {{to?:string, subject:string, markdown?:string, html?:string, text?:string}} message
 * @returns {Promise<{sent:boolean, via:string, reason?:string}>}
 */
export async function sendEmail(message) {
  const to = message.to || config.email.to;
  const subject = String(message.subject || '').trim() || 'SurfingAlien report';
  if (!to) return { sent: false, via: 'none', reason: 'no recipient (set EMAIL_TO)' };

  const html = message.html || markdownToHtml(message.markdown || message.text || '');
  const text = message.text || message.markdown || '';

  if (config.email.resendKey) {
    try {
      // Validated even though it is configured rather than caller-supplied:
      // this module must never become a way to POST the operator's reports at
      // an arbitrary internal host.
      const url = await assertPublicUrl(config.email.resendUrl);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.email.resendKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from: config.email.from, to: [to], subject, html, text }),
        signal: AbortSignal.timeout(config.email.timeoutMs),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Resend HTTP ${res.status}: ${body.slice(0, 160)}`);
      }
      log.info(`email sent to ${to} via Resend: ${subject}`);
      return { sent: true, via: 'resend' };
    } catch (err) {
      log.warn(`Resend delivery failed: ${err?.message || err}`);
      return { sent: false, via: 'resend', reason: err?.message || String(err) };
    }
  }

  const transport = await getSmtp();
  if (transport) {
    try {
      await transport.sendMail({ from: config.email.from, to, subject, html, text });
      log.info(`email sent to ${to} via SMTP: ${subject}`);
      return { sent: true, via: 'smtp' };
    } catch (err) {
      log.warn(`SMTP delivery failed: ${err?.message || err}`);
      return { sent: false, via: 'smtp', reason: err?.message || String(err) };
    }
  }

  // Nothing configured: say what would have gone out rather than pretending.
  log.info(`[email dry run] to=${to} subject="${subject}" (${text.length} chars)`);
  return { sent: false, via: 'dry-run', reason: 'no email provider configured' };
}
