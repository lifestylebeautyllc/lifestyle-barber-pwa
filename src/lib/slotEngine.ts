import { supabase } from './supabase'

function timeToMinutes(time: string): number {
    const [hours, minutes] = time.split(':').map(Number)
    return hours * 60 + minutes
}

function minutesToTime(minutes: number): string {
    const h = Math.floor(minutes / 60)
    const m = minutes % 60
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`
}

export async function getAvailableSlots(
    barberId: string,
    dateStr: string,
    serviceDurationMinutes: number
): Promise<string[]> {
    const dateObj = new Date(dateStr)
    const dayOfWeek = dateObj.getUTCDay()

    // FIX: Using .maybeSingle() prevents 406 errors when a barber has no scheduled hours for this day
    const { data: schedule } = await supabase
        .from('weekly_schedules')
        .select('*')
        .eq('barber_id', barberId)
        .eq('day_of_week', dayOfWeek)
        .maybeSingle()

    const { data: override } = await supabase
        .from('schedule_overrides')
        .select('*')
        .eq('barber_id', barberId)
        .eq('override_date', dateStr)
        .maybeSingle()

    let isWorking = !!schedule
    let start = schedule ? timeToMinutes(schedule.start_time) : 0
    let end = schedule ? timeToMinutes(schedule.end_time) : 0
    let breakStart = schedule?.break_start ? timeToMinutes(schedule.break_start) : null
    let breakEnd = schedule?.break_end ? timeToMinutes(schedule.break_end) : null

    if (override) {
        if (override.is_off) return []
        isWorking = true
        if (override.start_time) start = timeToMinutes(override.start_time)
        if (override.end_time) end = timeToMinutes(override.end_time)
    }

    if (!isWorking) return []

    const { data: appointments } = await supabase
        .from('appointments')
        .select('start_time, end_time')
        .eq('barber_id', barberId)
        .eq('appointment_date', dateStr)
        .neq('status', 'cancelled')

    const blockedIntervals = (appointments || []).map(app => ({
        start: timeToMinutes(app.start_time),
        end: timeToMinutes(app.end_time)
    }))

    if (breakStart !== null && breakEnd !== null) {
        blockedIntervals.push({ start: breakStart, end: breakEnd })
    }

    const availableSlots: string[] = []
    const increment = 15

    // Dynamically uses the specific service duration passed in from the UI
    for (let current = start; current + serviceDurationMinutes <= end; current += increment) {
        const slotEnd = current + serviceDurationMinutes
        const hasConflict = blockedIntervals.some(block => current < block.end && slotEnd > block.start)
        if (!hasConflict) availableSlots.push(minutesToTime(current))
    }

    return availableSlots
}