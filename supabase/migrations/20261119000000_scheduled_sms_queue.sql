-- Quiet-Hours Scheduled SMS Queue & 15-Minute pg_cron Flush Job

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE TABLE IF NOT EXISTS public.scheduled_sms_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  to_phone TEXT NOT NULL,
  message TEXT NOT NULL,
  send_after TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
  appointment_id UUID REFERENCES public.appointments(id) ON DELETE SET NULL,
  error_message TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_sms_queue_pending
  ON public.scheduled_sms_queue (send_after)
  WHERE status = 'pending';

ALTER TABLE public.scheduled_sms_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated select scheduled_sms_queue" ON public.scheduled_sms_queue;
CREATE POLICY "Authenticated select scheduled_sms_queue"
  ON public.scheduled_sms_queue FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Authenticated insert scheduled_sms_queue" ON public.scheduled_sms_queue;
CREATE POLICY "Authenticated insert scheduled_sms_queue"
  ON public.scheduled_sms_queue FOR INSERT
  TO authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS "Authenticated update scheduled_sms_queue" ON public.scheduled_sms_queue;
CREATE POLICY "Authenticated update scheduled_sms_queue"
  ON public.scheduled_sms_queue FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- Schedule 15-minute pg_cron job to flush pending scheduled SMS messages via pg_net
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'flush-scheduled-sms-queue'
  ) THEN
    PERFORM cron.unschedule('flush-scheduled-sms-queue');
  END IF;
END
$$;

SELECT cron.schedule(
  'flush-scheduled-sms-queue',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://ovwyzblznvojykqjhspu.supabase.co/functions/v1/twilio-sms',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"action": "flush_queue"}'::jsonb
  );
  $$
);
