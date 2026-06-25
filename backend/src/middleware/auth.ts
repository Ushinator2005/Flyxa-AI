import { Response, NextFunction } from 'express';
import { supabase } from '../services/supabase';
import { AuthenticatedRequest } from '../types/index';

export async function authMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'No authorization token provided' });
      return;
    }

    const token = authHeader.substring(7);

    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    req.userId = user.id;
    req.authUser = user;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
