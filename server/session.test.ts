/**
 * Which ways of losing the ears the phone hears about.
 *
 *   npm test
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { earsRefusal } from './session.ts';

test('a spent billing cap reaches the phone', () => {
  const text = earsRefusal('Your project has exceeded its monthly spending cap. Please go to AI Studio');
  assert.match(text ?? '', /spending cap/);
  assert.match(text ?? '', /Typing still works/);
});

test('a refused key reaches the phone', () => {
  assert.match(earsRefusal('API key not valid') ?? '', /refused the key/);
});

test('a routine hang-up stays quiet', () => {
  assert.equal(earsRefusal('1000'), null);
  assert.equal(earsRefusal('Deadline expired before operation could complete.'), null);
});
