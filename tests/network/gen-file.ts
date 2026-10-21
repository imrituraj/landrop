import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';

/**
 * Writes a deterministic pseudo-random file of `size` bytes in 4 MiB blocks
 * (bounded memory) and returns its SHA-256. Usage from CLI:
 *   node tests/network/gen-file.ts <path> <bytes> [seed]
 */
export async function generateFile(path: string, size: number, seed = 1): Promise<string> {
  const out = createWriteStream(path);
  const hash = createHash('sha256');
  const block = Buffer.alloc(4 * 1024 * 1024);
  let x = seed >>> 0 || 1;
  let written = 0;
  while (written < size) {
    const n = Math.min(block.length, size - written);
    for (let i = 0; i < n; i += 4) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      block.writeUInt32LE(x >>> 0, i);
    }
    const chunk = block.subarray(0, n);
    hash.update(chunk);
    if (!out.write(chunk)) await once(out, 'drain');
    written += n;
  }
  out.end();
  await once(out, 'finish');
  return hash.digest('hex');
}

if (process.argv[1]?.endsWith('gen-file.ts') && process.argv[2]) {
  const size = Number(process.argv[3]);
  generateFile(process.argv[2], size, Number(process.argv[4] ?? 1)).then((h) => console.log(h));
}
