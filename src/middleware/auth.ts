import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

// Extend Express Request type to include userId
declare global {
  namespace Express {
    interface Request {
      userId: string;
    }
  }
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }

    const token = authHeader.substring(7);
    const jwtSecret = process.env.JWT_SECRET;
    
    if (!jwtSecret) {
      throw new Error('JWT_SECRET is missing');
    }

    const decoded = jwt.verify(token, jwtSecret) as { sub: string };
    req.userId = decoded.sub;
    
    next();
  } catch (error) {
    console.error('[Auth Middleware Error]', error);
    res.status(401).json({ error: 'Unauthorized — invalid or expired token' });
  }
}
