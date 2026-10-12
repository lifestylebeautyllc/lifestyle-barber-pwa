-- Allow updates on appointments (for rescheduling, cancellation, no-shows)
CREATE POLICY "Allow update for appointments" ON appointments FOR UPDATE USING (true) WITH CHECK (true);

-- Allow updates on barbers (for working_hours)
CREATE POLICY "Allow update for barbers" ON barbers FOR UPDATE USING (true) WITH CHECK (true);

-- Allow insert/update/delete on schedule_overrides
CREATE POLICY "Allow insert for schedule_overrides" ON schedule_overrides FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow update for schedule_overrides" ON schedule_overrides FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "Allow delete for schedule_overrides" ON schedule_overrides FOR DELETE USING (true);
