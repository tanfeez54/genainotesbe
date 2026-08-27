import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { supabaseService } from './supabase';

const accountId = process.env.R2_ACCOUNT_ID || '';
const accessKeyId = process.env.R2_ACCESS_KEY_ID || '';
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || '';
const bucketName = process.env.R2_BUCKET_NAME || '';
const publicUrl = process.env.R2_PUBLIC_URL || '';

export const s3Client = new S3Client({
  region: 'auto',
  endpoint: accountId ? `https://${accountId}.r2.cloudflarestorage.com` : 'https://auto.r2.cloudflarestorage.com',
  credentials: {
    accessKeyId: accessKeyId || 'dummy',
    secretAccessKey: secretAccessKey || 'dummy',
  },
});

/**
 * Upload a file buffer to Cloudflare R2 (CDN) or Supabase Storage and return the public URL.
 */
export async function uploadToStorage(
  fileBuffer: Buffer,
  key: string,
  contentType: string
): Promise<string> {
  // 1. Try Cloudflare R2 first
  if (accountId && accessKeyId && secretAccessKey && bucketName) {
    try {
      const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: fileBuffer,
        ContentType: contentType,
      });

      await s3Client.send(command);

      const base = publicUrl ? publicUrl.replace(/\/$/, '') : `https://${bucketName}.${accountId}.r2.cloudflarestorage.com`;
      return `${base}/${key}`;
    } catch (r2Err) {
      console.warn('R2 upload error, falling back to Supabase storage:', r2Err);
    }
  }

  // 2. Fallback to Supabase Storage ('school_assets' bucket)
  try {
    const { error } = await supabaseService.storage
      .from('school_assets')
      .upload(key, fileBuffer, {
        contentType,
        upsert: true,
      });

    if (error) {
      console.warn('Supabase storage upload notice:', error.message);
    }

    const { data: publicUrlData } = supabaseService.storage
      .from('school_assets')
      .getPublicUrl(key);

    return publicUrlData?.publicUrl || '';
  } catch (err) {
    console.error('Storage upload error:', err);
    return '';
  }
}

/**
 * Delete a file from Cloudflare R2 and Supabase Storage.
 */
export async function deleteFromStorage(fileUrlOrKey: string): Promise<void> {
  if (!fileUrlOrKey) return;

  let key = fileUrlOrKey;
  if (fileUrlOrKey.startsWith('http://') || fileUrlOrKey.startsWith('https://')) {
    try {
      const urlObj = new URL(fileUrlOrKey);
      key = urlObj.pathname.replace(/^\//, '').replace(/^school_assets\//, '');
    } catch (e) {}
  }

  // 1. Delete from R2
  if (accountId && accessKeyId && secretAccessKey && bucketName) {
    try {
      await s3Client.send(new DeleteObjectCommand({
        Bucket: bucketName,
        Key: key,
      }));
    } catch (e) {
      console.warn('R2 delete error:', e);
    }
  }

  // 2. Delete from Supabase Storage
  try {
    await supabaseService.storage.from('school_assets').remove([key]);
  } catch (e) {
    console.warn('Supabase storage delete error:', e);
  }
}

// Legacy alias
export const uploadToR2 = uploadToStorage;
