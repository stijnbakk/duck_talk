/**
 * `?mode=speech` without Gemini: fake ears that say what a test tells them to, a fake
 * voice that records what it was asked to read, and a clock that only moves when told.
 *
 *   npm test
 */

import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import type { EarsCallbacks } from './ears.ts';
import type { VoiceCallbacks } from './voice.ts';
import { SpeechSession, type SpeechParts } from './speech.ts';

type Event = { type: string; text?: string; partial?: boolean };

function rig(pauseMs = 3000) {
  const events: Event[] = [];
  const pcm: Buffer[] = [];
  const said: string[] = [];
  const voice = { interrupts: 0, finishes: 0, heard: [] as number[], closed: false };
  let ears: EarsCallbacks | null = null;
  let earsClosed = 0;
  let voiceCb: VoiceCallbacks | null = null;
  const parts: SpeechParts = {
    ears: async (cb) => {
      ears = cb;
      return { send() {}, seal() {}, close() { earsClosed++; } };
    },
    voice: (cb) => {
      voiceCb = cb;
      return {
        say: (t) => { said.push(t); cb.onPcm(Buffer.alloc(48)); },
        finish: () => { voice.finishes++; },
        heard: (ms) => { voice.heard.push(ms); },
        interrupt: () => { voice.interrupts++; },
        close: () => { voice.closed = true; },
      };
    },
  };
  const session = new SpeechSession({ pcm: (b) => pcm.push(b), event: (e) => events.push(e) }, parts, { pauseMs });
  return {
    session, events, pcm, said, voice,
    get ears() { return ears!; },
    get earsClosed() { return earsClosed; },
    /** The voice ran dry: what it read has all been heard. */
    drained: () => voiceCb!.onDone!(),
  };
}

/** Time passing with the mic streaming, as a phone's does — so the two-second gap
 *  rule never fires unless a test means it to. */
function stream(r: ReturnType<typeof rig>, ms: number) {
  for (let left = ms; left > 0; left -= Math.min(500, left)) {
    mock.timers.tick(Math.min(500, left));
    r.session.send(Buffer.alloc(640));
  }
}

/** Lets the ears' async open settle. */
const settle = () => new Promise<void>((r) => setImmediate(r));

test('a finished utterance is held for the pause, then said to be finished', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const r = rig(3000);
    r.session.send(Buffer.alloc(640));
    await settle();
    r.ears.onPartial('what is', false);
    r.ears.onFinal('What is next?', null);
    assert.deepEqual(r.events.filter((e) => e.partial === false), []);
    stream(r, 2999);
    assert.deepEqual(r.events.filter((e) => e.partial === false), []);
    stream(r, 1);
    assert.deepEqual(r.events.at(-1), { type: 'user', text: 'What is next?', partial: false });
    r.session.close();
  } finally {
    mock.timers.reset();
  }
});

test('speaking again inside the pause replaces the held utterance with the joined one', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const r = rig(3000);
    r.session.send(Buffer.alloc(640));
    await settle();
    r.ears.onFinal('Fix the bug.', null);
    stream(r, 2000);
    r.ears.onPartial('Fix the bug in the', true);
    stream(r, 2000); // past the first final's window: it must not go out on its own
    r.ears.onFinal('Fix the bug in the parser.', null);
    stream(r, 3000);
    const finals = r.events.filter((e) => e.partial === false).map((e) => e.text);
    assert.deepEqual(finals, ['Fix the bug in the parser.']);
    r.session.close();
  } finally {
    mock.timers.reset();
  }
});

test('a partial with no final behind it does not keep the held utterance forever', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const r = rig(3000);
    r.session.send(Buffer.alloc(640));
    await settle();
    r.ears.onFinal('Ship it.', null);
    r.ears.onPartial('uh', true);
    // The mic keeps streaming, so the gap rule never fires.
    stream(r, 9000);
    assert.deepEqual(r.events.filter((e) => e.partial === false), []);
    stream(r, 1000);
    assert.deepEqual(r.events.filter((e) => e.partial === false).map((e) => e.text), ['Ship it.']);
    r.session.close();
  } finally {
    mock.timers.reset();
  }
});

test('say reads, once per stretch: turn_start, audio, turn_end when heard', () => {
  const r = rig();
  r.session.frame({ type: 'say', text: 'First reply.' });
  r.session.frame({ type: 'say', text: 'And a second one.' });
  r.session.frame({ type: 'say', text: '   ' });
  assert.deepEqual(r.said, ['First reply.', 'And a second one.']);
  assert.equal(r.pcm.length, 2);
  assert.deepEqual(r.events, [{ type: 'turn_start' }]);
  r.session.frame({ type: 'played', ms: 900 });
  assert.deepEqual(r.voice.heard, [900]);
  r.drained();
  assert.deepEqual(r.events, [{ type: 'turn_start' }, { type: 'turn_end' }]);
  // Played reports between stretches belong to nothing.
  r.session.frame({ type: 'played', ms: 100 });
  assert.deepEqual(r.voice.heard, [900]);
  r.session.close();
});

test('the user talking over the voice stops it', async () => {
  const r = rig();
  r.session.send(Buffer.alloc(640));
  await settle();
  r.session.frame({ type: 'say', text: 'A long answer.' });
  r.ears.onPartial('wait', false);
  assert.equal(r.voice.interrupts, 1);
  assert.deepEqual(r.events.map((e) => e.type), ['turn_start', 'interrupted', 'user']);
  // A second partial of the same utterance has nothing left to stop.
  r.ears.onPartial('wait a', false);
  assert.equal(r.voice.interrupts, 1);
  // And the voice draining later does not end a turn that was already closed.
  r.drained();
  assert.equal(r.events.filter((e) => e.type === 'turn_end').length, 0);
  r.session.close();
});

test('stop stops reading; nothing to stop is nothing said', () => {
  const r = rig();
  r.session.frame({ type: 'stop' });
  assert.deepEqual(r.events, []);
  r.session.frame({ type: 'say', text: 'Hello.' });
  r.session.frame({ type: 'stop' });
  assert.deepEqual(r.events.map((e) => e.type), ['turn_start', 'interrupted']);
  assert.equal(r.voice.interrupts, 1);
  r.session.close();
});

test('two seconds without audio closes the ears and lets a held utterance go', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const r = rig(5000);
    r.session.send(Buffer.alloc(640));
    await settle();
    r.ears.onFinal('Goodbye.', null);
    mock.timers.tick(2000);
    assert.equal(r.earsClosed, 1);
    assert.deepEqual(r.events.at(-1), { type: 'user', text: 'Goodbye.', partial: false });
    r.session.close();
    assert.equal(r.voice.closed, true);
  } finally {
    mock.timers.reset();
  }
});
