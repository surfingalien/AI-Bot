import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText } from '../src/lib/htmlText.js';

test('extracts the title and drops markup', () => {
  const { title, text } = htmlToText(
    '<html><head><title>  Quarterly  Report </title></head><body><h1>Revenue</h1><p>Up 12%.</p></body></html>',
  );
  assert.equal(title, 'Quarterly Report');
  assert.match(text, /Revenue Up 12%\./);
  assert.doesNotMatch(text, /</);
});

test('removes script, style, noscript and svg payloads', () => {
  const { text } = htmlToText(
    '<body>keep<script>var secret=1;</script><style>.a{color:red}</style>' +
      '<noscript>enable js</noscript><svg><path d="M0"/></svg>me</body>',
  );
  assert.equal(text, 'keep me');
});

test('decodes named, decimal and hex entities', () => {
  const { text } = htmlToText('<p>AT&amp;T &lt;3 &#65; &#x42;&nbsp;C</p>');
  assert.equal(text, 'AT&T <3 A B C');
});

test('block boundaries do not fuse adjacent words', () => {
  const { text } = htmlToText('<li>alpha</li><li>beta</li>');
  assert.equal(text, 'alpha beta');
});

test('tolerates empty and non-string input', () => {
  assert.deepEqual(htmlToText(null), { title: '', text: '' });
  assert.deepEqual(htmlToText(undefined), { title: '', text: '' });
});
