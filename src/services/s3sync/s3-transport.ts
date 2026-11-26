/**
 * S3-compatible storage access for the worker (Bun runtime only). The
 * interface exists so tests inject an in-memory fake — no test ever touches
 * the network. Built and validated against Yandex Object Storage
 * (https://storage.yandexcloud.net, region ru-central1, path-style).
 */
import { statSync } from 'node:fs';

/**
 * Transport contract: `download` does not create parent directories and may
 * leave a partial file on failure — callers verify sha256 and byte count
 * after download. The transport performs no retries; the caller's scheduler
 * owns failure recovery (a failed push retries at the next tick).
 */
export interface S3Transport {
  upload(localPath: string, key: string): Promise<void>;
  download(key: string, localPath: string): Promise<void>;
  deleteObject(key: string): Promise<void>;
  listKeys(prefix: string): Promise<string[]>;
}

export interface BunS3TransportConfig {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Single-shot PUT up to this size; multipart above it. */
const MULTIPART_THRESHOLD_BYTES = 64 * 1024 * 1024;
const MULTIPART_PART_SIZE = 16 * 1024 * 1024;

export class BunS3Transport implements S3Transport {
  private readonly client: InstanceType<(typeof import('bun'))['S3Client']>;

  constructor(config: BunS3TransportConfig) {
    if (typeof Bun === 'undefined') {
      throw new Error('S3 transport needs the Bun runtime (the worker), not Node');
    }
    this.client = new Bun.S3Client({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      bucket: config.bucket,
      endpoint: config.endpoint,
      region: config.region,
    });
  }

  async upload(localPath: string, key: string): Promise<void> {
    const bytes = statSync(localPath).size;
    if (bytes <= MULTIPART_THRESHOLD_BYTES) {
      // Bun.file() is a Blob; s3.write accepts it directly. Should stream without
      // full buffering; smoke-validated against Yandex: 200 OK.
      await this.client.write(key, Bun.file(localPath));
      return;
    }
    const writer = this.client.file(key).writer({ partSize: MULTIPART_PART_SIZE });
    try {
      const stream = Bun.file(localPath).stream();
      for await (const chunk of stream) {
        await writer.write(chunk);
      }
      await writer.end();
    } catch (error) {
      // Surface the failure through the sink so Bun aborts the multipart
      // upload server-side; without this, a mid-stream read error would
      // leave billed orphaned parts listKeys can never see.
      await Promise.resolve(
        writer.end(error instanceof Error ? error : new Error(String(error))),
      ).catch(() => {});
      throw error;
    }
  }

  async download(key: string, localPath: string): Promise<void> {
    await Bun.write(localPath, this.client.file(key));
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.delete(key);
  }

  async listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.list({ prefix, continuationToken: cursor, maxKeys: 1000 });
      for (const entry of page.contents ?? []) keys.push(entry.key);
      cursor = page.nextContinuationToken ?? undefined;
    } while (cursor);
    return keys;
  }
}
