-- Migration 013: Add video rendering columns to session_segments
-- Supports on-demand MP4 rendering from rrweb events

ALTER TABLE platform.session_segments
  ADD COLUMN IF NOT EXISTS video_url TEXT,
  ADD COLUMN IF NOT EXISTS video_status TEXT DEFAULT NULL
    CHECK (video_status IN ('pending', 'rendering', 'ready', 'failed'));
