/**
 * Who may open a socket. Whoever connects can switch Claude to `bypassPermissions`, so
 * the door matters more than it looks.
 *
 * Two optional locks, both off unless the environment turns them on, so a relay with
 * neither set behaves exactly as before:
 *
 * - `RELAY_TOKEN`: every socket, the `?data=1` one included, must carry `?token=` with
 *   that value. Compared in constant time, so the answer's timing says nothing about how
 *   much of a guess was right.
 * - `ALLOWED_ORIGINS`: a comma-separated list of browser Origins let in. Without it any
 *   handshake carrying an Origin is refused — browsers always send one, so a web page
 *   cannot drive Claude through ws://localhost. A client that embeds a web view (an
 *   Obsidian plugin: `app://obsidian.md` on desktop, `capacitor://localhost` on mobile)
 *   cannot drop its Origin, so it has to be named here. The native iOS app sends none.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

export interface Gate {
  token?: string;
  origins: Set<string>;
}

export function gateFromEnv(env: NodeJS.ProcessEnv = process.env): Gate {
  const token = env['RELAY_TOKEN']?.trim() || undefined;
  const origins = new Set(
    (env['ALLOWED_ORIGINS'] ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  );
  return { token, origins };
}

// Hashing both sides first gives equal-length buffers whatever was sent.
const digest = (s: string) => createHash('sha256').update(s).digest();

/** Why a handshake is refused, or undefined to let it in. */
export function refusal(gate: Gate, origin: string | undefined, url: string | undefined): string | undefined {
  if (origin && !gate.origins.has(origin)) return `Origin ${origin}`;
  if (gate.token) {
    const sent = new URL(url ?? '/', 'ws://x').searchParams.get('token') ?? '';
    if (!timingSafeEqual(digest(sent), digest(gate.token))) return 'a missing or wrong token';
  }
  return undefined;
}
