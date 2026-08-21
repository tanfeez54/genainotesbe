import 'express';

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      school_id?: string;
      role?: string;
    }
  }
}
