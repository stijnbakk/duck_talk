/**
 * "Got it" — said the moment a spoken instruction is committed, not when Claude answers.
 *
 * A long dictation can take Claude many seconds to answer, and until the first word of
 * the reply comes back there is nothing to say the instruction landed. So once the turn
 * is committed the phone says one of a handful of short phrases on its own.
 *
 * Committed means the pause window has passed with no more speech: the same window the
 * ears use to decide that speech resuming is the *rest* of the instruction rather than
 * a new one (see `joinMs` in ears.ts). Inside it the turn can still be taken back — a
 * retract — so an acknowledgement there would talk over someone mid-thought. After it,
 * anything said is a new utterance, so the acknowledgement can never be heard as
 * cutting a sentence off.
 *
 * Nothing is synthesised per turn. The phrases are recorded once, in Claude's own voice,
 * into the app bundle (run this file with `--write`), and this side only says *which*
 * one — so the acknowledgement costs a socket frame and plays in milliseconds.
 *
 * It is not a reply: it never touches the voice queue, the reply's played-ms count or
 * the turn's `said`, and the phone plays it on its own player node, so the real answer
 * starts the moment it arrives. And it is skipped when the reply got there first: the
 * reply is acknowledgement enough.
 *
 *   node server/ack.ts --write      record the phrases into app/DuckTalk/Resources
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';
import { wav } from './clips.ts';
import { openVoice } from './voice.ts';

/** What the phone may say. Each has a clip in the app named by `slug`. Short on
 *  purpose — the point is the instant, and a sentence would be a reply. */
export const PHRASES = ['Got it.', 'On it.', 'Noted.', 'Understood.', 'Sure, on it.'] as const;

/** The clip a phrase lives in, without extension: `ack-got-it`. */
export function slug(phrase: string): string {
  return `ack-${normal(phrase).replace(/ /g, '-')}`;
}

/** A phrase at random, never the one just said — "Got it. … Got it." sounds canned. */
export function pick(last: string | null, random: () => number = Math.random): string {
  const choices = PHRASES.filter((p) => p !== last);
  return choices[Math.floor(random() * choices.length) % choices.length]!;
}

/** Lowercase letters and single spaces — punctuation and case are the transcriber's. */
function normal(text: string): string {
  return text.toLowerCase().replace(/[^a-z]+/g, ' ').trim();
}

/**
 * The phone's own acknowledgement, heard back through the microphone.
 *
 * Echo cancellation should keep it out, as it keeps the reply out; this is what holds
 * if it does not. A partial is the phrase so far ("got"), so a prefix of any phrase
 * counts. Anything longer than a phrase is a person, and goes through.
 */
export function isEcho(text: string): boolean {
  const n = normal(text);
  return n.length > 0 && PHRASES.some((p) => normal(p).startsWith(n));
}

// How long after the acknowledgement went out a transcript of it can still arrive: the
// clip is under a second, and a first partial lags speech by up to ~1.8s (ears.ts).
const ECHO_MS = 3_000;

/**
 * One connection's acknowledgement: armed when a spoken instruction is committed to
 * Claude, disarmed by anything that makes it moot, fired once the pause has passed.
 */
export class Ack {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private last: string | null = null;
  private saidAt = 0;

  /** The pause window, in ms — the same number the ears join on. */
  private readonly pauseMs: number;
  private readonly now: () => number;

  constructor(pauseMs: number, now: () => number = Date.now) {
    this.pauseMs = pauseMs;
    this.now = now;
  }

  /** A spoken instruction went to Claude. `fire` runs after the pause unless disarmed
   *  first, and returns the phrase it was handed or null to say nothing after all. */
  arm(fire: (phrase: string) => boolean): void {
    this.disarm();
    this.timer = setTimeout(() => {
      this.timer = null;
      const phrase = pick(this.last);
      if (!fire(phrase)) return;
      this.last = phrase;
      this.saidAt = this.now();
    }, this.pauseMs);
  }

  /** Speech resumed, the turn ended, or the reply is already playing. */
  disarm(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  get armed(): boolean {
    return this.timer !== null;
  }

  /** A transcript that is only our own acknowledgement coming back in. */
  echo(text: string): boolean {
    return this.saidAt > 0 && this.now() - this.saidAt <= ECHO_MS && isEcho(text);
  }
}

// --- CLI: record the phrases ------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--write')) {
    console.error('usage: node server/ack.ts --write   (needs GEMINI_API_KEY; writes app/DuckTalk/Resources/ack-*.wav)');
    process.exit(1);
  }
  const ai = new GoogleGenAI({ apiKey: process.env['GEMINI_API_KEY'] });
  const model = process.env['VOICE_MODEL'] ?? 'gemini-3.1-flash-tts-preview';
  for (const phrase of PHRASES) {
    // The reply's own voice and style prompt, so the acknowledgement and the answer
    // that follows it sound like one speaker.
    const pcm = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const voice = openVoice(ai, model, {
        log: console.log,
        onPcm: (b) => chunks.push(b),
        onDone: () => { voice.close(); resolve(Buffer.concat(chunks)); },
      });
      voice.say(phrase);
      voice.finish();
      setTimeout(() => reject(new Error(`timed out on ${phrase}`)), 30_000);
    });
    const clip = trim(pcm);
    const out = `app/DuckTalk/Resources/${slug(phrase)}.wav`;
    writeFileSync(out, wav(clip, 24_000));
    console.log(`${phrase.padEnd(14)} ${(clip.length / 48).toFixed(0)}ms → ${out}`);
  }
  process.exit(0);
}

/** The model's lead-in and tail silence off, so "instant" is not a quarter second late. */
function trim(pcm: Buffer): Buffer {
  const loud = (i: number) => Math.abs(pcm.readInt16LE(i)) > 500;
  let from = 0;
  let to = pcm.length - 2;
  while (from < to && !loud(from)) from += 2;
  while (to > from && !loud(to)) to -= 2;
  // A breath either side, so the onset and the decay are not clipped: 20ms and 120ms.
  return pcm.subarray(Math.max(0, from - 20 * 48), Math.min(pcm.length, to + 120 * 48));
}
