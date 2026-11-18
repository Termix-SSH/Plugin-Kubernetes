import { describe, expect, it } from "vitest";
import {
  hostKeyRefusalReason,
  hostKeyRefusalText,
  isHostKeyRefusal,
} from "../../src/backend/host-key-refusal";

const UNVERIFIED =
  "This host's key is not trusted yet. Open a terminal to the host once to check and trust it.";
const CHANGED =
  "This host's key has changed. Open a terminal to the host to check the new key.";
const OLD = "Host denied (verification failed)";

describe("host key refusal", () => {
  it("knows core's messages and the old ssh2 one", () => {
    for (const message of [UNVERIFIED, CHANGED, OLD]) {
      expect(isHostKeyRefusal(message)).toBe(true);
    }
    expect(isHostKeyRefusal("connect ECONNREFUSED 10.0.0.1:22")).toBe(false);
    expect(
      isHostKeyRefusal("All configured authentication methods failed"),
    ).toBe(false);
  });

  it("tells a host with no saved key from a changed key", () => {
    expect(hostKeyRefusalReason(UNVERIFIED)).toBe("unverified");
    expect(hostKeyRefusalReason(CHANGED)).toBe("changed");
    expect(hostKeyRefusalReason(OLD)).toBe("changed");
  });

  it("passes core's words on and explains the old message", () => {
    expect(hostKeyRefusalText(UNVERIFIED)).toBe(UNVERIFIED);
    expect(hostKeyRefusalText(OLD)).toContain("open a Terminal connection");
  });
});
