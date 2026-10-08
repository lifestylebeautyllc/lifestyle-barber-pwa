### Source Note Update: Phase 4 Complete

**Status:** Phase 4 (Client Booking & Review Portal) is 100% complete and tested locally.

**1. UI/UX & Styling Finalized:**

* **Kiosk Aesthetic:** Transitioned to a pitch-black premium theme (`--color-brand-900: #000000` and `--color-brand-800: #121212`) with high-contrast text to optimize readability on lobby iPads.
* **Seamless Branding:** Applied a CSS radial gradient mask (`mix-blend-screen` / `mask-image`) to the shop logo, fading its hard edges into the black background for a native-app feel.
* **Kiosk Mode Hook:** Built a top-level "Walk-In / Next Available" button placeholder for future lobby-tablet integration.

**2. Frontend Routing & Component Architecture:**

* `src/App.tsx` configured with React Router.
* **Route `/`:** Loads `BookingWizard.tsx` (Shop roster and Walk-in options).
* **Route `/book/:barberId`:** Loads `BarberCalendar.tsx` (The dynamic step-by-step booking flow).

**3. Booking Flow Logic & PWA Features (`BarberCalendar.tsx`):**

* **Dynamic Service Durations:** The flow strictly requires Service Selection *first*. The selected service's `duration_minutes` is dynamically passed into the Slot Engine to accurately calculate real-time availability blocks.
* **Repeat Client Handling:** The checkout form checks the `clients` table by `phone` number first. If the client exists, it attaches the new appointment to their existing ID. If they do not exist, it creates a new client profile, bypassing duplicate `UNIQUE` constraint errors.
* **Native Calendar Integration:** A custom `.ics` file generator was built using standard Web APIs. The "Add to Calendar" button accurately calculates the end time based on the specific service duration and triggers native iOS/Android calendar prompts.
* **Friendly Formatting:** Database timestamps are successfully parsed into human-readable strings (e.g., "Oct. 3, 2026 at 10:45am").

**4. Slot Engine Polish (`src/lib/slotEngine.ts`):**

* Updated schedule fetching from `.single()` to `.maybeSingle()` to gracefully handle days off (returning empty availability without throwing `406 Not Acceptable` errors).

**5. Database Schema & Security Upgrades:**

* **Schema Update:** Upgraded the `services` table by adding a `barber_id` foreign key (`REFERENCES barbers(id)`), ensuring each stylist has absolute control over their own unique service menu, durations, and pricing.
* **RLS Security Update:** Dropped restrictive default policies and added three specific Row-Level Security (RLS) rules to allow the booking flow to function without a user login:
* `Allow public inserts for clients` (INSERT TO public)
* `Allow public selects for clients` (SELECT TO public) - *Required for the app to instantly read back the new Client ID.*
* `Allow public inserts for appointments` (INSERT TO public)
