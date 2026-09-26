import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTPayload,
} from "jose";

export const PROJECT_ID = "clusterflick-com";
const KID = "test-key";

const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: KID, alg: "RS256" };

/** Stands in for Google's key set, holding only the key tokens are signed with. */
export const TEST_KEYS = createLocalJWKSet({ keys: [jwk] });

const now = () => Math.floor(Date.now() / 1000);

/** A token as Firebase would issue it; `claims` overrides any of them. */
export function signToken(claims: JWTPayload = {}, key = privateKey) {
  return new SignJWT({
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    aud: PROJECT_ID,
    sub: "user-1",
    iat: now() - 60,
    exp: now() + 3600,
    auth_time: now() - 60,
    email_verified: true,
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .sign(key);
}

export async function otherPrivateKey() {
  return (await generateKeyPair("RS256")).privateKey;
}
