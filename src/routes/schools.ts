import { Router } from 'express';
import { z } from 'zod';
import { supabaseService } from '../lib/supabase';
import { DeviceSecurityService } from '../services/deviceSecurityService';
import type { Request, Response } from 'express';

const router = Router();

// Create a new school (tenant onboarding)
router.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const schema = z.object({
      name: z.string().min(2),
      contact_email: z.string().email(),
      phone: z.string().nullish(),
      address: z.string().nullish(),
      board: z.string().nullish(),
      logo_url: z.string().nullish(),
      stamp_url: z.string().nullish(),
      signature_url: z.string().nullish(),
      classes_range: z.string().nullish(),
      num_teachers: z.number().int().nullish(),
      num_students: z.number().int().nullish(),
      device_fingerprint: z.string().nullish(),
      device_id: z.string().nullish(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
      return;
    }

    const {
      name,
      contact_email,
      phone,
      address,
      board,
      logo_url,
      stamp_url,
      signature_url,
      classes_range,
      num_teachers,
      num_students,
    } = parsed.data;

    // Check if this device, IP, or system has already claimed a free trial
    const deviceInfo = DeviceSecurityService.extractDeviceInfo(req);
    const trialCheck = await DeviceSecurityService.checkTrialAllowed({
      fingerprint: deviceInfo.fingerprint,
      deviceId: deviceInfo.deviceId,
      ip: deviceInfo.ip,
      email: contact_email,
    });

    const isTrialAllowed = trialCheck.allowed;
    const initialBalance = isTrialAllowed ? 50.0 : 0.0;
    const subscriptionStatus = isTrialAllowed ? 'trial' : 'trial_expired';
    const trialEndsAt = isTrialAllowed
      ? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
      : new Date().toISOString();

    // 1. Create the school
    const { data: school, error: schoolError } = await supabaseService
      .from('schools')
      .insert([
        {
          name,
          contact_email,
          phone,
          address,
          board,
          logo_url,
          stamp_url,
          signature_url,
          classes_range,
          num_teachers,
          num_students,
          wallet_balance: initialBalance,
          cost_per_generation: 5.0,
          subscription_status: subscriptionStatus,
          trial_ends_at: trialEndsAt,
        },
      ])
      .select()
      .single();

    if (schoolError || !school) {
      console.error('Error creating school:', schoolError);
      res.status(500).json({ error: 'Failed to create school' });
      return;
    }

    // 2. Add the user as a school_admin
    const { error: userError } = await supabaseService
      .from('school_users')
      .insert([
        {
          school_id: school.id,
          user_id: userId,
          role: 'school_admin',
          full_name: 'Admin',
        },
      ]);

    if (userError) {
      console.error('Error adding user to school:', userError);
      res.status(500).json({ error: 'Failed to assign user to school' });
      return;
    }

    // 3. Log the welcome bonus and record device claim only if trial is allowed
    if (isTrialAllowed) {
      try {
        await supabaseService.from('wallet_transactions').insert([
          {
            school_id: school.id,
            user_id: userId,
            amount: 50.0,
            type: 'welcome_bonus',
            description: 'Welcome Bonus: 10 Free AI Generations (₹50.00 credit)',
            balance_after: 50.0,
          },
        ]);

        // Record trial claim against this device fingerprint & IP
        await DeviceSecurityService.recordTrialClaim({
          fingerprint: deviceInfo.fingerprint,
          deviceId: deviceInfo.deviceId,
          ip: deviceInfo.ip,
          userId,
          schoolId: school.id,
        });
      } catch (txErr) {
        console.warn('Could not record welcome transaction or claim:', txErr);
      }

      res.status(201).json({
        message: 'School created successfully with ₹50 welcome credit!',
        school,
        trial_granted: true,
      });
    } else {
      res.status(201).json({
        message:
          'School created successfully. Notice: Free trial has already been claimed on this system/device. Current wallet balance is ₹0.00. Please recharge in Subscription & Wallet to generate question papers.',
        school,
        trial_granted: false,
        trial_abuse_prevented: true,
      });
    }
  } catch (error) {
    console.error('Server error creating school:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get my school (current user's primary school)
router.get('/my-school', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { data: schoolUser, error: suError } = await supabaseService
      .from('school_users')
      .select('school_id')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('created_at', { ascending: true })
      .limit(1)
      .single();

    if (suError || !schoolUser) {
      res.status(404).json({ error: 'No school found for user' });
      return;
    }

    const { data: school, error: schoolError } = await supabaseService
      .from('schools')
      .select('*')
      .eq('id', schoolUser.school_id)
      .single();

    if (schoolError || !school) {
      res.status(404).json({ error: 'School not found' });
      return;
    }

    res.json({ school });
  } catch (error) {
    console.error('Server error fetching my school:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get a school's profile
router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const schoolId = req.params.id;

    const { data: access, error: accessError } = await supabaseService
      .from('school_users')
      .select('role')
      .eq('school_id', schoolId)
      .eq('user_id', userId)
      .eq('is_active', true)
      .single();

    if (accessError || !access) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const { data: school, error: schoolError } = await supabaseService
      .from('schools')
      .select('*')
      .eq('id', schoolId)
      .single();

    if (schoolError || !school) {
      res.status(404).json({ error: 'School not found' });
      return;
    }

    res.json(school);
  } catch (error) {
    console.error('Server error fetching school:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update a school
router.patch('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const schoolId = req.params.id;

    // Check if current user is school_admin
    const { data: access, error: accessError } = await supabaseService
      .from('school_users')
      .select('role')
      .eq('school_id', schoolId)
      .eq('user_id', userId)
      .eq('is_active', true)
      .single();

    if (accessError || !access || (access.role !== 'school_admin' && access.role !== 'super_admin')) {
      res.status(403).json({ error: 'Only admins can update school profile' });
      return;
    }

    const schema = z.object({
      name: z.string().min(2).optional(),
      contact_email: z.string().email().optional(),
      phone: z.string().nullish(),
      address: z.string().nullish(),
      board: z.string().nullish(),
      logo_url: z.string().nullish(),
      stamp_url: z.string().nullish(),
      signature_url: z.string().nullish(),
      classes_range: z.string().nullish(),
      num_teachers: z.number().int().nullish(),
      num_students: z.number().int().nullish(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
      return;
    }

    const { data: school, error: schoolError } = await supabaseService
      .from('schools')
      .update(parsed.data)
      .eq('id', schoolId)
      .select()
      .single();

    if (schoolError || !school) {
      res.status(500).json({ error: 'Failed to update school' });
      return;
    }

    res.json(school);
  } catch (error) {
    console.error('Server error updating school:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// List all staff members for a school
router.get('/:id/staff', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const schoolId = req.params.id;

    // Verify user belongs to this school
    const { data: access } = await supabaseService
      .from('school_users')
      .select('role')
      .eq('school_id', schoolId)
      .eq('user_id', userId)
      .eq('is_active', true)
      .single();

    if (!access) {
      res.status(403).json({ error: 'Access denied to this school' });
      return;
    }

    // Fetch all members of this school with their details
    const { data: members, error: membersError } = await supabaseService
      .from('school_users')
      .select('id, user_id, role, full_name, is_active, created_at')
      .eq('school_id', schoolId)
      .order('created_at', { ascending: false });

    if (membersError) throw membersError;

    // Fetch emails from users table
    const userIds = (members || []).map((m: any) => m.user_id).filter(Boolean);
    let userMap: Record<string, any> = {};
    if (userIds.length > 0) {
      const { data: usersData } = await supabaseService
        .from('users')
        .select('id, email, full_name, mobile')
        .in('id', userIds);
      (usersData || []).forEach((u: any) => {
        userMap[u.id] = u;
      });
    }

    const staffWithDetails = (members || []).map((m: any) => {
      const u = userMap[m.user_id];
      return {
        ...m,
        email: u?.email || 'N/A',
        full_name: m.full_name || u?.full_name || 'Staff Member',
        mobile: u?.mobile || null,
      };
    });

    res.json({ staff: staffWithDetails });
  } catch (error) {
    console.error('Server error fetching school staff:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Invite a user to a school
router.post('/:id/invite', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const schoolId = req.params.id;

    // Check if current user is school_admin or super_admin
    const { data: access, error: accessError } = await supabaseService
      .from('school_users')
      .select('role')
      .eq('school_id', schoolId)
      .eq('user_id', userId)
      .eq('is_active', true)
      .single();

    if (accessError || !access || (access.role !== 'school_admin' && access.role !== 'super_admin')) {
      res.status(403).json({ error: 'Only school admins can invite staff members' });
      return;
    }

    const schema = z.object({
      email: z.string().email('Invalid email address'),
      role: z.enum(['school_admin', 'teacher', 'data_entry']),
      full_name: z.string().optional()
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
      return;
    }

    const { email, role, full_name } = parsed.data;
    const targetEmail = email.toLowerCase().trim();

    // Fetch school info for invitation email
    const { data: school } = await supabaseService
      .from('schools')
      .select('name')
      .eq('id', schoolId)
      .single();
    const schoolName = school?.name || 'NoteGen Academic School';

    // 1. Check if user already exists in custom users table
    let { data: existingUser } = await supabaseService
      .from('users')
      .select('id, email, full_name')
      .eq('email', targetEmail)
      .single();

    // If user doesn't exist, create an account record for them
    if (!existingUser) {
      const { data: createdUser, error: createError } = await supabaseService
        .from('users')
        .insert([
          {
            email: targetEmail,
            full_name: full_name?.trim() || 'Staff Member',
          }
        ])
        .select('id, email, full_name')
        .single();

      if (createError || !createdUser) {
        console.error('Error creating user record for invite:', createError);
        const { data: retryUser } = await supabaseService
          .from('users')
          .select('id, email, full_name')
          .eq('email', targetEmail)
          .single();
        existingUser = retryUser;
      } else {
        existingUser = createdUser;
      }
    }

    if (!existingUser) {
      res.status(500).json({ error: 'Could not register user record for invitation' });
      return;
    }

    // 2. Upsert into school_users table
    const { data: existingMember } = await supabaseService
      .from('school_users')
      .select('id, role, is_active')
      .eq('school_id', schoolId)
      .eq('user_id', existingUser.id)
      .single();

    if (existingMember) {
      await supabaseService
        .from('school_users')
        .update({
          role,
          full_name: full_name?.trim() || existingUser.full_name || 'Staff Member',
          is_active: true
        })
        .eq('id', existingMember.id);
    } else {
      const { error: insertError } = await supabaseService
        .from('school_users')
        .insert([
          {
            school_id: schoolId,
            user_id: existingUser.id,
            role,
            full_name: full_name?.trim() || existingUser.full_name || 'Staff Member',
            is_active: true
          }
        ]);

      if (insertError) {
        console.error('Error assigning staff member to school:', insertError);
        res.status(500).json({ error: 'Failed to assign staff member to school' });
        return;
      }
    }

    // 3. Send professional invitation email via GoodSender template
    const apiKey = process.env.GOODSENDER_API_KEY;
    const senderEmail = process.env.GOODSENDER_SENDER_EMAIL;

    if (apiKey && senderEmail) {
      const goodsenderUrl = 'https://api.goodsender.com/v1/emails/template';
      const appDomain = process.env.APP_URL && !process.env.APP_URL.includes('localhost')
        ? process.env.APP_URL 
        : 'https://qalam.website';
      const roleLabel = role === 'school_admin' ? 'School Administrator' : role === 'data_entry' ? 'Data Entry Staff' : 'Teacher';

      const emailPayload = {
        from: { email: senderEmail, name: 'NoteGen Academic' },
        to: { email: targetEmail },
        subject: `Invitation: Join ${schoolName} on NoteGen`,
        template: {
          template_id: 'otp_code',
          variables: {
            purpose: 'Staff Invitation',
            app_name: schoolName,
            otp_code: 'INVITE',
            expiry_minutes: '1440',
            anti_phishing_notice: `You have been added to ${schoolName} as ${roleLabel}. Please log in to your account at ${appDomain}/login to access your syllabus, question generator, and papers.`
          }
        }
      };

      fetch(goodsenderUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(emailPayload)
      }).catch((err) => console.warn('[GoodSender Invite] Email send failed:', err));
    }

    res.json({
      message: `Invite sent successfully to ${targetEmail}!`,
      staff: {
        email: targetEmail,
        role,
        full_name: full_name?.trim() || existingUser.full_name || 'Staff Member'
      }
    });
  } catch (error) {
    console.error('Server error inviting user:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
