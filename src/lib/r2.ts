import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const accountId = process.env.R2_ACCOUNT_ID || '';
const accessKeyId = process.env.R2_ACCESS_KEY_ID || '';
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || '';
const bucketName = process.env.R2_BUCKET_NAME || '';
const publicUrl = process.env.R2_PUBLIC_URL || '';

export const s3Client = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId,
    secretAccessKey,
  },
});

/**
 * Upload a buffer to Cloudflare R2 and return the public URL.
 */
export async function uploadToR2(
  fileBuffer: Buffer,
  key: string,
  contentType: string
): Promise<string> {
  if (!accountId || !accessKeyId || !secretAccessKey || !bucketName) {
    throw new Error('Cloudflare R2 credentials are not configured in backend/.env');
  }

  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: fileBuffer,
    ContentType: contentType,
  });

  await s3Client.send(command);

  // Return the public URL for the uploaded file
  const base = publicUrl ? publicUrl.replace(/\/$/, '') : `https://${bucketName}.${accountId}.r2.cloudflarestorage.com`;
  return `${base}/${key}`;
}
