// GET /api/fetch?url=… — server-side page reader. The browser cannot fetch
// arbitrary origins (CORS), so deep research routes through here and gets back
// clean text instead of HTML.

import { Router } from 'express';
import { config } from '../config.js';
import { fetchText, FetchError } from '../lib/safeFetch.js';
import { htmlToText } from '../lib/htmlText.js';
import { rateLimit } from '../lib/rateLimit.js';

export const fetchRouter = Router();

fetchRouter.get('/fetch', rateLimit({ name: 'fetch', max: 60 }), async (req, res) => {
  const url = String(req.query.url || '');
  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).json({ ok: false, error: 'bad url' });
  }

  try {
    const result = await fetchText(url, { headers: { Accept: 'text/html,text/plain' } });
    const contentType = result.headers.get('content-type') || '';
    const { title, text } = /html/i.test(contentType) || !contentType
      ? htmlToText(result.body)
      : { title: '', text: result.body.replace(/\s+/g, ' ').trim() };

    return res.json({
      ok: true,
      url: result.url,
      title,
      text: text.slice(0, config.fetch.maxTextChars),
      truncated: text.length > config.fetch.maxTextChars,
    });
  } catch (err) {
    // The client engine only checks `ok`, so 200-with-ok:false keeps its error
    // path intact while the status code stays meaningful for other callers.
    const status = err instanceof FetchError ? err.status : 502;
    return res.status(status).json({ ok: false, error: err?.message || String(err) });
  }
});
