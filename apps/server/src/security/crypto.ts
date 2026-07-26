import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { RecoveryFile, RecoveryKit } from "@spendlens/contracts";
import { RecoveryFileSchema } from "@spendlens/contracts";
import argon2 from "argon2";

const ARGON2_PARAMETERS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_PARAMETERS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export async function createRecoveryKit(
  workspaceId: string,
  databaseKey: Buffer,
): Promise<RecoveryKit> {
  if (databaseKey.length !== 32) {
    throw new Error("Recovery can only wrap a 256-bit database key.");
  }

  const recoveryCode = encodeRecoveryCode(randomBytes(20));
  const salt = randomBytes(16);
  const wrappingKey = await deriveRecoveryKey(recoveryCode, salt);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", wrappingKey, iv);
  cipher.setAAD(Buffer.from(`SpendLens:${workspaceId}:1`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(databaseKey), cipher.final()]);
  const authTag = cipher.getAuthTag();
  wrappingKey.fill(0);

  return {
    recoveryCode,
    recoveryFile: {
      type: "spendlens-recovery-key",
      version: 1,
      workspaceId,
      createdAt: new Date().toISOString(),
      kdf: {
        algorithm: "argon2id",
        salt: salt.toString("base64url"),
        memoryCost: ARGON2_PARAMETERS.memoryCost,
        timeCost: ARGON2_PARAMETERS.timeCost,
        parallelism: ARGON2_PARAMETERS.parallelism,
        hashLength: 32,
      },
      wrap: {
        algorithm: "aes-256-gcm",
        iv: iv.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        authTag: authTag.toString("base64url"),
      },
    },
  };
}

export async function unwrapDatabaseKey(
  input: RecoveryFile,
  recoveryCode: string,
): Promise<Buffer> {
  const recoveryFile = RecoveryFileSchema.parse(input);
  const salt = Buffer.from(recoveryFile.kdf.salt, "base64url");
  const wrappingKey = await deriveRecoveryKey(normalizeRecoveryCode(recoveryCode), salt, {
    memoryCost: recoveryFile.kdf.memoryCost,
    timeCost: recoveryFile.kdf.timeCost,
    parallelism: recoveryFile.kdf.parallelism,
  });

  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      wrappingKey,
      Buffer.from(recoveryFile.wrap.iv, "base64url"),
    );
    decipher.setAAD(Buffer.from(`SpendLens:${recoveryFile.workspaceId}:1`, "utf8"));
    decipher.setAuthTag(Buffer.from(recoveryFile.wrap.authTag, "base64url"));
    const databaseKey = Buffer.concat([
      decipher.update(Buffer.from(recoveryFile.wrap.ciphertext, "base64url")),
      decipher.final(),
    ]);

    if (databaseKey.length !== 32) {
      databaseKey.fill(0);
      throw new Error("The recovery material did not contain a valid database key.");
    }

    return databaseKey;
  } catch {
    throw new Error("The recovery file or recovery code is incorrect.");
  } finally {
    wrappingKey.fill(0);
  }
}

async function deriveRecoveryKey(
  recoveryCode: string,
  salt: Buffer,
  parameters: {
    memoryCost: number;
    timeCost: number;
    parallelism: number;
  } = ARGON2_PARAMETERS,
): Promise<Buffer> {
  return argon2.hash(recoveryCode, {
    type: argon2.argon2id,
    memoryCost: parameters.memoryCost,
    timeCost: parameters.timeCost,
    parallelism: parameters.parallelism,
    hashLength: 32,
    salt,
    raw: true,
  });
}

function encodeRecoveryCode(value: Buffer): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let bits = 0;
  let bitCount = 0;
  let encoded = "";

  for (const byte of value) {
    bits = (bits << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      encoded += alphabet[(bits >>> (bitCount - 5)) & 31];
      bitCount -= 5;
    }
  }

  if (bitCount > 0) {
    encoded += alphabet[(bits << (5 - bitCount)) & 31];
  }

  return encoded.match(/.{1,4}/g)?.join("-") ?? encoded;
}

function normalizeRecoveryCode(value: string): string {
  return (
    value
      .trim()
      .toUpperCase()
      .replace(/[\s-]+/g, "")
      .match(/.{1,4}/g)
      ?.join("-") ?? ""
  );
}
