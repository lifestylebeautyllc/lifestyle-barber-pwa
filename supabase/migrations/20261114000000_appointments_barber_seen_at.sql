-- Add per-barber unseen notification timestamp to appointments
ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS barber_seen_at TIMESTAMPTZ DEFAULT NULL;

-- Backfill existing appointments so historical bookings do not flood the alert bell
UPDATE public.appointments
SET barber_seen_at = NOW()
WHERE barber_seen_at IS NULL;

-- Partial index for fast per-barber unread booking lookups
CREATE INDEX IF NOT EXISTS idx_appointments_unseen_barber
  ON public.appointments (barber_id)
  WHERE barber_seen_at IS NULL;
