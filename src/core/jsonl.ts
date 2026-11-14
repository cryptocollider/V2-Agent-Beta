import { open } from "node:fs/promises";

export type JsonlTailPage<T> = {
  rows: T[];
  fileBytes: number;
  scannedBytes: number;
  truncated: boolean;
};

export async function readJsonlTail<T = unknown>(
  file: string,
  limit = 500,
  maxScanBytes = 64 * 1024 * 1024,
): Promise<JsonlTailPage<T>> {
  const boundedLimit = Math.max(1, Math.min(10_000, Math.floor(limit)));
  let handle;
  try {
    handle = await open(file, "r");
  } catch {
    return { rows: [], fileBytes: 0, scannedBytes: 0, truncated: false };
  }

  try {
    const info = await handle.stat();
    const fileBytes = info.size;
    const blockBytes = 256 * 1024;
    let position = fileBytes;
    let scannedBytes = 0;
    let newlineCount = 0;
    const reverseChunks: Buffer[] = [];

    while (position > 0 && scannedBytes < maxScanBytes) {
      const size = Math.min(blockBytes, position, maxScanBytes - scannedBytes);
      position -= size;
      const buffer = Buffer.allocUnsafe(size);
      const read = await handle.read(buffer, 0, size, position);
      const chunk = buffer.subarray(0, read.bytesRead);
      reverseChunks.push(chunk);
      scannedBytes += read.bytesRead;
      for (const byte of chunk) {
        if (byte === 0x0a) newlineCount += 1;
      }
      if (newlineCount > boundedLimit) break;
    }

    reverseChunks.reverse();
    const text = Buffer.concat(reverseChunks, scannedBytes).toString("utf8");

    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-boundedLimit);
    const rows: T[] = [];
    for (const line of lines) {
      try {
        rows.push(JSON.parse(line) as T);
      } catch {
        // A partial first line is expected when the bounded reverse scan stops.
      }
    }
    return {
      rows,
      fileBytes,
      scannedBytes,
      truncated: position > 0,
    };
  } finally {
    await handle.close();
  }
}
