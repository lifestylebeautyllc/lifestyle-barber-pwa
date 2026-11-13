-- Phase 7 Pre-Cutover Step 1: Anti-Hacker RLS Lockdown & Secure Booking RPC

-- 1. Create SECURITY DEFINER RPC for public client appointment booking
CREATE OR REPLACE FUNCTION public.book_client_appointment(
  p_name TEXT,
  p_phone TEXT,
  p_barber_id UUID,
  p_service_id UUID,
  p_appointment_date DATE,
  p_start_time TIME,
  p_end_time TIME,
  p_notes TEXT DEFAULT NULL,
  p_is_walk_in BOOLEAN DEFAULT false
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone TEXT;
  v_name TEXT;
  v_notes TEXT;
  v_client_id UUID;
  v_daily_count INTEGER;
  v_has_overlap BOOLEAN;
  v_appt_id UUID;
BEGIN
  v_name := btrim(COALESCE(p_name, ''));
  IF length(v_name) = 0 THEN
    RAISE EXCEPTION 'Client name is required.';
  END IF;

  -- Normalize phone to a 10-digit string (strip non-digits, strip leading 1 if 11 digits)
  v_phone := regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g');
  IF length(v_phone) = 11 AND left(v_phone, 1) = '1' THEN
    v_phone := substring(v_phone FROM 2);
  END IF;
  IF length(v_phone) <> 10 OR v_phone = '0000000000' THEN
    RAISE EXCEPTION 'A valid 10-digit phone number is required.';
  END IF;

  IF p_end_time <= p_start_time THEN
    RAISE EXCEPTION 'Invalid appointment time range.';
  END IF;

  -- Rate-Limit Guard: Max 3 non-cancelled bookings per day for this phone number
  SELECT COUNT(*)
  INTO v_daily_count
  FROM public.appointments a
  JOIN public.clients c ON c.id = a.client_id
  WHERE c.phone = v_phone
    AND a.appointment_date = p_appointment_date
    AND COALESCE(a.status, 'booked') <> 'cancelled';

  IF v_daily_count >= 3 THEN
    RAISE EXCEPTION 'Rate limit reached: Maximum 3 bookings per day for this phone number.';
  END IF;

  -- Slot Overlap Guard: Prevent double booking
  SELECT EXISTS (
    SELECT 1
    FROM public.appointments a
    WHERE a.barber_id = p_barber_id
      AND a.appointment_date = p_appointment_date
      AND COALESCE(a.status, 'booked') <> 'cancelled'
      AND p_start_time < a.end_time
      AND p_end_time > a.start_time
  ) INTO v_has_overlap;

  IF v_has_overlap THEN
    RAISE EXCEPTION 'This time slot was just taken. Please select another time.';
  END IF;

  -- Upsert client on normalized 10-digit phone, preserving existing non-empty clients.notes
  v_notes := NULLIF(btrim(COALESCE(p_notes, '')), '');

  INSERT INTO public.clients (name, phone, notes)
  VALUES (v_name, v_phone, v_notes)
  ON CONFLICT (phone) DO UPDATE
  SET
    name = EXCLUDED.name,
    notes = CASE
      WHEN NULLIF(btrim(COALESCE(public.clients.notes, '')), '') IS NOT NULL THEN public.clients.notes
      ELSE COALESCE(EXCLUDED.notes, public.clients.notes)
    END
  RETURNING id INTO v_client_id;

  -- Insert appointment and return id
  INSERT INTO public.appointments (
    barber_id,
    client_id,
    service_id,
    appointment_date,
    start_time,
    end_time,
    status,
    walk_in,
    is_blockout,
    notes
  ) VALUES (
    p_barber_id,
    v_client_id,
    p_service_id,
    p_appointment_date,
    p_start_time,
    p_end_time,
    CASE WHEN p_is_walk_in THEN 'walk-in' ELSE 'booked' END,
    p_is_walk_in,
    false,
    v_notes
  )
  RETURNING id INTO v_appt_id;

  RETURN v_appt_id;
END;
$$;

REVOKE ALL ON FUNCTION public.book_client_appointment(TEXT, TEXT, UUID, UUID, DATE, TIME, TIME, TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.book_client_appointment(TEXT, TEXT, UUID, UUID, DATE, TIME, TIME, TEXT, BOOLEAN) TO anon, authenticated;

-- 2. Lock down public.clients RLS strictly to authenticated users
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'clients'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.clients', pol.policyname);
  END LOOP;
END;
$$;

CREATE POLICY "Authenticated select clients"
  ON public.clients FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated insert clients"
  ON public.clients FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated update clients"
  ON public.clients FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated delete clients"
  ON public.clients FOR DELETE
  TO authenticated
  USING (true);

-- 3. Lock down public.appointments RLS (anon SELECT for slot math; writes strictly authenticated)
ALTER TABLE public.appointments ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'appointments'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.appointments', pol.policyname);
  END LOOP;
END;
$$;

CREATE POLICY "Public read appointments for slot availability"
  ON public.appointments FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "Authenticated insert appointments"
  ON public.appointments FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated update appointments"
  ON public.appointments FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated delete appointments"
  ON public.appointments FOR DELETE
  TO authenticated
  USING (true);
