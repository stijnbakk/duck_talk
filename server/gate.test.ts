/**
 * The door's rules: off by default, a token when one is set, and Origins only by name.
 *
 *   npm test
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gateFromEnv, refusal } from './gate.ts';

test('with nothing set, native clients get in and browsers do not', () => {
  const gate = gateFromEnv({});
  assert.equal(refusal(gate, undefined, '/?mode=direct'), undefined);
  assert.match(refusal(gate, 'https://evil.example', '/') ?? '', /Origin/);
});

test('a token must be sent, and sent exactly', () => {
  const gate = gateFromEnv({ RELAY_TOKEN: 'abc123' });
  assert.equal(refusal(gate, undefined, '/?token=abc123&mode=direct'), undefined);
  assert.equal(refusal(gate, undefined, '/?data=1&token=abc123'), undefined);
  assert.match(refusal(gate, undefined, '/?mode=direct') ?? '', /token/);
  assert.match(refusal(gate, undefined, '/?token=abc12') ?? '', /token/);
  assert.match(refusal(gate, undefined, '/?token=abc1234') ?? '', /token/);
});

test('listed Origins get in, unlisted ones still do not', () => {
  const gate = gateFromEnv({ ALLOWED_ORIGINS: ' app://obsidian.md , capacitor://localhost,' });
  assert.equal(refusal(gate, 'app://obsidian.md', '/'), undefined);
  assert.equal(refusal(gate, 'capacitor://localhost', '/'), undefined);
  assert.match(refusal(gate, 'http://localhost', '/') ?? '', /Origin/);
});

test('an allowed Origin still needs the token', () => {
  const gate = gateFromEnv({ ALLOWED_ORIGINS: 'app://obsidian.md', RELAY_TOKEN: 't' });
  assert.match(refusal(gate, 'app://obsidian.md', '/') ?? '', /token/);
  assert.equal(refusal(gate, 'app://obsidian.md', '/?token=t'), undefined);
});
