/**
 * `?mode=speech`: the relay as a pair of ears and a voice, with no Claude behind them.
 *
 * For a client that already has an agent of its own to talk to — Margin's "call" on a
 * Claude Code pane, where the agent is a terminal session on the Mac and the app is
 * what carries words between the two. The client streams the microphone up and gets
 * back what was said, one finished utterance at a time; it sends `say` with whatever
 * it wants read out and gets the audio back. What to do with either is its business.
 *
 *   ↑ binary  raw PCM Int16 LE, 16 kHz, mono          (mic)
 *   ↑ text    {"type":"say","text"}                   read this out, after anything already queued
 *             {"type":"played","ms"}                  reply audio its speaker has played
 *             {"type":"stop"}                         stop reading, drop the queue
 *   ↓ binary  raw PCM Int16 LE, 24 kHz, mono          (the voice)
 *   ↓ text    {"type":"user","text","partial"}        the utterance as heard; `partial: false` is the finished one
 *             {"type":"turn_start"}                   reading started
 *             {"type":"turn_end"}                     what was said has been heard to the end
 *             {"type":"interrupted"}                  reading stopped: the user talked over it, or `stop`
 *             {"type":"error","text"}
 *
 * The pause rule is the voice session's, and so is what it costs. There a final runs
 * Claude at once and a continuation takes the turn back (`retract`). Here the final
 * goes to someone who cannot be asked to forget it — a message sent to an agent stays
 * sent — so it is *held* instead, for the same window the ears use to decide whether
 * the next words continue it. Only once that window has passed with nobody speaking is
 * it said to be finished, and a continuation inside it simply replaces it. The ears
 * settle that question on the first partial after a pause, so holding for exactly
 * their window and no longer agrees with them every time.
 *
 * Barge-in is the other half: any speech heard while the voice is reading stops it.
 * Echo of the voice itself is the client's echo cancellation's to remove — the same as
 * in every other mode.
 *
 * Audio still buys audio: the ears open on the first buffer and close when the buffers
 * stop for two seconds, exactly as in session.ts.
 */

import { GoogleGenAI } from '@google/genai';
import { earsRefusal, type Phone } from './session.ts';
import { JOIN_MS, openEars, type Ears, type EarsCallbacks } from './ears.ts';
import { openVoice, type Voice, type VoiceCallbacks } from './voice.ts';

/** How the ears and the voice are made — the real ones, or stand-ins in a test. */
export interface SpeechParts {
  ears(cb: EarsCallbacks, joinMs: number): Promise<Ears>;
  voice(cb: VoiceCallbacks): Voice;
}

export function geminiParts(ai: GoogleGenAI, sttModel: string, voiceModel: string): SpeechParts {
  return {
    ears: (cb, joinMs) => openEars(ai, sttModel, cb, [], joinMs),
    voice: (cb) => openVoice(ai, voiceModel, cb),
  };
}

// The same as session.ts: a phone that streams silence too is gone, not quiet, after this.
const AUDIO_GAP_MS = 2_000;

// A partial with no final behind it — a cough the ears thought better of — must not keep
// a held utterance forever.
const STRAY_MS = 10_000;

export class SpeechSession {
  private ears: Ears | null = null;
  private opening = false;
  private backlog: Buffer[] = [];
  private gap: ReturnType<typeof setTimeout> | null = null;
  private readonly voice: Voice;
  /** The voice has been given something and it has not all been heard yet. */
  private reading = false;
  /** A finished utterance waiting out the pause window, and its timer. */
  private held: string | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly pauseMs: number;
  private readonly phone: Phone;
  private readonly parts: SpeechParts;
  private readonly log: (m: string) => void;

  constructor(phone: Phone, parts: SpeechParts, opts: { pauseMs?: number }, log: (m: string) => void = () => {}) {
    this.phone = phone;
    this.parts = parts;
    this.log = log;
    this.pauseMs = opts.pauseMs ?? JOIN_MS;
    this.voice = parts.voice({
      log,
      onPcm: (pcm) => this.phone.pcm(pcm),
      onDone: () => {
        if (!this.reading) return;
        this.reading = false;
        this.phone.event({ type: 'turn_end' });
      },
    });
  }

  // --- Phone → session -------------------------------------------------------

  send(pcm: Buffer): void {
    if (this.closed) return;
    this.hearing();
    if (this.ears) return this.ears.send(pcm);
    this.backlog.push(pcm);
    void this.listen();
  }

  frame(msg: { type?: string; text?: string; ms?: number }): void {
    if (this.closed) return;
    if (msg.type === 'say' && typeof msg.text === 'string') this.say(msg.text);
    else if (msg.type === 'played' && typeof msg.ms === 'number') { if (this.reading) this.voice.heard(msg.ms); }
    else if (msg.type === 'stop') this.interrupt('stop frame');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.gap) clearTimeout(this.gap);
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.ears?.close();
    this.voice.close();
  }

  // --- Speaking --------------------------------------------------------------

  /** Queued behind whatever is already being read; one `turn_start` per stretch of reading. */
  private say(text: string): void {
    const said = text.trim();
    if (!said) return;
    if (!this.reading) {
      this.reading = true;
      this.phone.event({ type: 'turn_start' });
    }
    this.voice.say(said);
    // Each `say` is whole, so its tail is a pause: flushed at once rather than waiting
    // for a sentence that is not coming. The voice keeps reading anything queued after.
    this.voice.finish();
  }

  private interrupt(why: string): void {
    if (!this.reading) return;
    this.log(`interrupted: ${why}`);
    this.reading = false;
    this.voice.interrupt();
    this.phone.event({ type: 'interrupted' });
  }

  // --- Hearing ---------------------------------------------------------------

  private async listen(): Promise<void> {
    if (this.ears || this.opening || this.closed) return;
    this.opening = true;
    try {
      const ears = await this.parts.ears({
        log: this.log,
        onPartial: (text) => {
          // Speaking again inside the window: the held utterance is not finished, and
          // the final this partial leads to replaces it. Should that final never come,
          // what was held still goes, later.
          if (this.held) this.hold(this.held, STRAY_MS);
          this.interrupt('partial while reading');
          this.phone.event({ type: 'user', text, partial: true });
        },
        onFinal: (text) => {
          // Shown as heard straight away, so the screen keeps up; said to be finished
          // only once the pause has passed — see the top of this file.
          this.phone.event({ type: 'user', text, partial: true });
          this.hold(text);
        },
        onClosed: (reason) => {
          if (this.closed) return;
          this.ears = null;
          const refusal = earsRefusal(reason);
          if (refusal) this.phone.event({ type: 'error', text: refusal });
        },
      }, this.pauseMs);
      if (this.closed) return void ears.close();
      this.ears = ears;
      this.backlog.splice(0).forEach((pcm) => ears.send(pcm));
    } catch (e) {
      this.log(`ears failed: ${e}`);
      this.phone.event({ type: 'error', text: `could not start listening: ${e}` });
    } finally {
      this.opening = false;
    }
  }

  private hold(text: string, ms = this.pauseMs): void {
    this.unhold();
    this.held = text;
    this.holdTimer = setTimeout(() => this.release(), ms);
  }

  private unhold(): void {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }

  private release(): void {
    this.holdTimer = null;
    const text = this.held;
    this.held = null;
    if (!text || this.closed) return;
    this.log(`heard: ${text}`);
    this.phone.event({ type: 'user', text, partial: false });
  }

  /** The two-second rule from session.ts: no buffers means no ears. A held utterance
   *  is let go at once — nobody is going to continue it. */
  private hearing(): void {
    if (this.gap) clearTimeout(this.gap);
    this.gap = setTimeout(() => {
      this.log(`no audio for ${(AUDIO_GAP_MS / 1000).toFixed(1)}s`);
      this.ears?.close();
      this.ears = null;
      if (this.held) { this.unhold(); this.release(); }
    }, AUDIO_GAP_MS);
  }
}
