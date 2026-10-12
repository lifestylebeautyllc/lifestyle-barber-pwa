-- Add working_hours JSONB column to barbers table
ALTER TABLE barbers ADD COLUMN IF NOT EXISTS working_hours JSONB;
