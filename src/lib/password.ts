// Single place that pins the password hashing algorithm (argon2id).
const ALGORITHM = "argon2id" as const;

export function hashPassword(plain: string): Promise<string> {
  return Bun.password.hash(plain, ALGORITHM);
}

/** Verify a plaintext against a stored hash (algorithm auto-detected from the hash prefix). */
export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return Bun.password.verify(plain, hash);
}

/**
 * A real argon2id hash of a fixed string, used to equalize login timing when the username
 * does not exist (run a verify against this so present/absent users take ~the same time —
 * closes the user-enumeration timing oracle).
 */
export const DUMMY_PASSWORD_HASH = await Bun.password.hash("celeste-hyper::absent-user::dummy", ALGORITHM);
