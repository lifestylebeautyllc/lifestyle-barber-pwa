-- 1. Create Core Tables
CREATE TABLE barbers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    role TEXT NOT NULL, -- 'owner', 'full-time', 'part-time'
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

CREATE TABLE services (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL,
    price NUMERIC(5,2) NOT NULL,
    is_active BOOLEAN DEFAULT true
);

CREATE TABLE weekly_schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    barber_id UUID REFERENCES barbers(id) ON DELETE CASCADE,
    day_of_week INTEGER NOT NULL, -- 0 (Sunday) to 6 (Saturday)
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    break_start TIME,
    break_end TIME,
    UNIQUE(barber_id, day_of_week)
);

CREATE TABLE schedule_overrides (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    barber_id UUID REFERENCES barbers(id) ON DELETE CASCADE,
    override_date DATE NOT NULL,
    start_time TIME,
    end_time TIME,
    is_off BOOLEAN DEFAULT false, -- For vacations or sick days
    UNIQUE(barber_id, override_date)
);

CREATE TABLE clients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    phone TEXT UNIQUE NOT NULL,
    cut_notes TEXT, -- Persistent notes (guard sizes, fade styles)
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

CREATE TABLE appointments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
    barber_id UUID REFERENCES barbers(id) ON DELETE CASCADE,
    service_id UUID REFERENCES services(id),
    appointment_date DATE NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    status TEXT DEFAULT 'booked', -- 'booked', 'cancelled', 'completed', 'no-show'
    walk_in BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

CREATE TABLE reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    appointment_id UUID REFERENCES appointments(id) ON DELETE CASCADE,
    client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
    barber_id UUID REFERENCES barbers(id) ON DELETE CASCADE,
    rating INTEGER CHECK (rating >= 1 AND rating <= 5),
    comment TEXT,
    is_verified BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

-- 2. Insert Initial Shop Roster (Seed Data)
INSERT INTO barbers (name, role) VALUES
    ('Michael', 'owner'),
    ('Matt', 'full-time'),
    ('Flor', 'part-time');

-- 3. Enable Row-Level Security (RLS)
ALTER TABLE barbers ENABLE ROW LEVEL SECURITY;
ALTER TABLE services ENABLE ROW LEVEL SECURITY;
ALTER TABLE weekly_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;

-- 4. Set Public Read Access (Clients need to see bios, prices, open slots, and reviews)
CREATE POLICY "Public read access for active barbers" ON barbers FOR SELECT USING (is_active = true);
CREATE POLICY "Public read access for active services" ON services FOR SELECT USING (is_active = true);
CREATE POLICY "Public read access for schedules" ON weekly_schedules FOR SELECT USING (true);
CREATE POLICY "Public read access for overrides" ON schedule_overrides FOR SELECT USING (true);
CREATE POLICY "Public read access for verified reviews" ON reviews FOR SELECT USING (is_verified = true);

-- 5. Set Booking & Admin Rules (Clients can insert appointments/clients; further lockdown happens in Phase 5 via Auth)
CREATE POLICY "Anyone can create a client profile during booking" ON clients FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can book an open slot" ON appointments FOR INSERT WITH CHECK (true);