import { createHash, randomBytes } from "node:crypto";

export type ContentAddressRef = {
  sha256Hex: string;
  cid: string;
  ipfsUri: string;
  bytes: number;
};

type JsonLike =
  | null
  | boolean
  | number
  | string
  | JsonLike[]
  | { [key: string]: JsonLike };

function normalizeJson(value: unknown): JsonLike {
  if (
    value == null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value as JsonLike;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeJson(entry));
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, normalizeJson(entry)] as const);
    return Object.fromEntries(entries);
  }
  return String(value);
}

export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

function base32LowerNoPad(bytes: Uint8Array): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let out = "";
  let buffer = 0;
  let bits = 0;

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    out += alphabet[(buffer << (5 - bits)) & 31];
  }

  return out;
}

export function buildContentAddressRefFromBytes(bytes: Uint8Array): ContentAddressRef {
  const sha256 = createHash("sha256").update(bytes).digest();
  const multihash = Buffer.concat([Buffer.from([0x12, 0x20]), sha256]);
  const cidBytes = Buffer.concat([Buffer.from([0x01, 0x55]), multihash]);
  const cid = `b${base32LowerNoPad(cidBytes)}`;

  return {
    sha256Hex: sha256.toString("hex"),
    cid,
    ipfsUri: `ipfs://${cid}`,
    bytes: bytes.length,
  };
}

export function buildContentAddressRefFromJson(value: unknown): ContentAddressRef & {
  canonicalJson: string;
} {
  const canonicalJson = canonicalJsonStringify(value);
  const bytes = Buffer.from(canonicalJson, "utf8");
  return {
    canonicalJson,
    ...buildContentAddressRefFromBytes(bytes),
  };
}

export function makeCommitSaltHex(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}
