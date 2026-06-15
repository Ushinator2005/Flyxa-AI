import { Router, Response, NextFunction } from 'express';
import { authMiddleware } from '../middleware/auth';
import { supabase } from '../services/supabase';
import { AuthenticatedRequest } from '../types/index';

const router = Router();
const MAX_BACKUP_ENTRIES = 2000;

interface BackupEntryPayload {
  date: string;
  content: string;
  screenshots: string[];
  mood: string | null;
}

function normalizeBackupDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function normalizeScreenshots(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .slice(0, 40);
}

function normalizeMood(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, 40) : null;
}

function normalizeBackupEntries(value: unknown): BackupEntryPayload[] {
  if (!Array.isArray(value)) return [];
  const normalized: BackupEntryPayload[] = [];

  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const date = normalizeBackupDate(record.date);
    if (!date) continue;

    normalized.push({
      date,
      content: typeof record.content === 'string' ? record.content : '',
      screenshots: normalizeScreenshots(record.screenshots),
      mood: normalizeMood(record.mood),
    });
  }

  return normalized;
}

// GET /
router.get('/', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { data, error } = await supabase
      .from('journal_entries')
      .select('*')
      .eq('user_id', req.userId!)
      .order('date', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /backup
router.get('/backup', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { data, error } = await supabase
      .from('journal_entries')
      .select('*')
      .eq('user_id', req.userId!)
      .order('date', { ascending: false });

    if (error) throw error;
    res.json({
      version: 1,
      exported_at: new Date().toISOString(),
      entries: data ?? [],
    });
  } catch (err) {
    next(err);
  }
});

// POST /backup/restore
router.post('/backup/restore', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const entries = normalizeBackupEntries((req.body as { entries?: unknown }).entries);
    if (entries.length === 0) {
      res.status(400).json({ error: 'No valid backup entries found' });
      return;
    }
    if (entries.length > MAX_BACKUP_ENTRIES) {
      res.status(400).json({ error: `Backup too large. Max ${MAX_BACKUP_ENTRIES} entries.` });
      return;
    }

    const { data: existing, error: existingError } = await supabase
      .from('journal_entries')
      .select('id,date')
      .eq('user_id', req.userId!)
      .order('created_at', { ascending: true });

    if (existingError) throw existingError;

    const existingByDate = new Map<string, string>();
    for (const row of existing ?? []) {
      if (typeof row.date === 'string' && typeof row.id === 'string' && !existingByDate.has(row.date)) {
        existingByDate.set(row.date, row.id);
      }
    }

    let created = 0;
    let updated = 0;
    let failed = 0;

    for (const entry of entries) {
      const existingId = existingByDate.get(entry.date);
      if (existingId) {
        const { error } = await supabase
          .from('journal_entries')
          .update({
            content: entry.content,
            screenshots: entry.screenshots,
            mood: entry.mood,
          })
          .eq('id', existingId)
          .eq('user_id', req.userId!);
        if (error) {
          failed += 1;
        } else {
          updated += 1;
        }
        continue;
      }

      const { data, error } = await supabase
        .from('journal_entries')
        .insert({
          user_id: req.userId!,
          date: entry.date,
          content: entry.content,
          screenshots: entry.screenshots,
          mood: entry.mood,
        })
        .select('id,date')
        .single();

      if (error || !data) {
        failed += 1;
        continue;
      }

      existingByDate.set(data.date, data.id);
      created += 1;
    }

    const skipped = entries.length - created - updated - failed;

    res.json({
      requested: entries.length,
      created,
      updated,
      skipped,
      failed,
    });
  } catch (err) {
    next(err);
  }
});

// GET /:id
router.get('/:id', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('journal_entries')
      .select('*')
      .eq('id', id)
      .eq('user_id', req.userId!)
      .single();

    if (error || !data) {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }

    res.json(data);
  } catch (err) {
    next(err);
  }
});

// POST /
router.post('/', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { date, content, screenshots, mood } = req.body;

    const insertPayload: Record<string, unknown> = {
      user_id: req.userId!,
      date,
      content: content || '',
      screenshots: screenshots || [],
    };
    const normalizedMood = normalizeMood(mood);
    if (normalizedMood) insertPayload.mood = normalizedMood;

    const { data, error } = await supabase
      .from('journal_entries')
      .insert(insertPayload)
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    next(err);
  }
});

// PUT /:id
router.put('/:id', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const { data: existing, error: fetchError } = await supabase
      .from('journal_entries')
      .select('user_id')
      .eq('id', id)
      .single();

    if (fetchError || !existing) {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }

    if (existing.user_id !== req.userId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const updates: Record<string, unknown> = {};
    if ('date' in body) updates.date = body.date;
    if ('content' in body) updates.content = typeof body.content === 'string' ? body.content : '';
    if ('screenshots' in body) updates.screenshots = normalizeScreenshots(body.screenshots);
    if ('mood' in body) updates.mood = normalizeMood(body.mood);

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: 'No valid journal fields provided' });
      return;
    }

    const { data, error } = await supabase
      .from('journal_entries')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// DELETE /:id
router.delete('/:id', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const { data: existing, error: fetchError } = await supabase
      .from('journal_entries')
      .select('user_id')
      .eq('id', id)
      .single();

    if (fetchError || !existing) {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }

    if (existing.user_id !== req.userId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const { error } = await supabase
      .from('journal_entries')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
