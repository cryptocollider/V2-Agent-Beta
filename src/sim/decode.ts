import type { Hex32 } from "../collider/types.js";

export type DecodedThrowOutcome = {
  throw_id: Hex32;
  hole_type: number;
  endFrame: number;
  hole_i: number;
};

export type DecodedAssetDelta = {
  asset: Hex32;
  amount_delta: bigint;
};

export type DecodedGameResult = {
  per_throw: DecodedThrowOutcome[];
  per_asset_totals: DecodedAssetDelta[];
  snapshot_hashes: Hex32[];
  final_hash: Hex32;
  end_frame: number;
};

class BinReader {
  private view: DataView;
  private bytes: Uint8Array;
  private off = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  remaining(): number {
    return this.bytes.length - this.off;
  }

  offset(): number {
    return this.off;
  }

  readU8(): number {
    const v = this.view.getUint8(this.off);
    this.off += 1;
    return v;
  }

  readU16(): number {
    const v = this.view.getUint16(this.off, true);
    this.off += 2;
    return v;
  }

  readU32(): number {
    const v = this.view.getUint32(this.off, true);
    this.off += 4;
    return v;
  }

  readU64(): bigint {
    const lo = this.view.getUint32(this.off, true);
    const hi = this.view.getUint32(this.off + 4, true);
    this.off += 8;
    return (BigInt(hi) << 32n) | BigInt(lo);
  }

  readI128(): bigint {
    const b0 = BigInt(this.view.getUint32(this.off + 0, true));
    const b1 = BigInt(this.view.getUint32(this.off + 4, true));
    const b2 = BigInt(this.view.getUint32(this.off + 8, true));
    const b3 = BigInt(this.view.getUint32(this.off + 12, true));
    this.off += 16;

    let x =
      (b3 << 96n) |
      (b2 << 64n) |
      (b1 << 32n) |
      b0;

    // two's complement sign correction for 128-bit signed integer
    if (x & (1n << 127n)) {
      x -= 1n << 128n;
    }
    return x;
  }

  readFixedBytes(n: number): Uint8Array {
    const end = this.off + n;
    if (end > this.bytes.length) {
      throw new Error(`decode overflow: need ${n} bytes at ${this.off}, total ${this.bytes.length}`);
    }
    const out = this.bytes.subarray(this.off, end);
    this.off = end;
    return out;
  }

  readHex32(): Hex32 {
    return Buffer.from(this.readFixedBytes(32)).toString("hex");
  }

  readVecLen(): number {
    const len = this.readU64();
    if (len > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`vec length too large: ${len.toString()}`);
    }
    return Number(len);
  }
}

function readThrowOutcome(r: BinReader): DecodedThrowOutcome {
  return {
    throw_id: r.readHex32(),
    hole_type: r.readU16(),
    endFrame: r.readU32(),
    hole_i: r.readU16(),
  };
}

function readAssetDelta(r: BinReader): DecodedAssetDelta {
  return {
    asset: r.readHex32(),
    amount_delta: r.readI128(),
  };
}

export function decodeGameResult(bytes: Uint8Array): DecodedGameResult {
  const r = new BinReader(bytes);

  const perThrowLen = r.readVecLen();
  const per_throw: DecodedThrowOutcome[] = [];
  for (let i = 0; i < perThrowLen; i++) {
    per_throw.push(readThrowOutcome(r));
  }

  const perAssetLen = r.readVecLen();
  const per_asset_totals: DecodedAssetDelta[] = [];
  for (let i = 0; i < perAssetLen; i++) {
    per_asset_totals.push(readAssetDelta(r));
  }

  const snapLen = r.readVecLen();
  const snapshot_hashes: Hex32[] = [];
  for (let i = 0; i < snapLen; i++) {
    snapshot_hashes.push(r.readHex32());
  }

  const final_hash = r.readHex32();
  const end_frame = r.readU32();

  if (r.remaining() !== 0) {
    throw new Error(`decode trailing bytes: ${r.remaining()} at offset ${r.offset()}`);
  }

  return {
    per_throw,
    per_asset_totals,
    snapshot_hashes,
    final_hash,
    end_frame,
  };
}

export function findOutcomeByThrowId(
  result: DecodedGameResult,
  throwId: Hex32,
): DecodedThrowOutcome | null {
  return result.per_throw.find((o) => o.throw_id === throwId) ?? null;
}