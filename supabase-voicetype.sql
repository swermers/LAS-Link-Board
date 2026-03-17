-- ═══════════════════════════════════════════════════════════════════
-- VoiceType — Supabase Table & RLS Setup
-- Run this in your Supabase SQL Editor (Dashboard > SQL Editor > New query)
-- ═══════════════════════════════════════════════════════════════════

-- ─── 1. VoiceType Settings ───
-- One row per user. Stores API key, hotkey, language, and preferences.

CREATE TABLE IF NOT EXISTS voicetype_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  openai_api_key TEXT DEFAULT '',
  hotkey TEXT DEFAULT 'CommandOrControl+Shift+Space',
  language TEXT DEFAULT 'en',
  auto_submit BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_voicetype_settings_user_id
  ON voicetype_settings(user_id);

ALTER TABLE voicetype_settings ENABLE ROW LEVEL SECURITY;

-- Users can only access their own settings
DROP POLICY IF EXISTS "Users can view own voicetype settings" ON voicetype_settings;
CREATE POLICY "Users can view own voicetype settings" ON voicetype_settings
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own voicetype settings" ON voicetype_settings;
CREATE POLICY "Users can insert own voicetype settings" ON voicetype_settings
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own voicetype settings" ON voicetype_settings;
CREATE POLICY "Users can update own voicetype settings" ON voicetype_settings
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own voicetype settings" ON voicetype_settings;
CREATE POLICY "Users can delete own voicetype settings" ON voicetype_settings
  FOR DELETE USING (auth.uid() = user_id);


-- ─── 2. VoiceType Usage Logs ───
-- One row per transcription. Tracks duration and cost for usage dashboard.

CREATE TABLE IF NOT EXISTS voicetype_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  duration_seconds INT NOT NULL DEFAULT 0,
  cost_usd NUMERIC(8,6) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_voicetype_usage_user_id
  ON voicetype_usage(user_id);

CREATE INDEX IF NOT EXISTS idx_voicetype_usage_created
  ON voicetype_usage(user_id, created_at DESC);

ALTER TABLE voicetype_usage ENABLE ROW LEVEL SECURITY;

-- Users can only view their own usage
DROP POLICY IF EXISTS "Users can view own voicetype usage" ON voicetype_usage;
CREATE POLICY "Users can view own voicetype usage" ON voicetype_usage
  FOR SELECT USING (auth.uid() = user_id);

-- Users can insert their own usage (desktop app logs after each transcription)
DROP POLICY IF EXISTS "Users can insert own voicetype usage" ON voicetype_usage;
CREATE POLICY "Users can insert own voicetype usage" ON voicetype_usage
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Users can delete their own usage data
DROP POLICY IF EXISTS "Users can delete own voicetype usage" ON voicetype_usage;
CREATE POLICY "Users can delete own voicetype usage" ON voicetype_usage
  FOR DELETE USING (auth.uid() = user_id);
