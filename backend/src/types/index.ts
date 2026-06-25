import { Request } from 'express';
import type { User } from '@supabase/supabase-js';

export interface Trade {
  id: string;
  user_id: string;
  symbol: string;
  screenshot_url?: string;
  account_id?: string;
  accountIds?: string[];
  account_ids?: string[];
  direction: 'Long' | 'Short';
  entry_price: number;
  exit_price: number;
  sl_price: number;
  tp_price: number;
  exit_reason: 'TP' | 'SL' | 'BE';
  pnl: number;
  contract_size: number;
  point_value: number;
  trade_date: string;
  trade_time: string;
  trade_length_seconds: number;
  candle_count: number;
  timeframe_minutes: number;
  emotional_state: 'Calm' | 'Confident' | 'Anxious' | 'Revenge Trading' | 'FOMO' | 'Overconfident' | 'Tired';
  confidence_level: number;
  pre_trade_notes: string;
  post_trade_notes: string;
  confluences?: string[];
  followed_plan: boolean;
  behavioral_flags?: string[];
  sessionContext?: {
    emotion?: string;
    note?: string;
    bias?: Record<string, string>;
    readiness?: {
      status?: string;
      score?: number;
      summary?: string;
      reasons?: string[];
    };
    sessionPlan?: Array<{ id?: string; source?: string; rule?: string }>;
    dailyReflection?: {
      pre?: string;
      bias?: string | null;
      newsRisk?: string | null;
      sessionTarget?: number | null;
      marketRespectedBias?: boolean | null;
    };
  };
  session: 'Asia' | 'London' | 'New York' | 'Other';
  created_at: string;
}

export interface PsychologyLog {
  id: string;
  user_id: string;
  date: string;
  mood: string;
  pre_session_notes: string;
  post_session_notes: string;
  mindset_score: number;
  created_at: string;
}

export interface PlaybookEntry {
  id: string;
  user_id: string;
  setup_name: string;
  description: string;
  rules: string;
  ideal_conditions: string;
  screenshot_url: string;
  created_at: string;
}

export interface JournalEntry {
  id: string;
  user_id: string;
  date: string;
  content: string;
  screenshots: string[];
  mood?: string | null;
  created_at: string;
}

export interface RiskSettings {
  id: string;
  user_id: string;
  daily_loss_limit: number;
  max_trades_per_day: number;
  max_contracts_per_trade: number;
  account_size: number;
  risk_percentage: number;
  updated_at: string;
}

export interface AuthenticatedRequest extends Request {
  userId?: string;
  authUser?: User;
}

export interface ExtractedTradeData {
  symbol: string | null;
  direction: 'Long' | 'Short' | null;
  entry_price: number | null;
  entry_time: string | null;
  close_time?: string | null;
  entry_time_confidence: 'high' | 'medium' | 'low' | null;
  sl_price: number | null;
  tp_price: number | null;
  trade_length_seconds: number | null;
  candle_count: number | null;
  timeframe_minutes: number | null;
  exit_reason: 'TP' | 'SL' | null;
  pnl_result: 'Win' | 'Loss' | null;
  exit_confidence: 'high' | 'medium' | 'low' | null;
  first_touch_candle_index: number | null;
  first_touch_evidence: string | null;
  warnings?: string[];
}
