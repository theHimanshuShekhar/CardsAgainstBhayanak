import bcrypt from "bcryptjs";

export async function hashPassphrase(passphrase: string): Promise<string> {
  return bcrypt.hash(passphrase, 12);
}

export async function verifyPassphrase(
  passphrase: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(passphrase, hash);
}
