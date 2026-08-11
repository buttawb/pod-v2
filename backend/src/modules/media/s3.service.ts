import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface VerifiedObject {
  sizeBytes: number;
  etag: string;
  contentType: string | undefined;
}

/**
 * The API never touches image bytes: clients PUT straight to S3 with
 * presigned URLs (server-dictated keys), and the server trusts only its own
 * HeadObject verification - never the client's word - for completeness.
 */
@Injectable()
export class S3Service {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly putTtlSec: number;
  private readonly getTtlSec: number;

  constructor(config: ConfigService) {
    const endpoint = config.get<string>('S3_ENDPOINT');
    this.client = new S3Client({
      region: config.getOrThrow<string>('AWS_REGION'),
      // Endpoint override + path style are for localstack in dev only;
      // in prod the instance role + real S3 are used.
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    });
    this.bucket = config.getOrThrow<string>('S3_BUCKET');
    this.putTtlSec = config.get<number>('PRESIGN_PUT_TTL_SEC', 900);
    this.getTtlSec = config.get<number>('PRESIGN_GET_TTL_SEC', 300);
  }

  presignPut(key: string, contentType: string, contentLength: number): Promise<string> {
    // Content type and exact length are part of the signature - a client
    // cannot upload a different payload shape than it declared.
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
        ContentLength: contentLength,
      }),
      { expiresIn: this.putTtlSec },
    );
  }

  presignGet(key: string): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: this.getTtlSec },
    );
  }

  async headObject(key: string): Promise<VerifiedObject | null> {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        sizeBytes: head.ContentLength ?? 0,
        etag: head.ETag ?? '',
        contentType: head.ContentType,
      };
    } catch {
      return null;
    }
  }
}
