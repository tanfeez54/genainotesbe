-- ============================================================
-- Migration: Add mobile and password_hash to users table
-- Run this in Supabase SQL Editor -> New Query -> Run
-- This will safely add the new columns without dropping data.
-- ============================================================

ALTER TABLE users 
ADD COLUMN IF NOT EXISTS mobile text, 
ADD COLUMN IF NOT EXISTS password_hash text;
