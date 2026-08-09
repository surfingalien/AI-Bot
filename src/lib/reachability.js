// Telling "the service refused us" apart from "we never reached the service".
//
// This distinction is worth code because getting it wrong costs hours. A
// network policy sitting in front of an allowlist answers 403 from somewhere
// that is not the destination, and it answers instantly. Read literally that
// looks like the API rejecting a credential, so the natural response is to
// regenerate keys and re-read the vendor's auth docs — for a request that never
// left the building.
//
// The tell is the pair: a refusal status arriving faster than a real round trip
// to that host could possibly complete.

const POLICY_STATUS = /\b(403|407)\b/;
const NETWORK_ERROR = /timeout|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET/i;

/**
 * @param {string} message the error as reported
 * @param {number} ms how long the attempt took
 * @param {string} host what we were trying to reach
 * @returns {{kind:'policy'|'network'|'service', message:string, advice:string|null}}
 */
export function diagnoseFailure(message, ms, host) {
  const text = String(message || '');

  if (POLICY_STATUS.test(text) && ms < 1000) {
    return {
      kind: 'policy',
      message: text,
      advice:
        `This looks like a network policy refusing ${host} before the request left your ` +
        'network — not the service rejecting your credentials. Allow the host, or run this ' +
        'where the deployment will actually live.',
    };
  }

  if (NETWORK_ERROR.test(text)) {
    return {
      kind: 'network',
      message: text,
      advice: `DNS or routing to ${host} is failing. Check egress from this machine.`,
    };
  }

  return { kind: 'service', message: text, advice: null };
}
