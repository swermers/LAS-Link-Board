-- ═══════════════════════════════════════════════════════════════════
-- VoiceNotes & Transport Requests — Supabase Table & RLS Setup
-- Run this in your Supabase SQL Editor (Dashboard > SQL Editor > New query)
-- ═══════════════════════════════════════════════════════════════════

-- ─── 1. To-Do Categories ───
-- User-defined categories for organizing voice note to-do items.

CREATE TABLE IF NOT EXISTS todo_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'General',
  color TEXT NOT NULL DEFAULT '#13507C',   -- hex color for visual tagging
  icon TEXT DEFAULT 'folder',              -- optional icon identifier
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_todo_categories_user_id
  ON todo_categories(user_id);

ALTER TABLE todo_categories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own todo categories" ON todo_categories;
CREATE POLICY "Users can view own todo categories" ON todo_categories
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own todo categories" ON todo_categories;
CREATE POLICY "Users can insert own todo categories" ON todo_categories
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own todo categories" ON todo_categories;
CREATE POLICY "Users can update own todo categories" ON todo_categories
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own todo categories" ON todo_categories;
CREATE POLICY "Users can delete own todo categories" ON todo_categories
  FOR DELETE USING (auth.uid() = user_id);


-- ─── 2. Voice Notes (To-Do Items) ───
-- Each voice recording becomes a to-do item with transcription and category.

CREATE TABLE IF NOT EXISTS voice_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category_id UUID REFERENCES todo_categories(id) ON DELETE SET NULL,
  transcript TEXT NOT NULL DEFAULT '',
  title TEXT DEFAULT '',                       -- short summary / first line
  status TEXT NOT NULL DEFAULT 'pending',      -- 'pending' | 'in_progress' | 'completed' | 'archived'
  priority TEXT DEFAULT 'normal',              -- 'low' | 'normal' | 'high' | 'urgent'
  due_date TIMESTAMPTZ,
  duration_seconds INT DEFAULT 0,              -- recording duration
    tagged_student TEXT DEFAULT '',               -- student name tagged from Orah
  tagged_student_id TEXT DEFAULT '',            -- Orah student ID reference
  transport_request_id UUID,                   -- linked transport request (if generated)
  metadata JSONB DEFAULT '{}',                 -- extensible: { aura_data, original_audio_url, ... }
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_voice_notes_user_id
  ON voice_notes(user_id);

CREATE INDEX IF NOT EXISTS idx_voice_notes_category
  ON voice_notes(user_id, category_id);

CREATE INDEX IF NOT EXISTS idx_voice_notes_status
  ON voice_notes(user_id, status);

ALTER TABLE voice_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own voice notes" ON voice_notes;
CREATE POLICY "Users can view own voice notes" ON voice_notes
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own voice notes" ON voice_notes;
CREATE POLICY "Users can insert own voice notes" ON voice_notes
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own voice notes" ON voice_notes;
CREATE POLICY "Users can update own voice notes" ON voice_notes
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own voice notes" ON voice_notes;
CREATE POLICY "Users can delete own voice notes" ON voice_notes
  FOR DELETE USING (auth.uid() = user_id);


-- ─── 3. Transport Requests ───
-- Generated from voice notes, can be sent via email/Sheets.

CREATE TABLE IF NOT EXISTS transport_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  voice_note_id UUID REFERENCES voice_notes(id) ON DELETE SET NULL,

  -- Student info (from Orah or manual entry)
  student_name TEXT NOT NULL DEFAULT '',
  student_id TEXT DEFAULT '',                  -- Orah student ID
  student_house TEXT DEFAULT '',               -- boarding house
  student_year TEXT DEFAULT '',                -- year/grade

  -- Transport details
  destination TEXT NOT NULL DEFAULT '',
  pickup_location TEXT DEFAULT '',
  appointment_type TEXT DEFAULT '',            -- 'medical' | 'dental' | 'specialist' | 'other'
  appointment_details TEXT DEFAULT '',
  date_time TIMESTAMPTZ,
  return_time TIMESTAMPTZ,
  special_instructions TEXT DEFAULT '',

  -- Status tracking
  status TEXT NOT NULL DEFAULT 'draft',        -- 'draft' | 'submitted' | 'approved' | 'completed' | 'cancelled'
  submitted_at TIMESTAMPTZ,
  submitted_to TEXT DEFAULT '',                -- email address or 'google_sheets'
  response_notes TEXT DEFAULT '',

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transport_requests_user_id
  ON transport_requests(user_id);

CREATE INDEX IF NOT EXISTS idx_transport_requests_status
  ON transport_requests(user_id, status);

ALTER TABLE transport_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own transport requests" ON transport_requests;
CREATE POLICY "Users can view own transport requests" ON transport_requests
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own transport requests" ON transport_requests;
CREATE POLICY "Users can insert own transport requests" ON transport_requests
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own transport requests" ON transport_requests;
CREATE POLICY "Users can update own transport requests" ON transport_requests
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own transport requests" ON transport_requests;
CREATE POLICY "Users can delete own transport requests" ON transport_requests
  FOR DELETE USING (auth.uid() = user_id);


-- ─── 4. Orah Integration Settings ───
-- Stores per-user Orah API credentials and config.

CREATE TABLE IF NOT EXISTS orah_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  orah_region TEXT DEFAULT 'https://open-api-ireland.orah.com/open-api',  -- regional API endpoint
  orah_api_key TEXT DEFAULT '',                -- encrypted API key
  school_id TEXT DEFAULT '',                   -- school identifier in Orah
  transport_email TEXT DEFAULT '',             -- default email for transport dept
  google_sheets_id TEXT DEFAULT '',            -- Google Sheets ID for transport log
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_orah_settings_user_id
  ON orah_settings(user_id);

ALTER TABLE orah_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own orah settings" ON orah_settings;
CREATE POLICY "Users can view own orah settings" ON orah_settings
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own orah settings" ON orah_settings;
CREATE POLICY "Users can insert own orah settings" ON orah_settings
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own orah settings" ON orah_settings;
CREATE POLICY "Users can update own orah settings" ON orah_settings
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own orah settings" ON orah_settings;
CREATE POLICY "Users can delete own orah settings" ON orah_settings
  FOR DELETE USING (auth.uid() = user_id);


-- ─── 5. Add FK from voice_notes to transport_requests ───
DO $$ BEGIN
  ALTER TABLE voice_notes
    ADD CONSTRAINT fk_voice_notes_transport_request
    FOREIGN KEY (transport_request_id) REFERENCES transport_requests(id) ON DELETE SET NULL;
EXCEPTION WHEN others THEN NULL;
END $$;
