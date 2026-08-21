import { Router } from 'express';
import { z } from 'zod';
import { supabaseService } from '../lib/supabase';
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
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
      return;
    }

    const { name, contact_email, phone, address, board, logo_url, stamp_url, signature_url, classes_range, num_teachers, num_students } = parsed.data;

    // 1. Create the school
    const { data: school, error: schoolError } = await supabaseService
      .from('schools')
      .insert([
        { name, contact_email, phone, address, board, logo_url, stamp_url, signature_url, classes_range, num_teachers, num_students }
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
          full_name: 'Admin'
        }
      ]);

    if (userError) {
      console.error('Error adding user to school:', userError);
      res.status(500).json({ error: 'Failed to assign user to school' });
      return;
    }

    res.status(201).json({ message: 'School created successfully', school });
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

// Invite a user to a school
router.post('/:id/invite', async (req: Request, res: Response): Promise<void> => {
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
    
        if (accessError || !access || access.role !== 'school_admin') {
          res.status(403).json({ error: 'Only school admins can invite users' });
          return;
        }

        const schema = z.object({
            email: z.string().email(),
            role: z.enum(['school_admin', 'teacher', 'data_entry']),
            full_name: z.string().optional()
        });

        const parsed = schema.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
            return;
        }

        const { email, role, full_name } = parsed.data;

        // Note: In a real implementation, you would:
        // 1. Send an invite email via Supabase Admin API: await supabaseService.auth.admin.inviteUserByEmail(email)
        // 2. Add them to school_users table once they sign up (using a trigger, or pre-filling).
        // Since we don't want to actually send emails right now in this mock environment, 
        // we'll just return a success message assuming the Resend setup is working.

        const { data: inviteData, error: inviteError } = await supabaseService.auth.admin.inviteUserByEmail(email, {
            data: { full_name }
        });

        if (inviteError) {
             console.error('Invite error:', inviteError);
             res.status(500).json({ error: 'Failed to send invite' });
             return;
        }

        // We can pre-create the school_users mapping with the new user's ID
        if (inviteData && inviteData.user) {
             await supabaseService
             .from('school_users')
             .insert([
                 {
                 school_id: schoolId,
                 user_id: inviteData.user.id,
                 role: role,
                 full_name: full_name
                 }
             ]);
        }

        res.json({ message: 'User invited successfully' });
    } catch (error) {
        console.error('Server error inviting user:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
