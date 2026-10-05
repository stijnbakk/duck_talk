/**
 * The acknowledgement's rules, without a phone, a Gemini session or a clock that
 * moves on its own: when it fires, what disarms it, and what counts as its echo.
 *
 *   npm test
 */

import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { Ack, PHRASES, isEcho, pick, slug } from './ack.ts';

test('fires once the pause has passed, not before', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const ack = new Ack(3000);
    const said: string[] = [];
    ack.arm((p) => (said.push(p), true));
    mock.timers.tick(2999);
    assert.deepEqual(said, []);
    mock.timers.tick(1);
    assert.equal(said.length, 1);
    assert.ok(PHRASES.includes(said[0] as (typeof PHRASES)[number]));
    assert.equal(ack.armed, false);
  } finally {
    mock.timers.reset();
  }
});

test('speech inside the pause disarms it, and the re-armed one waits a full pause again', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const ack = new Ack(3000);
    let fired = 0;
    ack.arm(() => (fired++, true));
    mock.timers.tick(2000);
    ack.disarm(); // a partial: the instruction is still being spoken
    mock.timers.tick(5000);
    assert.equal(fired, 0);
    ack.arm(() => (fired++, true)); // the joined final
    mock.timers.tick(2999);
    assert.equal(fired, 0);
    mock.timers.tick(1);
    assert.equal(fired, 1);
  } finally {
    mock.timers.reset();
  }
});

test('a moot acknowledgement says nothing and leaves no echo window open', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const ack = new Ack(1000);
    ack.arm(() => false); // the reply got there first
    mock.timers.tick(1000);
    assert.equal(ack.echo('Got it.'), false);
  } finally {
    mock.timers.reset();
  }
});

test('its own phrase heard back soon after is an echo; later, or anything longer, is a person', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const ack = new Ack(1000);
    assert.equal(ack.echo('Got it.'), false, 'nothing said yet');
    ack.arm(() => true);
    mock.timers.tick(1000);
    assert.equal(ack.echo('got'), true);
    assert.equal(ack.echo('Got it!'), true);
    assert.equal(ack.echo('Got it, and also rename the file.'), false);
    mock.timers.tick(3001);
    assert.equal(ack.echo('Got it.'), false);
  } finally {
    mock.timers.reset();
  }
});

test('echo matching ignores case and punctuation and takes prefixes', () => {
  assert.equal(isEcho('ON IT'), true);
  assert.equal(isEcho('Sure,'), true);
  assert.equal(isEcho('noted'), true);
  assert.equal(isEcho(''), false);
  assert.equal(isEcho('...'), false);
  assert.equal(isEcho('Notes app'), false);
  assert.equal(isEcho('What branch am I on?'), false);
});

test('never the same phrase twice in a row', () => {
  for (const last of PHRASES) {
    for (const r of [0, 0.5, 0.999999]) assert.notEqual(pick(last, () => r), last);
  }
});

test('every phrase has a clip name the app bundle can hold', () => {
  assert.equal(slug('Got it.'), 'ack-got-it');
  assert.equal(slug('Sure, on it.'), 'ack-sure-on-it');
  assert.equal(new Set(PHRASES.map(slug)).size, PHRASES.length);
});
