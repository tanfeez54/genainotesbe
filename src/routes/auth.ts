import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { supabaseAdmin } from '../lib/supabase';

const router = Router();

// Helper to generate a 6-digit OTP
const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

// ==========================================
// 1. SIGNUP -> Generates OTP and sends it
// ==========================================
router.post('/signup', async (req: Request, res: Response) => {
  const { email, full_name, mobile } = req.body;
  if (!email || !full_name) {
    res.status(400).json({ error: 'Email and full_name are required' });
    return;
  }

  try {
    // Check if user already exists and has a password
    const { data: existingUser } = await supabaseAdmin
      .from('users')
      .select('id, password_hash')
      .eq('email', email)
      .single();

    if (existingUser && existingUser.password_hash) {
      res.status(400).json({ error: 'User already exists. Please log in.' });
      return;
    }

    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes

    // Upsert user with new OTP
    const { error: dbError } = await supabaseAdmin
      .from('users')
      .upsert(
        { email, full_name, mobile, otp, otp_expires_at: expiresAt },
        { onConflict: 'email' }
      );

    if (dbError) throw dbError;

    // Send email via GoodSender
    const apiKey = process.env.GOODSENDER_API_KEY;
    const senderEmail = process.env.GOODSENDER_SENDER_EMAIL;

    if (!apiKey || !senderEmail) {
      console.warn('[GoodSender] Missing API Key or Sender Email in .env');
      res.status(500).json({ error: 'GoodSender not configured' });
      return;
    }

    const goodsenderUrl = 'https://api.goodsender.com/v1/emails/template';
    const emailPayload = {
      from: { email: senderEmail, name: 'NoteGen AI' },
      to: { email },
      subject: 'Your NoteGen AI Verification Code',
      template: {
        template_id: 'otp_code',
        variables: {
          purpose: 'Signup verification',
          app_name: 'NoteGen AI',
          otp_code: otp,
          expiry_minutes: '10',
          anti_phishing_notice: 'If you did not request this code, please ignore this email.'
        }
      }
    };

    const response = await fetch(goodsenderUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(emailPayload)
    });

    console.log(`\n========================================`);
    console.log(`🔐 LOCAL DEV: Your Signup OTP for ${email} is: ${otp}`);
    console.log(`========================================\n`);

    const result: any = await response.json().catch(() => null);

    if (!response.ok || (result && result.declined > 0)) {
      console.warn('[GoodSender] Failed to send email. However, for local dev, you can use the OTP printed above!');
      res.status(200).json({
        success: true,
        message: 'Email failed, but you can copy the OTP from the backend terminal to verify!'
      });
      return;
    }

    res.status(200).json({ success: true, message: 'OTP sent successfully to your email!' });
  } catch (error) {
    console.error('[Auth Signup Error]', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// 2. VERIFY SIGNUP -> Verifies OTP, returns setup_token
// ==========================================
router.post('/verify-signup', async (req: Request, res: Response) => {
  const { email, token } = req.body;
  if (!email || !token) {
    res.status(400).json({ error: 'Email and token are required' });
    return;
  }

  try {
    const { data: user, error: dbError } = await supabaseAdmin
      .from('users')
      .select('id, email, otp, otp_expires_at')
      .eq('email', email)
      .single();

    if (dbError || !user) {
      res.status(400).json({ error: 'Invalid or expired code' });
      return;
    }

    const now = new Date();
    const expiresAt = new Date(user.otp_expires_at);

    if (user.otp !== token) {
      res.status(400).json({ error: 'Invalid code' });
      return;
    }

    if (now > expiresAt) {
      res.status(400).json({ error: 'Code has expired' });
      return;
    }

    // Clear OTP in DB
    await supabaseAdmin
      .from('users')
      .update({ otp: null, otp_expires_at: null })
      .eq('id', user.id);

    // Issue a short-lived token just for setting the password
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) throw new Error('JWT_SECRET is missing');

    const setupToken = jwt.sign(
      { sub: user.id, email: user.email, intent: 'setup-password' },
      jwtSecret,
      { expiresIn: '15m' }
    );

    res.status(200).json({ success: true, setup_token: setupToken });
  } catch (error) {
    console.error('[Auth Verify Error]', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// 3. SET PASSWORD -> Hashes password & returns Login JWT
// ==========================================
router.post('/set-password', async (req: Request, res: Response) => {
  const { setup_token, email, otp, password } = req.body;

  if (!password || password.length < 6) {
    res.status(400).json({ error: 'Password must be at least 6 characters' });
    return;
  }

  try {
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) throw new Error('JWT_SECRET is missing');

    let userId: string;

    // Option 1: Authenticate via setup_token (Supports Short 16-hex token OR JWT)
    if (setup_token) {
      // 1a. Check if it's a short token stored in users.otp
      const { data: userByOtp } = await supabaseAdmin
        .from('users')
        .select('id, email, otp, otp_expires_at')
        .eq('otp', setup_token.trim())
        .single();

      if (userByOtp) {
        if (userByOtp.otp_expires_at && new Date() > new Date(userByOtp.otp_expires_at)) {
          res.status(400).json({ error: 'Activation link has expired' });
          return;
        }
        userId = userByOtp.id;
      } else {
        // 1b. Fallback to JWT verification
        try {
          const decoded = jwt.verify(setup_token, jwtSecret) as any;
          if (decoded.intent !== 'setup-password') {
            res.status(400).json({ error: 'Invalid token intent' });
            return;
          }
          userId = decoded.sub;
        } catch (jwtErr) {
          res.status(400).json({ error: 'Invalid or expired activation link' });
          return;
        }
      }
    }
    // Option 2: Authenticate via email + 6-digit activation OTP
    else if (email && otp) {
      const { data: user, error: userErr } = await supabaseAdmin
        .from('users')
        .select('id, email, otp, otp_expires_at')
        .eq('email', email.toLowerCase().trim())
        .single();

      if (userErr || !user || user.otp !== otp.trim()) {
        res.status(400).json({ error: 'Invalid activation code' });
        return;
      }

      if (user.otp_expires_at && new Date() > new Date(user.otp_expires_at)) {
        res.status(400).json({ error: 'Activation code has expired' });
        return;
      }

      userId = user.id;
    } else {
      res.status(400).json({ error: 'Valid setup token or activation code is required' });
      return;
    }

    // Hash the password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Update user in DB & clear OTP
    const { data: updatedUser, error: dbError } = await supabaseAdmin
      .from('users')
      .update({ password_hash: hashedPassword, otp: null, otp_expires_at: null })
      .eq('id', userId)
      .select('id, email, full_name')
      .single();

    if (dbError || !updatedUser) throw dbError;

    // Issue standard login JWT
    const payload = {
      sub: updatedUser.id,
      email: updatedUser.email,
      user_metadata: { full_name: updatedUser.full_name },
    };
    const accessToken = jwt.sign(payload, jwtSecret, { expiresIn: '7d' });

    res.status(200).json({
      success: true,
      session: { access_token: accessToken, user: payload },
    });
  } catch (error: any) {
    console.error('[Auth Set Password Error]', error);
    res.status(400).json({ error: error.message || 'Invalid or expired token' });
  }
});

// ==========================================
// 4. LOGIN -> Verifies Email + Password
// ==========================================
router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }

  try {
    const { data: user, error: dbError } = await supabaseAdmin
      .from('users')
      .select('id, email, full_name, password_hash')
      .eq('email', email)
      .single();

    if (dbError || !user || !user.password_hash) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    // Verify password hash
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    // Issue standard login JWT
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) throw new Error('JWT_SECRET is missing');

    const payload = {
      sub: user.id,
      email: user.email,
      user_metadata: { full_name: user.full_name }
    };
    const accessToken = jwt.sign(payload, jwtSecret, { expiresIn: '7d' });

    res.status(200).json({
      success: true,
      session: { access_token: accessToken, user: payload }
    });
  } catch (error) {
    console.error('[Auth Login Error]', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
