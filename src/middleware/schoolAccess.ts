import { Request, Response, NextFunction } from 'express';
import { supabaseService } from '../lib/supabase';

/**
 * Middleware to ensure the user has access to a specific school and has the required role.
 * Expects `req.userId` to be set by the previous `authMiddleware`.
 * If `school_id` is not passed in the request body/params/query, it will try to find the user's default school.
 */
export const requireSchoolAccess = (allowedRoles: string[] = ['super_admin', 'school_admin', 'teacher', 'data_entry']) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      // Determine the requested school_id from headers, params, body, or query
      const requestedSchoolId = req.headers['x-school-id'] || req.params.school_id || req.body.school_id || req.query.school_id;

      let query = supabaseService
        .from('school_users')
        .select('school_id, role')
        .eq('user_id', req.userId)
        .eq('is_active', true);

      if (requestedSchoolId) {
        query = query.eq('school_id', requestedSchoolId as string);
      }

      const { data: schoolUsers, error } = await query;

      if (error || !schoolUsers || schoolUsers.length === 0) {
        res.status(403).json({ error: 'Access denied. You do not belong to this school or are inactive.' });
        return;
      }

      // If no specific school was requested, default to the first one they belong to (useful for simple UI where user has 1 school)
      const activeSchoolUser = schoolUsers[0];

      if (!allowedRoles.includes(activeSchoolUser.role)) {
        res.status(403).json({ error: `Access denied. Requires one of these roles: ${allowedRoles.join(', ')}` });
        return;
      }

      // Attach school context to the request
      req.school_id = activeSchoolUser.school_id;
      req.role = activeSchoolUser.role;

      next();
    } catch (err) {
      console.error('requireSchoolAccess Error:', err);
      res.status(500).json({ error: 'Internal server error during authorization' });
    }
  };
};
