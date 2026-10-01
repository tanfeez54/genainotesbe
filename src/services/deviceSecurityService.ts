import fs from 'fs';
import path from 'path';
import { supabaseService } from '../lib/supabase';
import type { Request } from 'express';

interface TrialClaimRecord {
  deviceFingerprint: string;
  deviceId?: string;
  ipAddress?: string;
  userId?: string;
  schoolId?: string;
  claimedAt: string;
}

// Known disposable / temporary email domains frequently used for trial abuse
const DISPOSABLE_EMAIL_DOMAINS = new Set([
  '10minutemail.com',
  '10minmail.com',
  'tempmail.com',
  'tempmail.net',
  'guerrillamail.com',
  'guerrillamail.net',
  'mailinator.com',
  'throwawaymail.com',
  'yopmail.com',
  'yopmail.fr',
  'getnada.com',
  'trashmail.com',
  'sharklasers.com',
  'dispostable.com',
  'fakemailgenerator.com',
  'temp-mail.org',
  'mohmal.com',
  'crazymailing.com',
  'dropmail.me',
  'burnermail.io',
  'emailondeck.com',
]);

const LOCAL_STORAGE_DIR = path.resolve(__dirname, '../../data');
const LOCAL_CLAIMS_FILE = path.join(LOCAL_STORAGE_DIR, 'claimed_devices.json');

export class DeviceSecurityService {
  /**
   * Check if an email address is from a temporary / disposable email service
   */
  static isDisposableEmail(email: string): boolean {
    if (!email || !email.includes('@')) return false;
    const domain = email.split('@')[1]?.toLowerCase().trim();
    return Boolean(domain && DISPOSABLE_EMAIL_DOMAINS.has(domain));
  }

  /**
   * Extract device fingerprint, persistent device ID, and IP address from request
   */
  static extractDeviceInfo(req: Request): {
    fingerprint: string;
    deviceId: string;
    ip: string;
    userAgent: string;
  } {
    const headerFingerprint = (req.headers['x-device-fingerprint'] as string) || '';
    const bodyFingerprint = req.body?.device_fingerprint || '';
    const fingerprint = (headerFingerprint || bodyFingerprint || '').trim();

    const headerDeviceId = (req.headers['x-device-id'] as string) || '';
    const bodyDeviceId = req.body?.device_id || '';
    const cookieHeader = req.headers.cookie || '';
    const cookieDeviceIdMatch = cookieHeader.match(/notegen_device_id=([^;]+)/);
    const cookieDeviceId = cookieDeviceIdMatch ? cookieDeviceIdMatch[1] : '';
    const deviceId = (headerDeviceId || bodyDeviceId || cookieDeviceId || '').trim();

    const forwarded = (req.headers['x-forwarded-for'] as string) || '';
    const ip = (forwarded.split(',')[0] || req.socket?.remoteAddress || req.ip || '').trim();
    const userAgent = (req.headers['user-agent'] as string) || '';

    return {
      fingerprint,
      deviceId,
      ip,
      userAgent,
    };
  }

  /**
   * Read locally cached claims file as a fast, resilient fallback
   */
  private static getLocalClaims(): TrialClaimRecord[] {
    try {
      if (!fs.existsSync(LOCAL_STORAGE_DIR)) {
        fs.mkdirSync(LOCAL_STORAGE_DIR, { recursive: true });
      }
      if (!fs.existsSync(LOCAL_CLAIMS_FILE)) {
        fs.writeFileSync(LOCAL_CLAIMS_FILE, '[]', 'utf-8');
        return [];
      }
      const raw = fs.readFileSync(LOCAL_CLAIMS_FILE, 'utf-8');
      return JSON.parse(raw) || [];
    } catch (err) {
      console.warn('[DeviceSecurity] Error reading local claims file:', err);
      return [];
    }
  }

  /**
   * Save a trial claim to local persistent cache
   */
  private static appendLocalClaim(record: TrialClaimRecord): void {
    try {
      const claims = this.getLocalClaims();
      claims.push(record);
      fs.writeFileSync(LOCAL_CLAIMS_FILE, JSON.stringify(claims, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[DeviceSecurity] Error saving local claim:', err);
    }
  }

  /**
   * Check if this device, IP, or system has ALREADY claimed a free trial.
   */
  static async checkTrialAllowed(params: {
    fingerprint: string;
    deviceId: string;
    ip: string;
    email?: string;
  }): Promise<{
    allowed: boolean;
    reason?: string;
  }> {
    const { fingerprint, deviceId, ip, email } = params;

    // 1. Check disposable email
    if (email && this.isDisposableEmail(email)) {
      return {
        allowed: false,
        reason: 'Temporary / disposable emails are not permitted for free trials.',
      };
    }

    // 2. Check local persistent store first (instant response)
    const localClaims = this.getLocalClaims();
    for (const c of localClaims) {
      if (fingerprint && c.deviceFingerprint === fingerprint) {
        return {
          allowed: false,
          reason: 'This device / browser has already claimed a free trial.',
        };
      }
      if (deviceId && c.deviceId && c.deviceId === deviceId) {
        return {
          allowed: false,
          reason: 'This device identifier has already claimed a free trial.',
        };
      }
    }

    // 3. Check Supabase database table `device_trial_claims`
    try {
      if (fingerprint) {
        const { data: byFp } = await supabaseService
          .from('device_trial_claims')
          .select('id, claimed_at')
          .eq('device_fingerprint', fingerprint)
          .limit(1);

        if (byFp && byFp.length > 0) {
          return {
            allowed: false,
            reason: 'This system / device has already registered a trial school.',
          };
        }
      }

      if (deviceId) {
        const { data: byDid } = await supabaseService
          .from('device_trial_claims')
          .select('id, claimed_at')
          .eq('device_id', deviceId)
          .limit(1);

        if (byDid && byDid.length > 0) {
          return {
            allowed: false,
            reason: 'Trial has already been claimed on this device.',
          };
        }
      }

      // Check IP address limit (prevent automated script bursts from the same IP)
      if (ip && ip !== '::1' && ip !== '127.0.0.1' && ip !== 'localhost') {
        const { data: byIp } = await supabaseService
          .from('device_trial_claims')
          .select('id, claimed_at')
          .eq('ip_address', ip);

        // Allow at most 2 legitimate trials per IP (e.g. colleagues on same broadband), block subsequent
        if (byIp && byIp.length >= 2) {
          return {
            allowed: false,
            reason: 'Maximum trial accounts reached for this network / IP address.',
          };
        }
      }
    } catch (dbErr) {
      // Table might not exist yet before migration, proceed gracefully with local cache check
      console.warn('[DeviceSecurity] Database query notice:', dbErr);
    }

    return { allowed: true };
  }

  /**
   * Record a newly claimed trial to lock down the device
   */
  static async recordTrialClaim(record: {
    fingerprint: string;
    deviceId: string;
    ip: string;
    userId: string;
    schoolId: string;
  }): Promise<void> {
    const claimRecord: TrialClaimRecord = {
      deviceFingerprint: record.fingerprint,
      deviceId: record.deviceId,
      ipAddress: record.ip,
      userId: record.userId,
      schoolId: record.schoolId,
      claimedAt: new Date().toISOString(),
    };

    // 1. Save to local persistent storage
    this.appendLocalClaim(claimRecord);

    // 2. Save to Supabase table `device_trial_claims`
    try {
      await supabaseService.from('device_trial_claims').insert([
        {
          device_fingerprint: record.fingerprint || 'unknown_fp',
          device_id: record.deviceId || null,
          ip_address: record.ip || null,
          user_id: record.userId,
          school_id: record.schoolId,
        },
      ]);
    } catch (insertErr) {
      console.warn('[DeviceSecurity] Failed to insert to device_trial_claims in DB:', insertErr);
    }
  }
}
