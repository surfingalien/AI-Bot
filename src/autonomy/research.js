// Deep research, server side. Same three-step shape as the browser tool:
// propose sources -> fetch them through the guarded proxy -> synthesize a
// brief whose every claim carries an [n] citation.

import { config, brainConfigured } from '../config.js';
import { complete } from '../brain/client.js';
import { fetchText } from '../lib/safeFetch.js';
import { htmlToText } from '../lib/htmlText.js';
import { log } from '../lib/log.js';

const SOURCE_PROMPT =
  'You propose authoritative, fetchable source URLs for a research topic. ' +
  'Reply with up to 4 absolute https URLs, one per line, no prose, no markdown.';

const SYNTHESIS_PROMPT =
  'You are a research analyst. Write a concise, structured brief on the topic using ONLY the ' +
  'provided SOURCE SNIPPETS. Cite inline as [n]. End with a "Sources" list mapping [n] to URLs. ' +
  'Mark anything not in the sources as UNVERIFIED. Output markdown.';

export async function proposeSources(topic) {
  if (!brainConfigured()) return [];
  try {
    const text = await complete(
      [
        { role: 'system', content: SOURCE_PROMPT },
        { role: 'user', content: String(topic) },
      ],
      { maxTokens: 300 },
    );
    return (text.match(/https?:\/\/[^\s"'<>)\]]+/g) || []).slice(0, 4);
  } catch (err) {
    log.warn(`source proposal failed: ${err?.message || err}`);
    return [];
  }
}

export async function readPage(url) {
  const res = await fetchText(url, { headers: { Accept: 'text/html' } });
  const { title, text } = htmlToText(res.body);
  return { url: res.url, title, text: text.slice(0, config.fetch.maxTextChars) };
}

/**
 * @param {string} topic
 * @param {string[]} urls Explicit sources; when empty the model proposes them.
 * @returns {Promise<{markdown:string, cited:Array, tried:string[]}>}
 */
export async function deepResearch(topic, urls = []) {
  const targets = urls.length ? urls.slice(0, 4) : await proposeSources(topic);
  if (!targets.length) {
    return {
      markdown: `Deep research: no sources could be proposed for "${topic}".${
        brainConfigured() ? '' : ' (Model brain is not configured — pass explicit urls.)'
      }`,
      cited: [],
      tried: [],
    };
  }

  const pages = await Promise.all(
    targets.map(async (url) => {
      try {
        const page = await readPage(url);
        return { ...page, ok: Boolean(page.text) };
      } catch (err) {
        log.debug(`research fetch failed ${url}: ${err?.message || err}`);
        return { url, ok: false, title: '', text: '' };
      }
    }),
  );

  const cited = [];
  const snippets = [];
  for (const page of pages) {
    if (!page.ok) continue;
    cited.push({ n: cited.length + 1, url: page.url, title: page.title });
    snippets.push(
      `[${cited.length}] ${page.url}${page.title ? ` (title: ${page.title})` : ''}\n` +
        page.text.slice(0, 1400),
    );
  }

  if (!snippets.length) {
    return {
      markdown:
        `Deep research: could not fetch any proposed source (${targets.join(', ')}). ` +
        'The targets may block automated fetches.',
      cited: [],
      tried: targets,
    };
  }

  if (!brainConfigured()) {
    // No synthesis available — still return the extracts, clearly labelled, so
    // the run produces something inspectable instead of nothing.
    const body = cited
      .map((c, i) => `### [${c.n}] ${c.title || c.url}\n${c.url}\n\n${snippets[i].slice(0, 900)}`)
      .join('\n\n');
    return {
      markdown: `## Raw source extracts — ${topic}\n\n_No model brain configured; synthesis skipped._\n\n${body}`,
      cited,
      tried: targets,
    };
  }

  try {
    const markdown = await complete([
      { role: 'system', content: SYNTHESIS_PROMPT },
      { role: 'user', content: `Topic: ${topic}\n\nSOURCES:\n${snippets.join('\n\n')}` },
    ]);
    return { markdown, cited, tried: targets };
  } catch (err) {
    return {
      markdown: `Deep research synthesis failed: ${err?.message || err}`,
      cited,
      tried: targets,
    };
  }
}
