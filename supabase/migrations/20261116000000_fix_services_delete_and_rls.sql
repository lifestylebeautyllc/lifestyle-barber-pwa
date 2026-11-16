-- Fix "Delete Service" persistence in My Services:
-- 1. Ensure authenticated users have full SELECT, INSERT, UPDATE (WITH CHECK true), and DELETE RLS policies on public.services
-- 2. Set appointments.service_id foreign key to ON DELETE SET NULL so deleting a service with past appointments never fails

DROP POLICY IF EXISTS "Allow auth delete services" ON public.services;
CREATE POLICY "Allow auth delete services" ON public.services
  FOR DELETE TO authenticated USING (true);

DROP POLICY IF EXISTS "Allow auth update services" ON public.services;
CREATE POLICY "Allow auth update services" ON public.services
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow auth read all services" ON public.services;
CREATE POLICY "Allow auth read all services" ON public.services
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Allow auth insert services" ON public.services;
CREATE POLICY "Allow auth insert services" ON public.services
  FOR INSERT TO authenticated WITH CHECK (true);

ALTER TABLE public.appointments
  DROP CONSTRAINT IF EXISTS appointments_service_id_fkey;

ALTER TABLE public.appointments
  ADD CONSTRAINT appointments_service_id_fkey
  FOREIGN KEY (service_id)
  REFERENCES public.services(id)
  ON DELETE SET NULL;
