"""The waiting pad, synthesized — run from the repo root, writes the app's copy.

The sound the app loops while a reply is owed and no audio for it has arrived: a
low, quiet synthesizer pad that breathes once every sixteen seconds. The sound of
the app listening, not of it alerting — no onset anywhere in it, nothing that
repeats faster than a slow breath, and it sits far enough under a voice to be
talked over without a thought. Like the app icon, the asset is generated and never
edited by hand — every quality of the sound is a number below, so "lower",
"quieter" or "slower" is an edit here and a re-run, not a session in an audio
editor.

The pad is an open fifth on C3 (C3 G3 C4), each note two voices detuned an eighth
of a hertz apart so it shimmers instead of standing still. Each voice is a handful
of harmonics rolled off by a gentle low-pass, which is what keeps it warm and
also what lets a phone speaker play it at all: the fundamentals sit below what that
speaker reproduces, and the second and third harmonics are where it is heard.

Seamlessness is arithmetic, not luck: every frequency is snapped to whole cycles
per loop, and the breath — the swell in level and the brightening that rides it —
is one cosine per loop, so the end of the file is exactly the start of it.

    python3 scripts/filler-sound.py
"""

import math
import struct
import wave

RATE = 24_000  # the speaker format AudioPipe already plays
DUR = 16  # one breath per loop
N = RATE * DUR
OUT = "app/DuckTalk/Resources/pad.wav"

# Peak of the file. AudioPipe plays it at full volume, adding no gain, so this
# is the level. A sustained tone is heard by its average, not its peak; the RMS
# the run prints is the number to compare against a voice.
PEAK_DBFS = -22

NOTES = [(130.81, 1.0), (196.0, 0.6), (261.63, 0.35)]  # C3 G3 C4: root, fifth, octave
DETUNE = 0.125  # Hz between the two voices of a note — one slow beat per 8 s
HARMONICS = 6
CUTOFF = 600.0  # Hz, the low-pass at the bottom of the breath …
OPEN = 900.0  # … and at its top: brighter as it swells, like breath through a filter
FLOOR = 0.45  # level at the bottom of the breath, relative to the top: it never stops


def snap(f: float) -> float:
    """The nearest frequency that completes whole cycles in the loop."""
    return round(f * DUR) / DUR


def lowpass(f: float, fc: float) -> float:
    """Gain of a 2-pole low-pass at f: flat below fc, -12 dB per octave above."""
    return 1 / math.sqrt(1 + (f / fc) ** 4)


out = [0.0] * N
for i in range(N):
    t = i / RATE
    # 0 at the start of the loop, 1 halfway: the loop begins at the bottom of the
    # breath, so starting it fresh is as soft as the fade the player adds.
    breath = 0.5 - 0.5 * math.cos(2 * math.pi * t / DUR)
    fc = CUTOFF + (OPEN - CUTOFF) * breath
    s = 0.0
    for note, gain in NOTES:
        for f0 in (note - DETUNE / 2, note + DETUNE / 2):
            for k in range(1, HARMONICS + 1):
                f = snap(f0 * k)
                s += gain / k * lowpass(f, fc) * math.sin(2 * math.pi * f * t + k)
    out[i] = s * (FLOOR + (1 - FLOOR) * breath)

peak = max(abs(s) for s in out)
scale = 10 ** (PEAK_DBFS / 20) / peak
samples = [s * scale for s in out]
rms = math.sqrt(sum(s * s for s in samples) / N)
with wave.open(OUT, "w") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(RATE)
    w.writeframes(b"".join(struct.pack("<h", round(s * 32767)) for s in samples))
print(f"{OUT}  {DUR}s, peak {PEAK_DBFS} dBFS, RMS {20 * math.log10(rms):.1f} dBFS")
