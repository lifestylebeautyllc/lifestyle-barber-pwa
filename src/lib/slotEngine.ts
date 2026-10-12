import { supabase } from './supabase'

export type DaySchedule = {
  isWorking: boolean
  start_time: string // "HH:MM"
  end_time: string   // "HH:MM"
}

export type WorkingHoursMap = Record<string | number, DaySchedule>

export const DAYS_OF_WEEK = [
  { index: 0, name: 'Sunday', short: 'Sun' },
  { index: 1, name: 'Monday', short: 'Mon' },
  { index: 2, name: 'Tuesday', short: 'Tue' },
  { index: 3, name: 'Wednesday', short: 'Wed' },
  { index: 4, name: 'Thursday', short: 'Thu' },
  { index: 5, name: 'Friday', short: 'Fri' },
  { index: 6, name: 'Saturday', short: 'Sat' },
] as const

export const DEFAULT_WORKING_HOURS: Record<number, DaySchedule> = {
  0: { isWorking: false, start_time: '09:00', end_time: '17:00' }, // Sunday (Off by default)
  1: { isWorking: true, start_time: '09:00', end_time: '17:00' },  // Monday
  2: { isWorking: true, start_time: '09:00', end_time: '17:00' },  // Tuesday
  3: { isWorking: true, start_time: '09:00', end_time: '17:00' },  // Wednesday
  4: { isWorking: true, start_time: '09:00', end_time: '17:00' },  // Thursday
  5: { isWorking: true, start_time: '09:00', end_time: '17:00' },  // Friday
  6: { isWorking: true, start_time: '09:00', end_time: '17:00' },  // Saturday
}

export function timeToMinutes(time: string): number {
  if (!time) return 0
  const [hours, minutes] = time.trim().split(':').map(Number)
  return (hours || 0) * 60 + (minutes || 0)
}

export function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`
}

export function getDayOfWeekFromDateString(dateStr: string): number {
  if (!dateStr) return 0
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).getDay()
}

export function getBarberDaySchedule(workingHours: any, dayOfWeek: number): DaySchedule | null {
  if (!workingHours) return null
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  const dayName = dayNames[dayOfWeek]
  const dayData = workingHours[dayOfWeek] ?? workingHours[String(dayOfWeek)] ?? workingHours[dayName] ?? workingHours[dayName.toUpperCase()]
  if (!dayData) return null
  return {
    isWorking: dayData.isWorking ?? dayData.is_working ?? true,
    start_time: (dayData.start_time ?? dayData.startTime ?? '09:00').slice(0, 5),
    end_time: (dayData.end_time ?? dayData.endTime ?? '17:00').slice(0, 5),
  }
}

export async function getAvailableSlots(
  barberId: string,
  dateStr: string,
  serviceDurationMinutes: number
): Promise<string[]> {
  const dayOfWeek = getDayOfWeekFromDateString(dateStr)

  // 1. Fetch barber's working_hours JSONB
  const { data: barberData } = await supabase
    .from('barbers')
    .select('working_hours')
    .eq('id', barberId)
    .maybeSingle()

  const daySchedule = getBarberDaySchedule(barberData?.working_hours, dayOfWeek)

  let isWorking = false
  let start = 0
  let end = 0
  let breakStart: number | null = null
  let breakEnd: number | null = null

  if (daySchedule) {
    isWorking = daySchedule.isWorking
    start = timeToMinutes(daySchedule.start_time)
    end = timeToMinutes(daySchedule.end_time)
  } else {
    // Fallback to legacy weekly_schedules table if working_hours JSONB is not yet populated
    const { data: schedule } = await supabase
      .from('weekly_schedules')
      .select('*')
      .eq('barber_id', barberId)
      .eq('day_of_week', dayOfWeek)
      .maybeSingle()

    if (schedule) {
      isWorking = true
      start = timeToMinutes(schedule.start_time)
      end = timeToMinutes(schedule.end_time)
      breakStart = schedule.break_start ? timeToMinutes(schedule.break_start) : null
      breakEnd = schedule.break_end ? timeToMinutes(schedule.break_end) : null
    }
  }

  // 2. Check schedule overrides for specific date
  const { data: override } = await supabase
    .from('schedule_overrides')
    .select('*')
    .eq('barber_id', barberId)
    .eq('override_date', dateStr)
    .maybeSingle()

  if (override) {
    if (override.is_off) return []
    isWorking = true
    if (override.start_time) start = timeToMinutes(override.start_time)
    if (override.end_time) end = timeToMinutes(override.end_time)
  }

  if (!isWorking || end <= start) return []

  // 3. Fetch active appointments for collision prevention
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

  for (let current = start; current + serviceDurationMinutes <= end; current += increment) {
    const slotEnd = current + serviceDurationMinutes
    const hasConflict = blockedIntervals.some(block => current < block.end && slotEnd > block.start)
    if (!hasConflict) availableSlots.push(minutesToTime(current))
  }

  return availableSlots
}