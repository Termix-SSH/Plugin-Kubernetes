// How a refused SSH host key shows up in an error message. Core names the
// reason since 26.11.2 ("not trusted yet" or "has changed"); older cores only
// pass on ssh2's "verification failed".

const REFUSED =
  /verification failed|host's key (is not trusted yet|has changed)/i;
const UNVERIFIED = /host's key is not trusted yet/i;
const NAMED = /host's key/i;

const OLD_TEXT =
  "SSH host key has changed. For security, please open a Terminal connection to this host first to verify and accept the new key fingerprint.";

export function isHostKeyRefusal(message: string): boolean {
  return REFUSED.test(message);
}

/** "unverified": no key saved for the host yet. "changed": it differs. */
export function hostKeyRefusalReason(
  message: string,
): "unverified" | "changed" {
  return UNVERIFIED.test(message) ? "unverified" : "changed";
}

/** What to tell the user: core's own words when it gave them. */
export function hostKeyRefusalText(message: string): string {
  return NAMED.test(message) ? message : OLD_TEXT;
}
