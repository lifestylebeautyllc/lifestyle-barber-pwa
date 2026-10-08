### Source Note Update: Phase 5 Complete

**Status:** Phase 5 (Barber Admin Dashboard) is 100% complete, optimized for
speed, and tested locally.

**1. Authentication, Security & Context Routing:**

- **Module:** `src/pages/admin/AdminDashboard.tsx`
- **Logic:** Implemented Supabase Auth with secure session management. The
  dashboard automatically identifies the logged-in user via their email, checks
  the `barbers` table for a matching `user_email`, and sets them as the default
  active barber upon login.

- **Database Upgrades:** Added a `user_email` column to the `barbers` table.
  Updated Row-Level Security (RLS) policies to explicitly allow `authenticated`
  users to read all client profiles and shop appointments.

**2. Live Calendar Module:**

- Displays a responsive daily lineup filtered by Date and Barber.

- Appointments dynamically render with formatted 12-hour times, client names,
  visual status badges (Booked vs. Manual Block/Walk-In), and 1-tap clickable
  `tel:` links for immediate client contact.

**3. Frictionless Admin Booking Controls:**

- **Manual Booking Modal:** Allows staff to inject appointments into the
  schedule (including client name, phone, service, and exact time slot) directly
  from the admin interface. Utilizes the shared `slotEngine.ts` math to
  definitively prevent double-booking.

- **Express Walk-In Tool (Shop-Wide Auto-Scan):** A high-speed 1-tap booking
  flow designed specifically for in-shop Walk-Ins. Features an "All Available
  Barbers" default state that simultaneously scans you, Matt, and Flor's
  schedules. It dynamically calculates and renders every available time slot
  across the entire shop based on the selected service duration, automatically
  logging the block under a generic "Walk-In" client profile.
