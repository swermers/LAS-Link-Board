-- ═══════════════════════════════════════════════════════════════════
-- Training Pairs — Voice Transcript → Final Note pairs for fine-tuning
-- Run this in your Supabase SQL Editor (Dashboard > SQL Editor > New query)
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS lb_training_pairs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  raw_transcript TEXT NOT NULL,
  final_output TEXT NOT NULL,
  output_type TEXT DEFAULT 'client_note',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_training_pairs_user_id
  ON lb_training_pairs(user_id);

CREATE INDEX IF NOT EXISTS idx_training_pairs_created
  ON lb_training_pairs(user_id, created_at DESC);

ALTER TABLE lb_training_pairs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own training pairs" ON lb_training_pairs;
CREATE POLICY "Users can view own training pairs" ON lb_training_pairs
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own training pairs" ON lb_training_pairs;
CREATE POLICY "Users can insert own training pairs" ON lb_training_pairs
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own training pairs" ON lb_training_pairs;
CREATE POLICY "Users can delete own training pairs" ON lb_training_pairs
  FOR DELETE USING (auth.uid() = user_id);
