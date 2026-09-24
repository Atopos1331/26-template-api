import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { PlanError } from "../domain/plans.js";

export type DiscoverabilityCursorPayload = {
  owner: string;
  sectionId: string;
  name: string;
  recordId: string;
  issuedAt: number;
  exp: number;
};

function keyBytes(value: string) {
  return createHash("sha256").update(value).digest();
}

export function encodeDiscoverabilityCursor(
  payload: DiscoverabilityCursorPayload,
  key: string,
) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(key), iv);
  const body = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  const encrypted = Buffer.concat([iv, cipher.getAuthTag(), body]).toString(
    "base64url",
  );
  const signature = createHmac("sha256", key)
    .update(encrypted)
    .digest("base64url");
  return `${encrypted}.${signature}`;
}

export function decodeDiscoverabilityCursor(
  value: string,
  owner: string,
  sectionId: string,
  key: string,
  ttlSeconds: number,
  now: number,
): DiscoverabilityCursorPayload {
  try {
    if (value.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(value))
      throw new Error("shape");
    const [body, signature, extra] = value.split(".");
    if (!body || !signature || extra) throw new Error("shape");
    const expected = createHmac("sha256", key).update(body).digest();
    const provided = Buffer.from(signature, "base64url");
    if (
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)
    )
      throw new Error("signature");
    const packed = Buffer.from(body, "base64url");
    if (packed.length < 28) throw new Error("short cursor");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      keyBytes(key),
      packed.subarray(0, 12),
    );
    decipher.setAuthTag(packed.subarray(12, 28));
    const payload = JSON.parse(
      Buffer.concat([
        decipher.update(packed.subarray(28)),
        decipher.final(),
      ]).toString("utf8"),
    ) as DiscoverabilityCursorPayload;
    if (
      payload.owner !== owner ||
      payload.sectionId !== sectionId ||
      typeof payload.name !== "string" ||
      typeof payload.recordId !== "string" ||
      !payload.name ||
      !payload.recordId ||
      !Number.isSafeInteger(payload.issuedAt) ||
      !Number.isSafeInteger(payload.exp) ||
      payload.issuedAt > now ||
      payload.exp - payload.issuedAt > ttlSeconds * 1000 ||
      payload.exp <= now
    )
      throw new Error("claims");
    return payload;
  } catch {
    throw new PlanError("invalid_request", 400, "Invalid cursor", {
      cursor: "is invalid or expired",
    });
  }
}
