/**
 * A local stand-in for Google's signing keys: an RS256 key pair, its JWKS served in place of
 * `https://www.googleapis.com/oauth2/v3/certs` (global `fetch` stubbed), and an id-token minter.
 */

import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose";
import { vi } from "vitest";

const GOOGLE_CERTS = "https://www.googleapis.com/oauth2/v3/certs";
const KID = "test-kid";

export async function stubGoogleJwks() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: KID, alg: "RS256", use: "sig" };
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === GOOGLE_CERTS)
      return new Response(JSON.stringify({ keys: [jwk] }), {
        headers: { "content-type": "application/json" },
      });
    return realFetch(input, init);
  });

  /** A Google-shaped id token; `claims` override the defaults, `expiresIn` is a jose time span. */
  const mint = (claims: JWTPayload & Record<string, unknown>, expiresIn = "10m") =>
    new SignJWT({
      iss: "https://accounts.google.com",
      sub: "google-sub-1",
      email: "ada@example.com",
      email_verified: true,
      name: "Ada Lovelace",
      picture: "https://example.com/ada.png",
      ...claims,
    })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuedAt()
      .setExpirationTime(expiresIn)
      .sign(privateKey);

  return { mint };
}
