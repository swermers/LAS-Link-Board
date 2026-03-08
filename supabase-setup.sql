-- ═══════════════════════════════════════════════════════════════════
-- LAS LinkBoard — Supabase Table & RLS Setup
-- Run this in your Supabase SQL Editor (Dashboard > SQL Editor > New query)
-- ═══════════════════════════════════════════════════════════════════

-- ─── 1. Create tables (if they don't exist) ───

CREATE TABLE IF NOT EXISTS campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Untitled Campaign',
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS campaign_opens (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_agent TEXT DEFAULT '',
  ip_hash TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS campaign_clicks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  link_url TEXT DEFAULT '',
  clicked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_agent TEXT DEFAULT '',
  ip_hash TEXT DEFAULT ''
);

-- ─── 2. Create indexes for performance ───

CREATE INDEX IF NOT EXISTS idx_campaigns_user_id ON campaigns(user_id);
CREATE INDEX IF NOT EXISTS idx_campaign_opens_campaign_id ON campaign_opens(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_opens_dedup ON campaign_opens(campaign_id, ip_hash, opened_at);
CREATE INDEX IF NOT EXISTS idx_campaign_clicks_campaign_id ON campaign_clicks(campaign_id);

-- ─── 3. Enable RLS on all tables ───

ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_opens ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_clicks ENABLE ROW LEVEL SECURITY;

-- ─── 4. RLS Policies for campaigns ───
-- Users can CRUD their own campaigns. Service role (used by API) bypasses RLS.

DROP POLICY IF EXISTS "Users can view own campaigns" ON campaigns;
CREATE POLICY "Users can view own campaigns" ON campaigns
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own campaigns" ON campaigns;
CREATE POLICY "Users can insert own campaigns" ON campaigns
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own campaigns" ON campaigns;
CREATE POLICY "Users can update own campaigns" ON campaigns
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own campaigns" ON campaigns;
CREATE POLICY "Users can delete own campaigns" ON campaigns
  FOR DELETE USING (auth.uid() = user_id);

-- ─── 5. RLS Policies for campaign_opens ───
-- Server-side tracking uses the service role key (bypasses RLS).
-- Authenticated users can read opens for their own campaigns.

DROP POLICY IF EXISTS "Users can view opens for own campaigns" ON campaign_opens;
CREATE POLICY "Users can view opens for own campaigns" ON campaign_opens
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM campaigns WHERE campaigns.id = campaign_opens.campaign_id
      AND campaigns.user_id = auth.uid()
    )
  );

-- Allow the anon role to insert (fallback if service role key not configured)
DROP POLICY IF EXISTS "Anon can insert opens" ON campaign_opens;
CREATE POLICY "Anon can insert opens" ON campaign_opens
  FOR INSERT WITH CHECK (true);

-- Allow authenticated users to delete opens (for campaign cleanup)
DROP POLICY IF EXISTS "Users can delete opens for own campaigns" ON campaign_opens;
CREATE POLICY "Users can delete opens for own campaigns" ON campaign_opens
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM campaigns WHERE campaigns.id = campaign_opens.campaign_id
      AND campaigns.user_id = auth.uid()
    )
  );

-- ─── 6. RLS Policies for campaign_clicks ───
-- Same pattern as campaign_opens.

DROP POLICY IF EXISTS "Users can view clicks for own campaigns" ON campaign_clicks;
CREATE POLICY "Users can view clicks for own campaigns" ON campaign_clicks
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM campaigns WHERE campaigns.id = campaign_clicks.campaign_id
      AND campaigns.user_id = auth.uid()
    )
  );

-- Allow the anon role to insert (fallback if service role key not configured)
DROP POLICY IF EXISTS "Anon can insert clicks" ON campaign_clicks;
CREATE POLICY "Anon can insert clicks" ON campaign_clicks
  FOR INSERT WITH CHECK (true);

-- Allow authenticated users to delete clicks (for campaign cleanup)
DROP POLICY IF EXISTS "Users can delete clicks for own campaigns" ON campaign_clicks;
CREATE POLICY "Users can delete clicks for own campaigns" ON campaign_clicks
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM campaigns WHERE campaigns.id = campaign_clicks.campaign_id
      AND campaigns.user_id = auth.uid()
    )
  );
