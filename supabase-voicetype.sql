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
  transcription_mode TEXT DEFAULT 'cloud',  -- 'cloud' or 'local'
  soap_notes BOOLEAN DEFAULT false,
  anthropic_api_key TEXT DEFAULT '',
  anthropic_base_url TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Migration: add new columns if table already exists
DO $$ BEGIN
  ALTER TABLE voicetype_settings ADD COLUMN IF NOT EXISTS transcription_mode TEXT DEFAULT 'cloud';
  ALTER TABLE voicetype_settings ADD COLUMN IF NOT EXISTS soap_notes BOOLEAN DEFAULT false;
  ALTER TABLE voicetype_settings ADD COLUMN IF NOT EXISTS anthropic_api_key TEXT DEFAULT '';
  ALTER TABLE voicetype_settings ADD COLUMN IF NOT EXISTS anthropic_base_url TEXT DEFAULT '';
EXCEPTION WHEN others THEN NULL;
END $$;

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


-- ─── 3. VoiceType Skills ───
-- Reusable output formatting skills. Each skill has a system prompt that
-- reshapes raw transcriptions into a specific voice/format (email, clinical
-- note, chat message, etc.). Users get auto-generated presets they can
-- customize, plus the ability to create their own.

CREATE TABLE IF NOT EXISTS voicetype_skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Untitled Skill',
  category TEXT NOT NULL DEFAULT 'custom',           -- 'email' | 'clinical' | 'chat' | 'raw' | 'custom'
  system_prompt TEXT NOT NULL DEFAULT '',
  trigger_phrases TEXT[] DEFAULT '{}',               -- e.g. {"writing an email", "email to"} for auto-detect
  is_default BOOLEAN DEFAULT false,                  -- user's quick-select default skill
  is_preset BOOLEAN DEFAULT false,                   -- true = auto-generated preset (can be cloned/edited)
  use_count INT DEFAULT 0,                           -- self-learning: tracks how often this skill is used
  style_examples JSONB DEFAULT '[]',                 -- self-learning: stores good output examples [{input, output}]
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_voicetype_skills_user_id
  ON voicetype_skills(user_id);

ALTER TABLE voicetype_skills ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own voicetype skills" ON voicetype_skills;
CREATE POLICY "Users can view own voicetype skills" ON voicetype_skills
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own voicetype skills" ON voicetype_skills;
CREATE POLICY "Users can insert own voicetype skills" ON voicetype_skills
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own voicetype skills" ON voicetype_skills;
CREATE POLICY "Users can update own voicetype skills" ON voicetype_skills
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own voicetype skills" ON voicetype_skills;
CREATE POLICY "Users can delete own voicetype skills" ON voicetype_skills
  FOR DELETE USING (auth.uid() = user_id);


-- ─── 4. Migration: add active_skill_id to settings ───
-- Replaces the boolean soap_notes column with a foreign key to the active skill.

DO $$ BEGIN
  ALTER TABLE voicetype_settings ADD COLUMN IF NOT EXISTS active_skill_id UUID REFERENCES voicetype_skills(id) ON DELETE SET NULL;
EXCEPTION WHEN others THEN NULL;
END $$;

-- ─── 5. Add skill_id to usage logs for per-skill analytics ───

DO $$ BEGIN
  ALTER TABLE voicetype_usage ADD COLUMN IF NOT EXISTS skill_id UUID REFERENCES voicetype_skills(id) ON DELETE SET NULL;
  ALTER TABLE voicetype_usage ADD COLUMN IF NOT EXISTS skill_name TEXT DEFAULT '';
EXCEPTION WHEN others THEN NULL;
END $$;
