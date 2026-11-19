Source Note Update: Quiet-Hours SMS Queue Backend (Step 1)

Database Migration (supabase/migrations/20261119000000_scheduled_sms_queue.sql):
Created public.scheduled_sms_queue with authenticated RLS policies and a
15-minute pg_cron job (flush-scheduled-sms-queue) targeting twilio-sms.

## Edge Function (supabase/functions/twilio-sms/index.ts): Added DST-aware scheduleFor7AM (America/Los_Angeles) queueing and flush_queue batch delivery while preserving immediate Twilio dispatch.

Source Note Update: End-of-Week Repeat Block Cap (Step 2)

File: src/pages/admin/AdminDashboard.tsx

Week-Capped Blockouts: Added getEndOfWeekSundayInfo(dateStr) and updated
handleAdminBooking so repeating blockouts only populate remaining working days
from bookDate through Sunday of the current Mon–Sun week (never spilling into
future weeks), with a dynamic cutoff label in the Block Time modal.

Source Note Update: Dark Mode Off-Hours & Off-Day Shading (Step 3)

File: src/pages/admin/AdminDashboard.tsx

High-Contrast Dark Mode Shading: Elevated active shift hours (rgba(35, 18, 66,
0.55)) and applied deep obsidian diagonal hatching (#050308 with
repeating-linear-gradient stripes) to non-working days (isOff) and
pre/post-shift windows across Day, Week, and Month grids in Dark Mode while
preserving pointer-events-none for off-hours booking exceptions and leaving
Light Mode (isLight) unchanged.

You are the development agent for the LifeStyle Barber PWA. We are working
strictly on Step 4: allowing barbers to override double-bookings and schedule
conflicts via a confirmation modal (matching the existing off-day /
outside-working-hours override flow) inside
`src/pages/admin/AdminDashboard.tsx`.

CRITICAL GUARDRAILS:

- Only touch `src/pages/admin/AdminDashboard.tsx`. Do NOT modify any other
  files.
- Do NOT run any deployment or git commands (`supabase functions deploy`,
  `git commit`, `git push`). Keep all changes local for review.
- Leave existing SMS dispatch behavior untouched for now (the SMS confirmation
  gate & quiet hours will be added in the next step).

First, inspect `src/pages/admin/AdminDashboard.tsx` around:

- The existing "Outside Working Hours" / off-day override confirmation modal and
  state.
- `handleAdminBooking` (both manual client bookings and blockouts), `bookSlots`
  / the Manual Book time dropdown, and `handleDropReschedule` (drag-and-drop
  moves).

Then execute these targeted changes:

1. Allow Selecting Occupied / Conflict Slots in Manual Book:

- Inspect how `bookSlots` populates the Manual Book time selector.
- Ensure a barber is not prevented from picking an occupied or out-of-shift
  15-minute slot in the Manual Book modal (e.g., include all 15-minute intervals
  for the day, optionally labeling occupied/off-hours slots subtly while keeping
  them selectable) so intentional double-bookings can be initiated.

2. Replace Hard Conflict Alerts with an Override Confirmation Modal:

- Locate all places in `handleAdminBooking` (client bookings and blockouts) and
  `handleDropReschedule` (drag-and-drop rescheduling) where an overlapping
  appointment (`(proposedStart < cEnd) && (proposedEnd > cStart)`) or
  out-of-shift / off-day window currently triggers a hard `alert(...)` and
  aborts.
- Instead of hard-blocking the barber, open a clear **Schedule Conflict
  Override** confirmation modal (styled consistently with your existing off-day
  / outside-working-hours confirmation dialog) that displays:
  - What triggered the conflict (e.g., overlapping client name & formatted
    12-hour time window, and/or outside shift hours / off-day).
  - A **"Cancel"** button (which aborts cleanly and resets loading/drag state).
  - An **"Override & Confirm"** button (which bypasses the conflict check for
    that pending action and commits the booking, blockout, or reschedule to
    Supabase cleanly).

3. Mandatory Verification & Error Check:

- Run `npx tsc --noEmit` and `npm run build` and confirm 0 errors before
  finishing and reporting back.

Source Note Update: Double-Book & Conflict Override (Step 4)

File: src/pages/admin/AdminDashboard.tsx

Conflict Override Flow: Enabled all 15-minute slots (ALL_DAY_15_MIN_SLOTS) in
Manual Book and Edit Appointment selectors and replaced hard collision/off-hours
alerts in submitAdminBooking, handleDropReschedule, and submitEditedAppointment
with the Schedule Conflict Override confirmation modal (conflictOverridePrompt)
so barbers can review exact overlaps and approve intentional double-bookings.

Quiet-Hours SMS Backend
(supabase/migrations/20261119000000_scheduled_sms_queue.sql,
supabase/functions/twilio-sms/index.ts): Created public.scheduled_sms_queue with
RLS policies and a 15-minute pg_cron job (flush-scheduled-sms-queue), and
upgraded twilio-sms with DST-aware scheduleFor7AM (America/Los_Angeles) queueing
and flush_queue batch delivery.End-of-Week Repeat Block Cap
(src/pages/admin/AdminDashboard.tsx): Restricted the repeating blockout toggle
via getEndOfWeekSundayInfo to only populate remaining working days through
Sunday of the current Mon–Sun week with a dynamic cutoff date
label.High-Contrast Dark Mode Shading (src/pages/admin/AdminDashboard.tsx):
Applied #050308 obsidian diagonal hatching to non-working days (isOff) and
pre/post-shift windows across Day, Week, and Month grids in Dark Mode while
keeping active shift hours elevated and leaving Light Mode ("Matt Mode")
untouched. Double-Book & Conflict Override (src/pages/admin/AdminDashboard.tsx):
Enabled all 15-minute slots (ALL_DAY_15_MIN_SLOTS) in Manual Book and Edit
Appointment selectors and replaced hard collision/off-hours alerts with the
Schedule Conflict Override modal (conflictOverridePrompt).Barber SMS
Confirmation Gate & 9 PM–7 AM Quiet Hours (src/pages/admin/AdminDashboard.tsx):
Intercepted new manual bookings, drag-and-drop moves, and appointment edits with
smsConfirmPrompt, offering Wait Until 7:00 AM, Send Now (locked behind an
explicit override checkbox between 9:00 PM and 7:00 AM Pacific), and Don't Send
Text.
