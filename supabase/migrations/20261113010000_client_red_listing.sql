-- Add Red-Listing & No-Show tracking columns to public.clients
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS is_red_listed BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS red_listed_by TEXT,
  ADD COLUMN IF NOT EXISTS red_listed_reason TEXT,
  ADD COLUMN IF NOT EXISTS no_show_count INTEGER NOT NULL DEFAULT 0;

-- Optional index for fast filtering of red-listed clients in Admin CRM
CREATE INDEX IF NOT EXISTS idx_clients_is_red_listed
  ON public.clients (is_red_listed)
  WHERE is_red_listed = true;
