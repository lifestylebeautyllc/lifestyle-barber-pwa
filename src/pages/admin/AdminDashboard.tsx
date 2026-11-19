import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { Shield, LogOut, Calendar, Users, Settings, ArrowLeft, Phone, User, Plus, X, Lock, Zap, Scissors, Edit, Save, SlidersHorizontal, ChevronLeft, ChevronRight, MessageSquare, UserX, Trash2, FileText, Clock, Ban, Search, Upload, Download, Flag, AlertTriangle, History, CheckCircle2, Sun, Moon, ExternalLink, Delete, Bell } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { getAvailableSlots, getBarberDaySchedule, minutesToTime, DAYS_OF_WEEK, DEFAULT_WORKING_HOURS, type DaySchedule } from '../../lib/slotEngine'

export interface Client {
  id: string
  name: string
  phone: string
  notes?: string | null
  is_red_listed?: boolean
  red_listed_by?: string | null
  red_listed_reason?: string | null
  no_show_count?: number
  created_at?: string
}

const SHOP_AUTH_EMAIL = 'm.angelocantu@gmail.com'
const ACTIVE_BARBER_STORAGE_KEY = 'lifestyle_active_barber_id'
const PIN_ATTEMPTS_STORAGE_KEY = 'lifestyle_pin_attempts'
const PIN_LOCK_STORAGE_KEY = 'lifestyle_pin_lock_until'
const MAX_PIN_ATTEMPTS = 5
const PIN_COOLDOWN_MS = 60_000

// --- HELPER FUNCTIONS ---
function cleanPhone(raw: string): string {
  const digits = (raw || '').replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('1')) {
    return digits.slice(1)
  }
  if (digits.length > 10) {
    return digits.slice(-10)
  }
  return digits
}

function formatPhoneNumber(phone: string): string {
  if (!phone) return ''
  const cleaned = cleanPhone(phone)
  if (cleaned.length === 10) {
    return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6)}`
  }
  return phone
}

function getFriendlyFirstName(name?: string | null): string {
  const firstWord = (name || '').trim().split(/\s+/)[0] || ''
  if (!firstWord || firstWord.toLowerCase().startsWith('unknown') || firstWord.includes('?')) {
    return 'there'
  }
  return firstWord
}

function buildFeeReminderSmsHref(phone?: string | null, clientName?: string | null, redListedBy?: string | null): string {
  const validPhone = cleanPhone(phone || '')
  if (validPhone.length !== 10 || validPhone === '0000000000') return ''
  const firstName = getFriendlyFirstName(clientName)
  const barber = (redListedBy || '').trim() || 'your barber'
  const body = `Hey ${firstName}, hope you're doing well! I saw you booked on my schedule at LifeStyle Barber. Just a friendly heads up—our system shows a missed appointment with ${barber} that still needs to be squared away before I can get you in my chair. Reach out to ${barber} when you can so we can get you taken care of!`
  return `sms:+1${validPhone}?body=${encodeURIComponent(body)}`
}

function parseCSV(csvText: string): string[][] {
  const rows: string[][] = []
  let currentRow: string[] = []
  let currentCell = ''
  let inQuotes = false

  for (let i = 0; i < csvText.length; i++) {
    const char = csvText[i]
    const nextChar = csvText[i + 1]

    if (inQuotes) {
      if (char === '"' && nextChar === '"') {
        currentCell += '"'
        i++
      } else if (char === '"') {
        inQuotes = false
      } else {
        currentCell += char
      }
    } else {
      if (char === '"') {
        inQuotes = true
      } else if (char === ',') {
        currentRow.push(currentCell.trim())
        currentCell = ''
      } else if (char === '\r' && nextChar === '\n') {
        currentRow.push(currentCell.trim())
        rows.push(currentRow)
        currentRow = []
        currentCell = ''
        i++
      } else if (char === '\n' || char === '\r') {
        currentRow.push(currentCell.trim())
        rows.push(currentRow)
        currentRow = []
        currentCell = ''
      } else {
        currentCell += char
      }
    }
  }
  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell.trim())
    rows.push(currentRow)
  }
  return rows
}

function formatTime(timeStr: string) {
  if (!timeStr) return ''
  const [hours, mins] = timeStr.split(':').map(Number)
  const ampm = hours >= 12 ? 'PM' : 'AM'
  const h = hours % 12 || 12
  return `${h}:${mins.toString().padStart(2, '0')} ${ampm}`
}

function generateMonthMatrix(year: number, month: number) {
  const firstDay = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const matrix: (Date | null)[] = []
  for (let i = 0; i < firstDay; i++) matrix.push(null)
  for (let i = 1; i <= daysInMonth; i++) matrix.push(new Date(year, month, i))
  const remainder = matrix.length % 7
  if (remainder !== 0) {
    for (let i = 0; i < 7 - remainder; i++) matrix.push(null)
  }
  return matrix
}

// --- VAGARO-STYLE TIME-RAIL SETTINGS ---
const CALENDAR_START_HOUR = 0
const CALENDAR_END_HOUR = 24
const PIXELS_PER_HOUR = 120 // Expanded scale: 120px/hr (30px per 15-min slot = exact 2px/min integer ratio)
const PIXELS_PER_MINUTE = PIXELS_PER_HOUR / 60
const TOTAL_HOURS = CALENDAR_END_HOUR - CALENDAR_START_HOUR
const TOTAL_RAIL_HEIGHT = TOTAL_HOURS * PIXELS_PER_HOUR
const SLOT_HEIGHT = PIXELS_PER_HOUR / 4 // 30px
const ALL_DAY_15_MIN_SLOTS = Array.from({ length: 24 * 4 }, (_, i) => minutesToTime(i * 15))

// Parses "HH:MM" or "HH:MM:SS" strictly — no padding, no rounding, no offsets.
function parseTimeParts(timeStr: string): [number, number] {
  const [h, m] = timeStr.trim().split(':')
  return [parseInt(h, 10) || 0, parseInt(m, 10) || 0]
}

function toMinutes(timeStr: string) {
  const [hours, minutes] = parseTimeParts(timeStr)
  return hours * 60 + minutes
}

function timeToPixels(timeStr: string) {
  if (!timeStr) return 0
  const [hours, minutes] = parseTimeParts(timeStr)
  return Math.max(0, ((hours - CALENDAR_START_HOUR) * PIXELS_PER_HOUR) + ((minutes / 60) * PIXELS_PER_HOUR))
}

function formatDisplayDate(dateStr: string) {
  if (!dateStr) return ''
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

type WalkInSlot = { time: string, barberId: string, barberName: string }

export default function AdminDashboard() {
  const [session, setSession] = useState<any>(null)
  const [pin, setPin] = useState('')
  const [isAuthenticating, setIsAuthenticating] = useState(false)
  const [loading, setLoading] = useState(true)
  const [authError, setAuthError] = useState('')
  const [failedPinAttempts, setFailedPinAttempts] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(PIN_ATTEMPTS_STORAGE_KEY)
      return saved ? parseInt(saved, 10) || 0 : 0
    } catch { return 0 }
  })
  const [pinLockUntil, setPinLockUntil] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(PIN_LOCK_STORAGE_KEY)
      const ts = saved ? parseInt(saved, 10) || 0 : 0
      return ts > Date.now() ? ts : 0
    } catch { return 0 }
  })
  const [cooldownSeconds, setCooldownSeconds] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(PIN_LOCK_STORAGE_KEY)
      const ts = saved ? parseInt(saved, 10) || 0 : 0
      return ts > Date.now() ? Math.ceil((ts - Date.now()) / 1000) : 0
    } catch { return 0 }
  })
  const [isLight, setIsLight] = useState<boolean>(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('light')
  )
  const pinInputRef = useRef<HTMLInputElement | null>(null)

  const toggleTheme = () => {
    const nextIsLight = document.documentElement.classList.toggle('light')
    try {
      localStorage.setItem('lifestyle_theme', nextIsLight ? 'light' : 'dark')
    } catch {}
    setIsLight(nextIsLight)
    window.dispatchEvent(new Event('lifestyle-theme-change'))
  }

  const selectActiveBarber = (barberId: string) => {
    setSelectedBarberId(barberId)
    try {
      localStorage.setItem(ACTIVE_BARBER_STORAGE_KEY, barberId)
    } catch {}
  }

  const [activeModule, setActiveModule] = useState<'home' | 'calendar' | 'walkin' | 'clients' | 'services'>('home')
  const [barbers, setBarbers] = useState<any[]>([])
  const [loggedInBarber, setLoggedInBarber] = useState<any>(null)
  const isOwner = loggedInBarber?.role === 'owner'

  // --- CALENDAR & GLOBAL STATE ---
  const [selectedBarberId, setSelectedBarberId] = useState<string>('')
  const [selectedDate, setSelectedDate] = useState(() => {
    const d = new Date()
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
    return d.toISOString().split('T')[0]
  })
  const [appointments, setAppointments] = useState<any[]>([])
  const [loadingAppts, setLoadingAppts] = useState(false)
  const [adminServices, setAdminServices] = useState<any[]>([])
  const [refreshTrigger, setRefreshTrigger] = useState(0)

  const [viewMode, setViewMode] = useState<'month' | 'week' | 'day'>('day')
  const [viewMonthDate, setViewMonthDate] = useState(() => {
    const d = new Date()
    return new Date(d.getFullYear(), d.getMonth(), 1)
  })
  const [viewWeekStartDate, setViewWeekStartDate] = useState(() => {
    const parts = selectedDate.split('-').map(Number)
    const d = new Date(parts[0], parts[1] - 1, parts[2])
    const diff = d.getDate() - d.getDay()
    return new Date(d.setDate(diff))
  })

  const [monthAppointments, setMonthAppointments] = useState<any[]>([])
  const [monthOverrides, setMonthOverrides] = useState<any[]>([])
  const [weekAppointments, setWeekAppointments] = useState<any[]>([])
  const [weekOverrides, setWeekOverrides] = useState<any[]>([])

  // Mobile Touch Drag-and-Drop Rescheduling State
  const [touchDraggedAppt, setTouchDraggedAppt] = useState<any>(null)
  const [touchPos, setTouchPos] = useState<{ x: number, y: number } | null>(null)
  const [hoveredDropSlot, setHoveredDropSlot] = useState<{ date: string, time: string } | null>(null)
  const [isTouchDragging, setIsTouchDragging] = useState(false)
  const [isRescheduling, setIsRescheduling] = useState(false)
  const touchStartRef = useRef<{ clientX: number, clientY: number, appt: any, hasMoved: boolean } | null>(null)
  const isDragActiveRef = useRef(false)
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const justDraggedRef = useRef(false)
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const dayScrollContainerRef = useRef<HTMLDivElement | null>(null)
  const weekScrollContainerRef = useRef<HTMLDivElement | null>(null)
  const calendarSwipeStartRef = useRef<{ x: number; y: number; startedOnAppt: boolean } | null>(null)
  const [calendarSwipeAnim, setCalendarSwipeAnim] = useState<'left' | 'right' | null>(null)
  const calendarSwipeAnimTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // --- MODALS STATE ---
  const [showBookModal, setShowBookModal] = useState(false)
  const [isBlockoutMode, setIsBlockoutMode] = useState(false)
  const [isRepeatingBlockout, setIsRepeatingBlockout] = useState(false)
  const [blockEndTime, setBlockEndTime] = useState('')
  const [bookServices, setBookServices] = useState<any[]>([])
  const [bookDate, setBookDate] = useState(selectedDate)
  const [bookTime, setBookTime] = useState('')
  const [bookSlots, setBookSlots] = useState<string[]>([])
  const [allCollisionFreeSlots, setAllCollisionFreeSlots] = useState<string[]>([])
  const [bookDateOverride, setBookDateOverride] = useState<any | null>(null)
  const [outOfHoursPrompt, setOutOfHoursPrompt] = useState<{ date: string; time: string; isBlockout?: boolean } | null>(null)
  const [conflictOverridePrompt, setConflictOverridePrompt] = useState<{
    title: string
    proposedSummary: string
    reasons: string[]
    onConfirm: () => void
  } | null>(null)
  const [smsConfirmPrompt, setSmsConfirmPrompt] = useState<{
    contextTitle: 'New Booking Text' | 'Appointment Move / Reschedule Text'
    changeSummary: string
    clientName: string
    clientPhone: string
    appointmentId?: string | null
    barberPhone?: string | null
    barberMessage?: string | null
  } | null>(null)
  const [smsConfirmMessage, setSmsConfirmMessage] = useState('')
  const [overrideQuietHoursSendNow, setOverrideQuietHoursSendNow] = useState(false)
  const [isDispatchingConfirmSms, setIsDispatchingConfirmSms] = useState(false)
  const [clientName, setClientName] = useState('')
  const [clientPhone, setClientPhone] = useState('')
  const [bookNotes, setBookNotes] = useState('')
  const [isBooking, setIsBooking] = useState(false)
  const [showExistingClientPicker, setShowExistingClientPicker] = useState(false)
  const [clientSearchQuery, setClientSearchQuery] = useState('')
  const [selectedExistingClient, setSelectedExistingClient] = useState<Client | null>(null)

  const bookTotalDurationMinutes = bookServices.reduce((sum, s) => sum + (Number(s?.duration_minutes) || 0), 0)
  const bookTotalPrice = bookServices.reduce((sum, s) => sum + (Number(s?.price) || 0), 0)

  // Barber Working Hours (Settings) Modal State
  const [showBarberSettingsModal, setShowBarberSettingsModal] = useState(false)
  const [barberWorkingHours, setBarberWorkingHours] = useState<Record<number, DaySchedule>>(DEFAULT_WORKING_HOURS)
  const [barberWeeklySchedules, setBarberWeeklySchedules] = useState<any[]>([])
  const [dayViewOverride, setDayViewOverride] = useState<any | null>(null)
  const [loadingWorkingHours, setLoadingWorkingHours] = useState(false)
  const [isSavingWorkingHours, setIsSavingWorkingHours] = useState(false)

  const [showManageDayModal, setShowManageDayModal] = useState(false)
  const [isDayOff, setIsDayOff] = useState(false)
  const [overrideStart, setOverrideStart] = useState('09:00')
  const [overrideEnd, setOverrideEnd] = useState('17:00')
  const [blockStart, setBlockStart] = useState('')
  const [blockEnd, setBlockEnd] = useState('')
  const [isSavingOverride, setIsSavingOverride] = useState(false)

  // Appointment Details & Edit Modal State
  const [showApptModal, setShowApptModal] = useState(false)
  const [selectedAppt, setSelectedAppt] = useState<any>(null)
  const [clientNotes, setClientNotes] = useState('')
  const [isUpdatingAppt, setIsUpdatingAppt] = useState(false)
  const [editApptMode, setEditApptMode] = useState(false)
  const [editApptDate, setEditApptDate] = useState('')
  const [editApptTime, setEditApptTime] = useState('')
  const [editApptServices, setEditApptServices] = useState<any[]>([])
  const [editApptNotes, setEditApptNotes] = useState('')
  const [editApptRegularSlots, setEditApptRegularSlots] = useState<string[]>([])
  const [editApptAllSlots, setEditApptAllSlots] = useState<string[]>([])

  // Express Walk-In State
  const [walkInBarberId, setWalkInBarberId] = useState<string>('any')
  const [walkInService, setWalkInService] = useState<any>(null)
  const [walkInSlots, setWalkInSlots] = useState<WalkInSlot[]>([])
  const [isExpressBooking, setIsExpressBooking] = useState(false)

  // My Services State
  const [myServices, setMyServices] = useState<any[]>([])
  const [masterServices, setMasterServices] = useState<string[]>([])
  const [newMasterName, setNewMasterName] = useState('')
  const [newServiceName, setNewServiceName] = useState('')
  const [newServiceDuration, setNewServiceDuration] = useState('30')
  const [newServicePrice, setNewServicePrice] = useState('')
  const [isSubmittingService, setIsSubmittingService] = useState(false)
  const [editingServiceId, setEditingServiceId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState({ name: '', duration: '30', price: '' })
  const [confirmDeleteServiceId, setConfirmDeleteServiceId] = useState<string | null>(null)

  // --- CLIENT DIRECTORY CRM & VAGARO CSV IMPORTER STATE ---
  const [clientsList, setClientsList] = useState<Client[]>([])
  const [allAppointmentsByClient, setAllAppointmentsByClient] = useState<Record<string, any[]>>({})
  const [allShopServices, setAllShopServices] = useState<any[]>([])
  const [loadingClients, setLoadingClients] = useState(false)
  const [clientSearch, setClientSearch] = useState('')
  const [showRedListedOnly, setShowRedListedOnly] = useState(false)
  const [visibleClientCount, setVisibleClientCount] = useState(100)
  const csvFileInputRef = useRef<HTMLInputElement>(null)
  const [isImportingCSV, setIsImportingCSV] = useState(false)
  const [csvImportResult, setCsvImportResult] = useState<string | null>(null)
  const [statusBanner, setStatusBanner] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  // Per-Barber New Booking Alert Center State
  const [unseenBookings, setUnseenBookings] = useState<any[]>([])
  const [showAlertsModal, setShowAlertsModal] = useState(false)
  const [acknowledgingId, setAcknowledgingId] = useState<string | null>(null)
  const [clearingAllAlerts, setClearingAllAlerts] = useState(false)

  // Manual Add Client Modal State
  const [showAddClientModal, setShowAddClientModal] = useState(false)
  const [newClientName, setNewClientName] = useState('')
  const [newClientPhone, setNewClientPhone] = useState('')
  const [newClientNotes, setNewClientNotes] = useState('')
  const [isSavingNewClient, setIsSavingNewClient] = useState(false)

  // Client Profile & History Modal State
  const [selectedProfileClient, setSelectedProfileClient] = useState<Client | null>(null)
  const [profileName, setProfileName] = useState('')
  const [profilePhone, setProfilePhone] = useState('')
  const [profileNotes, setProfileNotes] = useState('')
  const [profileAppts, setProfileAppts] = useState<any[]>([])
  const [loadingProfileAppts, setLoadingProfileAppts] = useState(false)
  const [isSavingProfile, setIsSavingProfile] = useState(false)
  const [manualRedListBarber, setManualRedListBarber] = useState('Michael')
  const [manualRedListReason, setManualRedListReason] = useState('')
  const [isUpdatingRedList, setIsUpdatingRedList] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => { setSession(session); setLoading(false) })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => { setSession(session) })
    return () => {
      subscription.unsubscribe()
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const syncTheme = () => {
      setIsLight(document.documentElement.classList.contains('light'))
    }
    window.addEventListener('lifestyle-theme-change', syncTheme)
    window.addEventListener('storage', syncTheme)
    return () => {
      window.removeEventListener('lifestyle-theme-change', syncTheme)
      window.removeEventListener('storage', syncTheme)
    }
  }, [])

  useEffect(() => {
    if (!pinLockUntil) {
      setCooldownSeconds(0)
      return
    }
    const updateRemaining = () => {
      const remaining = Math.ceil((pinLockUntil - Date.now()) / 1000)
      if (remaining <= 0) {
        setPinLockUntil(0)
        setCooldownSeconds(0)
        setFailedPinAttempts(0)
        setAuthError('')
        try {
          localStorage.removeItem(PIN_LOCK_STORAGE_KEY)
          localStorage.setItem(PIN_ATTEMPTS_STORAGE_KEY, '0')
        } catch {}
      } else {
        setCooldownSeconds(remaining)
      }
    }
    updateRemaining()
    const timer = window.setInterval(updateRemaining, 500)
    return () => window.clearInterval(timer)
  }, [pinLockUntil])

  // Aggressively prevent native mobile scrolling while appointment dragging is active
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return

    const preventNativeScroll = (e: TouchEvent) => {
      // If the user has held long enough to unstick the appt, aggressively block scrolling
      if (isDragActiveRef.current) {
        e.preventDefault()
      }
    }

    // The passive: false flag is REQUIRED for e.preventDefault() to work on mobile
    container.addEventListener('touchmove', preventNativeScroll, { passive: false })

    return () => {
      container.removeEventListener('touchmove', preventNativeScroll)
    }
  }, [viewMode, activeModule])

  // Auto-scroll 24-hour calendar timeline to 8:00 AM (960px) on open / view change / barber change
  useEffect(() => {
    if (activeModule !== 'calendar') return
    const targetScrollTop = 8 * PIXELS_PER_HOUR // 960px (8:00 AM at top of viewport)

    const applyScroll = () => {
      if (viewMode === 'day' && dayScrollContainerRef.current) {
        dayScrollContainerRef.current.scrollTop = targetScrollTop
      } else if (viewMode === 'week' && weekScrollContainerRef.current) {
        weekScrollContainerRef.current.scrollTop = targetScrollTop
      }
    }

    applyScroll()
    const rafId = requestAnimationFrame(applyScroll)
    return () => cancelAnimationFrame(rafId)
  }, [activeModule, viewMode, selectedBarberId])

  // Fetch weekly_schedules for selectedBarberId (with fallback to barbers.working_hours)
  useEffect(() => {
    if (!selectedBarberId) return
    let isCancelled = false

    const fetchWeeklyScheduleRows = async () => {
      const { data } = await supabase
        .from('weekly_schedules')
        .select('day_of_week, start_time, end_time')
        .eq('barber_id', selectedBarberId)

      if (isCancelled) return

      if (data && data.length > 0) {
        setBarberWeeklySchedules(data)
      } else {
        // Fallback: synthesize from barber's working_hours JSONB or DEFAULT_WORKING_HOURS
        const activeBarber = barbers.find(b => b.id === selectedBarberId)
        const wh = activeBarber?.working_hours || DEFAULT_WORKING_HOURS
        const fallbackRows = Object.entries(wh)
          .filter(([, cfg]: [string, any]) => Boolean(cfg?.isWorking))
          .map(([dayStr, cfg]: [string, any]) => ({
            day_of_week: Number(dayStr),
            start_time: cfg?.start_time || cfg?.start || '09:00',
            end_time: cfg?.end_time || cfg?.end || '17:00',
          }))
        setBarberWeeklySchedules(fallbackRows)
      }
    }

    fetchWeeklyScheduleRows()
    return () => {
      isCancelled = true
    }
  }, [selectedBarberId, refreshTrigger, barbers])

  // Fetch dayViewOverride for selectedBarberId and selectedDate
  useEffect(() => {
    if (!selectedBarberId || !selectedDate) return
    let isCancelled = false

    const fetchDayOverride = async () => {
      const { data } = await supabase
        .from('schedule_overrides')
        .select('*')
        .eq('barber_id', selectedBarberId)
        .eq('override_date', selectedDate)
        .maybeSingle()

      if (isCancelled) return
      setDayViewOverride(data || null)
      setIsDayOff(data?.is_off || false)
      setOverrideStart(data?.custom_start_time?.slice(0, 5) || '09:00')
      setOverrideEnd(data?.custom_end_time?.slice(0, 5) || '17:00')
    }

    fetchDayOverride()
    return () => {
      isCancelled = true
    }
  }, [selectedBarberId, selectedDate, refreshTrigger])

  // Helper to check if a given YYYY-MM-DD date is a non-working day for the selected barber
  const isNonWorkingDate = (dateStr: string, overridesList: any[]): boolean => {
    // 1. Single Date Override (schedule_overrides)
    const matchingOverride = overridesList?.find((o: any) => o && o.override_date === dateStr)
    if (matchingOverride) {
      return Boolean(matchingOverride.is_off)
    }

    const dayOfWeek = new Date(dateStr + 'T12:00:00Z').getUTCDay()
    const dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dayOfWeek]

    // 2. Barber working_hours JSONB (selectedBarber?.working_hours)
    const selectedBarber = barbers.find(b => b.id === selectedBarberId)
    if (selectedBarber?.working_hours) {
      if (selectedBarber.working_hours[dayName] !== undefined && selectedBarber.working_hours[dayName] !== null) {
        return !Boolean(selectedBarber.working_hours[dayName].isWorking)
      }
      const parsedDay = getBarberDaySchedule(selectedBarber.working_hours, dayOfWeek)
      if (parsedDay) {
        return !parsedDay.isWorking
      }
    }

    // 3. Fallback (weekly_schedules)
    const hasWorkingRow = barberWeeklySchedules.some(
      (row: any) => Number(row.day_of_week) === dayOfWeek
    )
    return !hasWorkingRow
  }

  // Helper to get active working shift start & end minutes for a barber on a given YYYY-MM-DD date (returns null on non-working days)
  const getBarberShiftMins = (barberId: string, dateStr: string): { startMins: number; endMins: number } | null => {
    if (!barberId || !dateStr) return null

    const allKnownOverrides = [
      ...(bookDateOverride && bookDateOverride.override_date === dateStr ? [bookDateOverride] : []),
      ...(dayViewOverride && dayViewOverride.override_date === dateStr ? [dayViewOverride] : []),
      ...weekOverrides,
      ...monthOverrides,
    ]

    if (isNonWorkingDate(dateStr, allKnownOverrides)) {
      return null
    }

    const matchingOverride = allKnownOverrides.find((o: any) => o && o.override_date === dateStr)
    const dayOfWeek = new Date(dateStr + 'T12:00:00Z').getUTCDay()
    const dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dayOfWeek]
    const targetBarber = barbers.find(b => b.id === barberId) || barbers.find(b => b.id === selectedBarberId)

    let shiftStartStr: string | null = null
    let shiftEndStr: string | null = null

    if (matchingOverride && !matchingOverride.is_off && matchingOverride.start_time && matchingOverride.end_time) {
      shiftStartStr = matchingOverride.start_time
      shiftEndStr = matchingOverride.end_time
    } else if (targetBarber?.working_hours?.[dayName]) {
      const whDay = targetBarber.working_hours[dayName]
      shiftStartStr = whDay.start || whDay.start_time || null
      shiftEndStr = whDay.end || whDay.end_time || null
    } else if (targetBarber?.working_hours) {
      const parsedDay = getBarberDaySchedule(targetBarber.working_hours, dayOfWeek)
      if (parsedDay) {
        shiftStartStr = parsedDay.start_time
        shiftEndStr = parsedDay.end_time
      }
    }

    if (!shiftStartStr || !shiftEndStr) {
      const wsRow = barberWeeklySchedules.find((row: any) => Number(row.day_of_week) === dayOfWeek)
      if (wsRow) {
        shiftStartStr = wsRow.start_time
        shiftEndStr = wsRow.end_time
      }
    }

    if (!shiftStartStr || !shiftEndStr) return null

    const startMins = toMinutes(shiftStartStr)
    const endMins = toMinutes(shiftEndStr)
    if (endMins <= startMins) return null

    return { startMins, endMins }
  }

  // Helper to check if a proposed booking slot falls on a scheduled day off or outside the barber's active shift hours
  const isOutsideBarberSchedule = (dateStr: string, startTime24: string, durationMinutes: number): boolean => {
    if (!dateStr || !startTime24) return false

    const shift = getBarberShiftMins(selectedBarberId, dateStr)
    if (!shift) {
      return true
    }

    const startMins = toMinutes(startTime24)
    const endMins = startMins + (Number(durationMinutes) || 30)

    return startMins < shift.startMins || endMins > shift.endMins
  }

  // Gate helper: checks if target date/time is outside working hours before opening Manual Book modal
  const requestOpenBookingModal = (targetDate: string, targetTime = '', overridesHint?: any[]) => {
    setBookServices([])
    setSelectedExistingClient(null)
    setShowExistingClientPicker(false)
    setClientSearchQuery('')
    setIsRepeatingBlockout(false)
    if (targetTime) {
      setBlockEndTime(minutesToTime(toMinutes(targetTime) + 60))
    }

    const effectiveOverrides = overridesHint || [
      ...(dayViewOverride ? [dayViewOverride] : []),
      ...weekOverrides,
      ...monthOverrides,
    ]
    const isDayNonWorking = isNonWorkingDate(targetDate, effectiveOverrides)
    const isSlotOutOfHours = targetTime
      ? isOutsideBarberSchedule(targetDate, targetTime, 30)
      : false

    if (isDayNonWorking || isSlotOutOfHours) {
      setOutOfHoursPrompt({ date: targetDate, time: targetTime, isBlockout: false })
      return
    }

    setBookDate(targetDate)
    setBookTime(targetTime)
    setShowBookModal(true)
  }

  useEffect(() => {
    async function fetchRoster() {
      if (!session) return
      const { data } = await supabase.from('barbers').select('*').eq('is_active', true)
      if (data && data.length > 0) {
        setBarbers(data)
        const currentBarber = data.find(b => b.user_email === session.user.email)
        setLoggedInBarber(currentBarber)
        let savedBarberId: string | null = null
        try {
          savedBarberId = localStorage.getItem(ACTIVE_BARBER_STORAGE_KEY)
        } catch {}
        const validSaved = savedBarberId ? data.find(b => b.id === savedBarberId) : null
        const initialBarberId = validSaved ? validSaved.id : (currentBarber ? currentBarber.id : data[0].id)
        setSelectedBarberId(initialBarberId)
      }
    }
    fetchRoster()
  }, [session])

  useEffect(() => { if (session) supabase.from('master_services').select('name').order('name').then(({data}) => { if(data) setMasterServices(data.map(s => s.name)) }) }, [session])

  useEffect(() => {
    if (selectedBarberId) supabase.from('services').select('*').eq('barber_id', selectedBarberId).eq('is_active', true).then(({ data }) => { if (data) setAdminServices(data) })
  }, [selectedBarberId])

  useEffect(() => {
    async function loadBarberWorkingHours() {
      if (!showBarberSettingsModal || !selectedBarberId) return
      setLoadingWorkingHours(true)
      try {
        const { data, error } = await supabase
          .from('barbers')
          .select('working_hours')
          .eq('id', selectedBarberId)
          .single()

        if (error) throw error

        if (data?.working_hours) {
          const loaded: Record<number, DaySchedule> = { ...DEFAULT_WORKING_HOURS }
          for (let i = 0; i < 7; i++) {
            const sched = getBarberDaySchedule(data.working_hours, i)
            if (sched) loaded[i] = sched
          }
          setBarberWorkingHours(loaded)
        } else {
          setBarberWorkingHours(DEFAULT_WORKING_HOURS)
        }
      } catch (err: any) {
        console.error("Failed to load working hours:", err)
        setBarberWorkingHours(DEFAULT_WORKING_HOURS)
      } finally {
        setLoadingWorkingHours(false)
      }
    }
    loadBarberWorkingHours()
  }, [showBarberSettingsModal, selectedBarberId])

  // --- DATA FETCHERS ---
  const fetchUnseenBookings = async () => {
    if (!session) return
    const { data, error } = await supabase
      .from('appointments')
      .select('id, barber_id, appointment_date, start_time, end_time, notes, created_at, is_blockout, status, clients ( id, name, phone ), services ( id, name, duration_minutes, price )')
      .is('barber_seen_at', null)
      .eq('is_blockout', false)
      .neq('status', 'cancelled')
      .neq('status', 'blocked')
      .order('created_at', { ascending: false })
    if (!error && data) {
      setUnseenBookings(data)
    }
  }

  useEffect(() => {
    if (!session) {
      setUnseenBookings([])
      return
    }
    fetchUnseenBookings()
    const interval = window.setInterval(() => {
      fetchUnseenBookings()
    }, 30_000)
    return () => window.clearInterval(interval)
  }, [session, refreshTrigger])

  useEffect(() => {
    async function fetchLineup() {
      if (!selectedBarberId || activeModule !== 'calendar' || viewMode !== 'day') return
      setLoadingAppts(true)
      const [apptRes, overrideRes] = await Promise.all([
        supabase.from('appointments')
          .select(`id, barber_id, client_id, service_id, appointment_date, start_time, end_time, status, notes, is_blockout, clients ( id, name, phone, notes, is_red_listed, red_listed_by, red_listed_reason, no_show_count ), services ( id, name, duration_minutes, price )`)
          .eq('appointment_date', selectedDate)
          .eq('barber_id', selectedBarberId)
          .neq('status', 'cancelled')
          .order('start_time', { ascending: true }),
        supabase.from('schedule_overrides')
          .select('*')
          .eq('barber_id', selectedBarberId)
          .eq('override_date', selectedDate)
          .maybeSingle()
      ])
      if (!apptRes.error && apptRes.data) setAppointments(apptRes.data)
      if (overrideRes.data) {
        setIsDayOff(overrideRes.data.is_off)
        if (overrideRes.data.start_time) setOverrideStart(overrideRes.data.start_time.slice(0, 5))
        if (overrideRes.data.end_time) setOverrideEnd(overrideRes.data.end_time.slice(0, 5))
      } else {
        setIsDayOff(false)
        setOverrideStart('09:00')
        setOverrideEnd('17:00')
      }
      setLoadingAppts(false)
    }
    fetchLineup()
  }, [selectedBarberId, selectedDate, viewMode, activeModule, refreshTrigger])

  useEffect(() => {
    async function fetchMonthData() {
      if (!selectedBarberId || activeModule !== 'calendar' || viewMode !== 'month') return
      const year = viewMonthDate.getFullYear()
      const month = viewMonthDate.getMonth()
      const startOfMonth = `${year}-${String(month + 1).padStart(2, '0')}-01`
      const endOfMonth = new Date(year, month + 1, 0).toISOString().split('T')[0]

      const [apptRes, overrideRes] = await Promise.all([
        supabase.from('appointments')
          .select('id, barber_id, client_id, service_id, appointment_date, start_time, end_time, status, is_blockout, notes, clients ( id, name, phone, notes, is_red_listed, red_listed_by, red_listed_reason, no_show_count ), services ( id, name, duration_minutes, price )')
          .eq('barber_id', selectedBarberId)
          .gte('appointment_date', startOfMonth)
          .lte('appointment_date', endOfMonth)
          .neq('status', 'cancelled')
          .order('start_time', { ascending: true }),
        supabase.from('schedule_overrides')
          .select('override_date, is_off')
          .eq('barber_id', selectedBarberId)
          .gte('override_date', startOfMonth)
          .lte('override_date', endOfMonth)
      ])
      setMonthAppointments(apptRes.data || [])
      setMonthOverrides(overrideRes.data || [])
    }
    fetchMonthData()
  }, [selectedBarberId, viewMonthDate, activeModule, viewMode, refreshTrigger])

  useEffect(() => {
    async function fetchWeekData() {
      if (!selectedBarberId || activeModule !== 'calendar' || viewMode !== 'week') return
      const startOfWeek = `${viewWeekStartDate.getFullYear()}-${String(viewWeekStartDate.getMonth() + 1).padStart(2, '0')}-${String(viewWeekStartDate.getDate()).padStart(2, '0')}`
      const endOfWeekDate = new Date(viewWeekStartDate)
      endOfWeekDate.setDate(endOfWeekDate.getDate() + 6)
      const endOfWeek = `${endOfWeekDate.getFullYear()}-${String(endOfWeekDate.getMonth() + 1).padStart(2, '0')}-${String(endOfWeekDate.getDate()).padStart(2, '0')}`

      const [apptRes, overrideRes] = await Promise.all([
        supabase.from('appointments').select('id, barber_id, client_id, service_id, appointment_date, start_time, end_time, status, notes, is_blockout, clients ( id, name, phone, notes, is_red_listed, red_listed_by, red_listed_reason, no_show_count ), services ( id, name, duration_minutes, price )').eq('barber_id', selectedBarberId).gte('appointment_date', startOfWeek).lte('appointment_date', endOfWeek).neq('status', 'cancelled').order('start_time', { ascending: true }),
        supabase.from('schedule_overrides').select('override_date, is_off, start_time, end_time').eq('barber_id', selectedBarberId).gte('override_date', startOfWeek).lte('override_date', endOfWeek)
      ])
      setWeekAppointments(apptRes.data || [])
      setWeekOverrides(overrideRes.data || [])
    }
    fetchWeekData()
  }, [selectedBarberId, viewWeekStartDate, activeModule, viewMode, refreshTrigger])

  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
  const dayNamesShort = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

  useEffect(() => {
    const parts = selectedDate.split('-').map(Number)
    const d = new Date(parts[0], parts[1] - 1, parts[2])
    const diff = d.getDate() - d.getDay()
    setViewWeekStartDate(new Date(d.setDate(diff)))
    setViewMonthDate(new Date(parts[0], parts[1] - 1, 1))
  }, [selectedDate])

  const handlePrevMonth = () => setViewMonthDate(prev => new Date(prev.getFullYear(), prev.getMonth() - 1, 1))
  const handleNextMonth = () => setViewMonthDate(prev => new Date(prev.getFullYear(), prev.getMonth() + 1, 1))
  const handlePrevWeek = () => {
    setViewWeekStartDate(prev => { const d = new Date(prev); d.setDate(d.getDate() - 7); return d })
    const parts = selectedDate.split('-').map(Number)
    const cur = new Date(parts[0], parts[1] - 1, parts[2])
    cur.setDate(cur.getDate() - 7)
    setSelectedDate(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`)
  }
  const handleNextWeek = () => {
    setViewWeekStartDate(prev => { const d = new Date(prev); d.setDate(d.getDate() + 7); return d })
    const parts = selectedDate.split('-').map(Number)
    const cur = new Date(parts[0], parts[1] - 1, parts[2])
    cur.setDate(cur.getDate() + 7)
    setSelectedDate(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`)
  }
  const handlePrevDay = () => {
    const parts = selectedDate.split('-').map(Number)
    const cur = new Date(parts[0], parts[1] - 1, parts[2])
    cur.setDate(cur.getDate() - 1)
    setSelectedDate(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`)
  }
  const handleNextDay = () => {
    const parts = selectedDate.split('-').map(Number)
    const cur = new Date(parts[0], parts[1] - 1, parts[2])
    cur.setDate(cur.getDate() + 1)
    setSelectedDate(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`)
  }

  const stepCalendarPeriod = (direction: -1 | 1) => {
    if (calendarSwipeAnimTimerRef.current) {
      clearTimeout(calendarSwipeAnimTimerRef.current)
    }
    setCalendarSwipeAnim(direction === 1 ? 'left' : 'right')
    calendarSwipeAnimTimerRef.current = setTimeout(() => {
      setCalendarSwipeAnim(null)
    }, 180)

    if (viewMode === 'month') {
      if (direction === -1) handlePrevMonth()
      else handleNextMonth()
    } else if (viewMode === 'week') {
      if (direction === -1) handlePrevWeek()
      else handleNextWeek()
    } else {
      if (direction === -1) handlePrevDay()
      else handleNextDay()
    }
  }

  const handlePrev = () => stepCalendarPeriod(-1)

  const handleNext = () => stepCalendarPeriod(1)

  const handleToday = () => {
    const d = new Date()
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
    const today = d.toISOString().split('T')[0]
    setSelectedDate(today)
    setBookDate(today)
    const cur = new Date()
    setViewMonthDate(new Date(cur.getFullYear(), cur.getMonth(), 1))
    const parts = today.split('-').map(Number)
    const dt = new Date(parts[0], parts[1] - 1, parts[2])
    const diff = dt.getDate() - dt.getDay()
    setViewWeekStartDate(new Date(dt.setDate(diff)))
  }

  const handleDayClick = (dateStr: string) => {
    setSelectedDate(dateStr)
    setBookDate(dateStr)
    setViewMode('day')
  }

  const fetchMyServices = async () => {
    if (!selectedBarberId) return
    const { data } = await supabase
      .from('services')
      .select('*')
      .eq('barber_id', selectedBarberId)
      .eq('is_active', true)
      .order('name', { ascending: true })
    const activeOnly = (data || []).filter(s => s.is_active !== false)
    setMyServices(activeOnly)
    setAdminServices(activeOnly)
  }
  useEffect(() => { if (session && activeModule === 'services' && selectedBarberId) fetchMyServices() }, [session, activeModule, selectedBarberId])

  // Auto-reset inline 2-tap Delete Service confirmation after 4000ms
  useEffect(() => {
    if (!confirmDeleteServiceId) return
    const timer = window.setTimeout(() => {
      setConfirmDeleteServiceId(null)
    }, 4000)
    return () => window.clearTimeout(timer)
  }, [confirmDeleteServiceId])

  // --- CLIENT DIRECTORY AUTO-FETCH (runs when Clients tab opens OR refreshTrigger updates) ---
  const fetchClientsDirectory = async () => {
    if (!session) return
    setLoadingClients(true)
    try {
      let allClients: any[] = []
      const pageSize = 1000
      let from = 0
      while (true) {
        const { data: batch, error: batchErr } = await supabase
          .from('clients')
          .select('*')
          .neq('phone', '0000000000')
          .order('name', { ascending: true })
          .range(from, from + pageSize - 1)
        if (batchErr) throw batchErr
        if (!batch || batch.length === 0) break
        allClients = [...allClients, ...batch]
        if (batch.length < pageSize) break
        from += pageSize
      }

      const [apptsRes, servicesRes] = await Promise.all([
        supabase
          .from('appointments')
          .select('*')
          .order('appointment_date', { ascending: false })
          .order('start_time', { ascending: false })
          .limit(5000),
        supabase
          .from('services')
          .select('*')
      ])

      if (servicesRes.data) {
        setAllShopServices(servicesRes.data)
      }

      const grouped: Record<string, any[]> = {}
      for (const appt of apptsRes.data || []) {
        if (appt.is_blockout || appt.status === 'blocked' || !appt.client_id) continue
        if (!grouped[appt.client_id]) grouped[appt.client_id] = []
        grouped[appt.client_id].push(appt)
      }

      setClientsList(allClients)
      setAllAppointmentsByClient(grouped)
    } catch (err) {
      console.error('Failed to load Client Directory:', err)
    } finally {
      setLoadingClients(false)
    }
  }

  useEffect(() => {
    if (session && (activeModule === 'clients' || activeModule === 'calendar' || refreshTrigger > 0 || clientsList.length === 0)) {
      fetchClientsDirectory()
    }
  }, [session, activeModule, refreshTrigger])

  useEffect(() => {
    let cancelled = false
    if (showBookModal && selectedBarberId && bookDate) {
      const serviceDuration = bookServices.length > 0 ? Math.max(15, bookTotalDurationMinutes) : 30

      Promise.all([
        getAvailableSlots(selectedBarberId, bookDate, serviceDuration),
        supabase
          .from('appointments')
          .select('start_time, end_time, status, is_blockout')
          .eq('barber_id', selectedBarberId)
          .eq('appointment_date', bookDate)
          .neq('status', 'cancelled'),
        supabase
          .from('schedule_overrides')
          .select('*')
          .eq('barber_id', selectedBarberId)
          .eq('override_date', bookDate)
          .maybeSingle()
      ]).then(([regularSlots, apptsRes, ovRes]) => {
        if (cancelled) return
        setBookDateOverride(ovRes.data || null)
        setBookSlots(regularSlots)

        const blockedIntervals = (apptsRes.data || [])
          .filter(a => a.status !== 'cancelled')
          .map(a => ({
            start: toMinutes(a.start_time),
            end: toMinutes(a.end_time)
          }))

        const now = new Date()
        const todayLocalStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
        const isTodayDate = bookDate === todayLocalStr
        const nowMins = now.getHours() * 60 + now.getMinutes()

        setBookTime((prev) => {
          const collisionFree: string[] = []
          for (let m = 0; m + serviceDuration <= 24 * 60; m += 15) {
            const slotStr = minutesToTime(m)
            if (isTodayDate && m < nowMins && slotStr !== prev) continue
            const slotEnd = m + serviceDuration
            const overlaps = blockedIntervals.some(b => m < b.end && slotEnd > b.start)
            if (!overlaps) {
              collisionFree.push(slotStr)
            }
          }

          setAllCollisionFreeSlots(collisionFree)

          if (isBlockoutMode) return prev
          if (prev && (regularSlots.includes(prev) || collisionFree.includes(prev) || ALL_DAY_15_MIN_SLOTS.includes(prev))) {
            return prev
          }
          if (regularSlots.length > 0) {
            if (prev) {
              const nearestReg = regularSlots.find((s) => s >= prev)
              return nearestReg || regularSlots[0]
            }
            return regularSlots[0]
          }
          if (collisionFree.length > 0) {
            const target = prev || '09:00'
            const nearest = collisionFree.find((s) => s >= target)
            return nearest || collisionFree[0]
          }
          return prev || '09:00'
        })
      })
    } else {
      setBookSlots([])
      setAllCollisionFreeSlots([])
    }
    return () => { cancelled = true }
  }, [showBookModal, selectedBarberId, bookServices, bookTotalDurationMinutes, bookDate, isBlockoutMode])

  // Load available slots for Edit Appointment Mode (ignoring the edited appointment's own current overlap)
  useEffect(() => {
    let cancelled = false
    if (showApptModal && editApptMode && selectedAppt && editApptDate && editApptServices.length > 0) {
      const targetBarberId = selectedAppt.barber_id || selectedBarberId
      const editDuration = Math.max(
        15,
        editApptServices.reduce((sum, s) => sum + (Number(s?.duration_minutes) || 0), 0)
      )

      Promise.all([
        getAvailableSlots(targetBarberId, editApptDate, editDuration),
        supabase
          .from('appointments')
          .select('id, start_time, end_time, status, is_blockout')
          .eq('barber_id', targetBarberId)
          .eq('appointment_date', editApptDate)
          .neq('status', 'cancelled')
      ]).then(([baseRegularSlots, apptsRes]) => {
        if (cancelled) return

        // Exclude selectedAppt itself from blocked intervals so its own time slots stay selectable
        const otherIntervals = (apptsRes.data || [])
          .filter(a => a.status !== 'cancelled' && String(a.id) !== String(selectedAppt.id))
          .map(a => ({
            start: toMinutes(a.start_time),
            end: toMinutes(a.end_time)
          }))

        const shift = getBarberShiftMins(targetBarberId, editApptDate)
        const collisionFree: string[] = []
        const regularWithSelfUnblocked: string[] = [...baseRegularSlots]

        for (let m = 0; m + editDuration <= 24 * 60; m += 15) {
          const slotStr = minutesToTime(m)
          const slotEnd = m + editDuration
          const overlapsOther = otherIntervals.some(b => m < b.end && slotEnd > b.start)
          if (!overlapsOther) {
            collisionFree.push(slotStr)
            if (shift && m >= shift.startMins && slotEnd <= shift.endMins && !regularWithSelfUnblocked.includes(slotStr)) {
              regularWithSelfUnblocked.push(slotStr)
            }
          }
        }

        regularWithSelfUnblocked.sort()
        setEditApptRegularSlots(regularWithSelfUnblocked)
        setEditApptAllSlots(collisionFree)

        setEditApptTime(prev => {
          if (prev && (regularWithSelfUnblocked.includes(prev) || collisionFree.includes(prev) || ALL_DAY_15_MIN_SLOTS.includes(prev))) {
            return prev
          }
          if (regularWithSelfUnblocked.length > 0) return regularWithSelfUnblocked[0]
          if (collisionFree.length > 0) return collisionFree[0]
          return prev || '09:00'
        })
      })
    } else {
      setEditApptRegularSlots([])
      setEditApptAllSlots([])
    }
    return () => { cancelled = true }
  }, [showApptModal, editApptMode, selectedAppt, editApptDate, editApptServices, selectedBarberId])

  useEffect(() => {
    if (showManageDayModal && selectedBarberId && selectedDate) {
      supabase.from('schedule_overrides').select('*').eq('barber_id', selectedBarberId).eq('override_date', selectedDate).maybeSingle().then(({ data }) => {
        if (data) { setIsDayOff(data.is_off); if (data.start_time) setOverrideStart(data.start_time.slice(0,5)); if (data.end_time) setOverrideEnd(data.end_time.slice(0,5)) }
        else { setIsDayOff(false); setOverrideStart('09:00'); setOverrideEnd('17:00') }
      })
    }
  }, [showManageDayModal, selectedBarberId, selectedDate])

  useEffect(() => {
    async function loadWalkInSlots() {
      if (activeModule === 'walkin' && walkInService && selectedDate) {
        if (walkInBarberId === 'any') {
          let allSlots: WalkInSlot[] = []
          for (const barber of barbers) {
            const times = await getAvailableSlots(barber.id, selectedDate, walkInService.duration_minutes)
            const mapped = times.map(t => ({ time: t, barberId: barber.id, barberName: barber.name }))
            allSlots = [...allSlots, ...mapped]
          }
          allSlots.sort((a, b) => a.time.localeCompare(b.time))
          setWalkInSlots(allSlots)
        } else {
          const times = await getAvailableSlots(walkInBarberId, selectedDate, walkInService.duration_minutes)
          const barber = barbers.find(b => b.id === walkInBarberId)
          setWalkInSlots(times.map(t => ({ time: t, barberId: walkInBarberId, barberName: barber?.name || '' })))
        }
      } else { setWalkInSlots([]) }
    }
    loadWalkInSlots()
  }, [activeModule, walkInBarberId, walkInService, selectedDate, barbers])

  // Helper to compute the end-of-week Sunday cutoff (Mon-Sun week) for a given YYYY-MM-DD date
  const getEndOfWeekSundayInfo = (dateStr: string) => {
    const baseStr = dateStr || selectedDate
    const startDt = new Date(baseStr + 'T12:00:00Z')
    const daysUntilSunday = (7 - startDt.getUTCDay()) % 7
    const endDt = new Date(startDt.getTime() + daysUntilSunday * 24 * 60 * 60 * 1000)
    const endDateStr = endDt.toISOString().split('T')[0]
    const formattedCutoff = endDt.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    })
    return {
      startDt,
      daysUntilSunday,
      totalDaysInRange: daysUntilSunday + 1,
      endDt,
      endDateStr,
      formattedCutoff,
    }
  }

  // Helper to check Pacific (America/Los_Angeles) Quiet Hours (9:00 PM - 7:00 AM) and compute the exact next 7:00 AM Pacific UTC ISO string
  const getPacificQuietHoursInfo = (now: Date = new Date()) => {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
    const parts = formatter.formatToParts(now)
    const getPart = (type: string) => Number(parts.find(p => p.type === type)?.value || '0')

    const laYear = getPart('year')
    const laMonth = getPart('month')
    const laDay = getPart('day')
    const laHour = getPart('hour')

    const isQuietHours = laHour >= 21 || laHour < 7
    const next7AMLabel = laHour < 7 ? 'Today at 7:00 AM' : 'Tomorrow at 7:00 AM'

    const targetLocalDate = new Date(Date.UTC(laYear, laMonth - 1, laHour < 7 ? laDay : laDay + 1))
    const tYear = targetLocalDate.getUTCFullYear()
    const tMonth = targetLocalDate.getUTCMonth()
    const tDay = targetLocalDate.getUTCDate()

    const candidateUtc = new Date(Date.UTC(tYear, tMonth, tDay, 15, 0, 0))
    const candidateParts = formatter.formatToParts(candidateUtc)
    const candidateLaHour = Number(candidateParts.find(p => p.type === 'hour')?.value || '7')
    const hourDiff = candidateLaHour - 7
    const exact7AmUtc = new Date(candidateUtc.getTime() - hourDiff * 60 * 60 * 1000)

    return {
      isQuietHours,
      next7AMLabel,
      next7AMIso: exact7AmUtc.toISOString(),
    }
  }

  const handleQueueSmsFor7AM = async () => {
    if (!smsConfirmPrompt || !smsConfirmMessage.trim() || isDispatchingConfirmSms) return
    setIsDispatchingConfirmSms(true)
    try {
      const { next7AMLabel, next7AMIso } = getPacificQuietHoursInfo()
      const cleanDestPhone = cleanPhone(smsConfirmPrompt.clientPhone)
      const trimmedMsg = smsConfirmMessage.trim()

      const { data: invokeData, error: invokeErr } = await supabase.functions.invoke('twilio-sms', {
        body: {
          to: cleanDestPhone,
          message: trimmedMsg,
          scheduleFor7AM: true,
          appointmentId: smsConfirmPrompt.appointmentId || null,
        }
      })

      // Fallback to direct table insert if cloud Edge Function hasn't been redeployed with scheduleFor7AM support yet
      if (invokeErr || !invokeData?.queued) {
        const { error: fallbackErr } = await supabase
          .from('scheduled_sms_queue')
          .insert({
            to_phone: cleanDestPhone,
            message: trimmedMsg,
            send_after: next7AMIso,
            status: 'pending',
            appointment_id: smsConfirmPrompt.appointmentId || null,
          })
        if (fallbackErr) throw fallbackErr
      }

      setStatusBanner({
        type: 'success',
        message: `SMS to ${smsConfirmPrompt.clientName} queued for 7:00 AM Pacific (${next7AMLabel}).`
      })
      setSmsConfirmPrompt(null)
      setOverrideQuietHoursSendNow(false)
    } catch (err: any) {
      console.error('Failed to queue SMS for 7:00 AM:', err)
      alert(`Failed to queue SMS for 7:00 AM: ${err?.message || 'Unknown error'}`)
    } finally {
      setIsDispatchingConfirmSms(false)
    }
  }

  const handleSendConfirmSmsNow = async () => {
    if (!smsConfirmPrompt || !smsConfirmMessage.trim() || isDispatchingConfirmSms) return
    setIsDispatchingConfirmSms(true)
    try {
      const cleanDestPhone = cleanPhone(smsConfirmPrompt.clientPhone)
      const trimmedMsg = smsConfirmMessage.trim()

      await supabase.functions.invoke('twilio-sms', {
        body: {
          to: cleanDestPhone,
          message: trimmedMsg,
        }
      })

      if (smsConfirmPrompt.barberPhone && smsConfirmPrompt.barberMessage) {
        await supabase.functions.invoke('twilio-sms', {
          body: {
            to: smsConfirmPrompt.barberPhone,
            message: smsConfirmPrompt.barberMessage,
          }
        })
      }

      setStatusBanner({
        type: 'success',
        message: `SMS sent to ${smsConfirmPrompt.clientName} (${formatPhoneNumber(cleanDestPhone)}).`
      })
      setSmsConfirmPrompt(null)
      setOverrideQuietHoursSendNow(false)
    } catch (err: any) {
      console.error('Failed to send SMS:', err)
      alert(`Failed to send SMS: ${err?.message || 'Unknown error'}`)
    } finally {
      setIsDispatchingConfirmSms(false)
    }
  }

  // --- SUBMIT HANDLERS ---
  const submitAdminBooking = async (bypassConflictCheck = false) => {
    if (isBlockoutMode) {
      if (!bookDate || !bookTime || !blockEndTime) return
    } else {
      if (!clientName || !clientPhone || !bookTime || bookServices.length === 0) return
    }
    setIsBooking(true)
    try {
      // --- DURATION-BASED COLLISION MATH (runs before any client writes) ---
      let proposedStartTime: number
      let proposedEndTime: number
      let endTimeStr: string
      let proposedDuration: number

      if (isBlockoutMode) {
        proposedStartTime = toMinutes(bookTime)
        proposedEndTime = toMinutes(blockEndTime)
        if (proposedEndTime <= proposedStartTime) {
          alert("End time must be after start time.")
          setIsBooking(false)
          return
        }
        proposedDuration = proposedEndTime - proposedStartTime
        endTimeStr = `${Math.floor(proposedEndTime / 60).toString().padStart(2, '0')}:${(proposedEndTime % 60).toString().padStart(2, '0')}:00`
      } else {
        proposedDuration = Math.max(15, bookTotalDurationMinutes)
        proposedStartTime = toMinutes(bookTime)
        proposedEndTime = proposedStartTime + proposedDuration
        endTimeStr = `${Math.floor(proposedEndTime / 60).toString().padStart(2, '0')}:${(proposedEndTime % 60).toString().padStart(2, '0')}:00`
      }

      // Check conflicts on bookDate (for single bookings or non-repeating blockouts) unless overridden
      if ((!isBlockoutMode || !isRepeatingBlockout) && !bypassConflictCheck) {
        const { data: conflicts, error: conflictErr } = await supabase
          .from('appointments')
          .select('clients ( name ), start_time, end_time, status, notes, is_blockout')
          .eq('barber_id', selectedBarberId)
          .eq('appointment_date', bookDate)
          .neq('status', 'cancelled')
        if (conflictErr) throw conflictErr

        const overlappingAppts = (conflicts || []).filter((c: any) => {
          const cStart = toMinutes(c.start_time)
          const cEnd = toMinutes(c.end_time)
          return (proposedStartTime < cEnd) && (proposedEndTime > cStart)
        })

        if (overlappingAppts.length > 0) {
          const activeBarberName = barbers.find(b => b.id === selectedBarberId)?.name || 'Barber'
          const reasons: string[] = overlappingAppts.map((c: any) => {
            const cLabel = c.is_blockout
              ? (c.notes || 'Blocked Time')
              : c.status === 'blocked'
              ? 'Blocked Time'
              : (c.clients?.name || 'Walk-In')
            return `Overlaps with ${cLabel} (${formatTime(c.start_time)} – ${formatTime(c.end_time)})`
          })
          if (!isBlockoutMode && isOutsideBarberSchedule(bookDate, bookTime, proposedDuration)) {
            reasons.push(`Falls outside ${activeBarberName}'s scheduled working hours / on a scheduled day off`)
          }
          const actionLabel = isBlockoutMode
            ? `Block Time (${formatTime(bookTime)} – ${formatTime(endTimeStr)}) on ${formatDisplayDate(bookDate)}`
            : `${clientName.trim()} — ${bookServices.map(s => s.name).join(' + ')} (${formatTime(bookTime)} – ${formatTime(endTimeStr)}) on ${formatDisplayDate(bookDate)}`

          setIsBooking(false)
          setConflictOverridePrompt({
            title: 'Schedule Conflict Override',
            proposedSummary: actionLabel,
            reasons,
            onConfirm: () => {
              setConflictOverridePrompt(null)
              submitAdminBooking(true)
            }
          })
          return
        }
      }

      // --- STEP A: Resolve or Create Client ---
      let clientId: string | null = null
      if (isBlockoutMode) {
        // Look up or insert fallback 'Blocked' client
        let { data: blockClient } = await supabase.from('clients').select('id').eq('phone', "0000000000").maybeSingle()
        clientId = blockClient?.id
        if (!clientId) {
          const { data: newClient } = await supabase.from('clients').insert({ name: 'Blocked', phone: "0000000000" }).select().single()
          clientId = newClient?.id
        }
      } else {
        const liveName = clientName.trim()
        const livePhone = cleanPhone(clientPhone)
        const trimmedBookingNote = bookNotes.trim()

        if (livePhone.length !== 10) {
          alert("Please enter a valid 10-digit phone number.")
          setIsBooking(false)
          return
        }

        // Check existing client first so we NEVER overwrite existing `clients.notes`
        const { data: existingClient } = await supabase
          .from('clients')
          .select('id, name, notes')
          .eq('phone', livePhone)
          .maybeSingle()

        const clientPayload: Record<string, any> = {
          name: liveName,
          phone: livePhone
        }

        if (trimmedBookingNote && (!existingClient || !existingClient.notes || !existingClient.notes.trim())) {
          clientPayload.notes = trimmedBookingNote
        }

        const { data: clientData, error: clientErr } = await supabase
          .from('clients')
          .upsert(clientPayload, { onConflict: 'phone' })
          .select('id, name, notes')
          .single()
        if (clientErr) throw clientErr
        if (!clientData?.id) throw new Error('Client record was not returned by the database.')
        clientId = clientData.id
      }

      // --- STEP B: Insert into appointments with is_blockout ---
      const nowIso = new Date().toISOString()
      const startTimeFormatted = `${bookTime.slice(0, 5)}:00`

      let insertedApptId: string | null = null

      if (isBlockoutMode && isRepeatingBlockout) {
        const { startDt, daysUntilSunday, endDateStr, formattedCutoff } = getEndOfWeekSundayInfo(bookDate)

        const [ovRes, existingBlocksRes] = await Promise.all([
          supabase
            .from('schedule_overrides')
            .select('override_date, is_off')
            .eq('barber_id', selectedBarberId)
            .gte('override_date', bookDate)
            .lte('override_date', endDateStr),
          supabase
            .from('appointments')
            .select('appointment_date, start_time')
            .eq('barber_id', selectedBarberId)
            .eq('is_blockout', true)
            .neq('status', 'cancelled')
            .gte('appointment_date', bookDate)
            .lte('appointment_date', endDateStr)
        ])

        const rangeOverrides = ovRes.data || []
        const existingBlocks = existingBlocksRes.data || []
        const rowsToInsert: any[] = []

        for (let d = 0; d <= daysUntilSunday; d++) {
          const curDt = new Date(startDt.getTime() + d * 24 * 60 * 60 * 1000)
          const curDateStr = curDt.toISOString().split('T')[0]

          const isWorkingDay = !isNonWorkingDate(curDateStr, rangeOverrides)

          // Include bookDate itself plus every working day through Sunday of the current week
          if (curDateStr !== bookDate && !isWorkingDay) continue

          // Skip if a blockout already exists at the exact same date & start_time
          const alreadyBlocked = existingBlocks.some(
            (b: any) => b.appointment_date === curDateStr && b.start_time?.slice(0, 5) === bookTime.slice(0, 5)
          )
          if (alreadyBlocked) continue

          const rowPayload: any = {
            barber_id: selectedBarberId,
            client_id: clientId,
            appointment_date: curDateStr,
            start_time: startTimeFormatted,
            end_time: endTimeStr,
            status: 'blocked',
            notes: bookNotes.trim() || 'Blocked Time',
            is_blockout: true,
            barber_seen_at: nowIso
          }
          if (bookServices[0]?.id) {
            rowPayload.service_id = bookServices[0].id
          }
          rowsToInsert.push(rowPayload)
        }

        if (rowsToInsert.length > 0) {
          const { error: batchErr } = await supabase.from('appointments').insert(rowsToInsert)
          if (batchErr) throw batchErr
        }

        setStatusBanner({
          type: 'success',
          message: `Blocked time across ${rowsToInsert.length} working day${rowsToInsert.length === 1 ? '' : 's'} through ${formattedCutoff}.`
        })
      } else {
        const combinedNames = bookServices.map(s => s.name).join(' + ')
        const trimmedRawNotes = bookNotes.trim()
        const formattedApptNotes = isBlockoutMode
          ? (trimmedRawNotes || 'Blocked Time')
          : bookServices.length > 1
          ? `[Services: ${combinedNames} ($${bookTotalPrice})]${trimmedRawNotes ? ` - ${trimmedRawNotes}` : ''}`
          : (trimmedRawNotes || null)

        const insertPayload: any = {
          barber_id: selectedBarberId,
          client_id: clientId,
          appointment_date: bookDate,
          start_time: startTimeFormatted,
          end_time: endTimeStr,
          status: isBlockoutMode ? 'blocked' : 'booked',
          notes: formattedApptNotes,
          is_blockout: isBlockoutMode,
          barber_seen_at: nowIso
        }
        if (bookServices[0]?.id) {
          insertPayload.service_id = bookServices[0].id
        }

        const { data: insertedAppt, error: apptErr } = await supabase
          .from('appointments')
          .insert(insertPayload)
          .select('id')
          .single()
        if (apptErr) throw apptErr
        insertedApptId = insertedAppt?.id || null
      }

      // Open Barber SMS Confirmation Modal (for real client bookings with a valid phone number)
      if (!isBlockoutMode) {
        const cleanedDest = cleanPhone(clientPhone)
        if (cleanedDest.length === 10 && cleanedDest !== '0000000000') {
          const assignedBarber = barbers.find(b => b.id === selectedBarberId)
          const barberName = assignedBarber?.name || loggedInBarber?.name || 'LifeStyle Barber'
          const friendlyDate = new Date(bookDate + 'T12:00:00Z').toLocaleDateString('en-US', {
            month: 'long',
            day: 'numeric',
            year: 'numeric',
            timeZone: 'UTC'
          })
          const combinedServiceNames = bookServices.map(s => s.name).join(' + ')
          const firstName = getFriendlyFirstName(clientName)
          const draftedMsg = `Hey ${firstName}, your appointment at LifeStyle Barber with ${barberName} for ${combinedServiceNames} is confirmed for ${friendlyDate} at ${formatTime(bookTime)}. Reply CANCEL to cancel. Reply STOP to unsubscribe.`
          const barberPhone = assignedBarber?.phone || loggedInBarber?.phone || null

          setOverrideQuietHoursSendNow(false)
          setSmsConfirmMessage(draftedMsg)
          setSmsConfirmPrompt({
            contextTitle: 'New Booking Text',
            changeSummary: `Booked with ${barberName} • ${combinedServiceNames} • ${friendlyDate} at ${formatTime(bookTime)}`,
            clientName: clientName.trim(),
            clientPhone: cleanedDest,
            appointmentId: insertedApptId,
            barberPhone: barberPhone && cleanPhone(barberPhone) !== cleanedDest ? barberPhone : null,
            barberMessage: `LifeStyle Barber: New booking with ${clientName.trim()} (${formatPhoneNumber(cleanedDest)}) for ${combinedServiceNames} on ${friendlyDate} at ${formatTime(bookTime)}.`,
          })
        }
      }

      setShowBookModal(false)
      setIsBlockoutMode(false)
      setIsRepeatingBlockout(false)
      setBookServices([])
      setBookTime('')
      setBlockEndTime('')
      setClientName('')
      setClientPhone('')
      setBookNotes('')
      setSelectedExistingClient(null)
      setShowExistingClientPicker(false)
      setClientSearchQuery('')
      setRefreshTrigger(prev => prev + 1)
    } catch (error: any) {
      console.error(error)
      alert(`Failed to ${isBlockoutMode ? 'block time' : 'book appointment'}: ${error?.message || 'Unknown error'}`)
    } finally {
      setIsBooking(false)
    }
  }

  const handleAdminBooking = async (e: React.FormEvent) => {
    e.preventDefault()
    await submitAdminBooking(false)
  }

  // --- DRAG-AND-DROP RESCHEDULING HANDLER ---
  const handleDropReschedule = async (apptToMove: any, newDate: string, newStartTime: string, bypassConflictCheck = false) => {
    if (!apptToMove || !newDate || !newStartTime || isRescheduling) return

    // A. Calculate the new start_time and appointment_date based on where it landed
    const newStartMins = toMinutes(newStartTime)
    const apptStartMins = toMinutes(apptToMove.start_time)
    const apptEndMins = toMinutes(apptToMove.end_time)

    // B. Calculate the proposedEndTime using the appointment's existing duration
    const duration = Math.max(15, apptEndMins - apptStartMins)
    const newEndMins = newStartMins + duration

    // Ensure newDate is strictly formatted as YYYY-MM-DD
    newDate = (newDate.includes('T') ? newDate.split('T')[0] : newDate).trim()
    const currentApptDate = (apptToMove.appointment_date || selectedDate).split('T')[0].trim()

    // If dropped back at the same position, do nothing
    if (currentApptDate === newDate && apptStartMins === newStartMins) {
      return
    }

    // Strictly zero-padded 24-hour formats (e.g., 09:15, 14:30)
    const startHours = Math.floor(newStartMins / 60)
    const startMins = newStartMins % 60
    const endHours = Math.floor(newEndMins / 60)
    const endMins = newEndMins % 60

    const newStartTimeStr = `${String(startHours).padStart(2, '0')}:${String(startMins).padStart(2, '0')}`
    const newEndTimeStr = `${String(endHours).padStart(2, '0')}:${String(endMins).padStart(2, '0')}`

    const targetBarberId = apptToMove.barber_id || selectedBarberId
    setIsRescheduling(true)

    try {
      if (!bypassConflictCheck) {
        // Run strict universal collision math against existing appointments (STRICTLY EXCLUDE THE DRAGGED APPOINTMENT ITSELF)
        const { data: conflicts, error: conflictErr } = await supabase
          .from('appointments')
          .select('id, clients ( name ), start_time, end_time, status, notes, is_blockout')
          .eq('barber_id', targetBarberId)
          .eq('appointment_date', newDate)
          .neq('status', 'cancelled')

        if (conflictErr) throw conflictErr

        const overlappingAppts = (conflicts || []).filter((c: any) => {
          if (c.id === apptToMove.id || String(c.id) === String(apptToMove.id)) return false
          const cStart = toMinutes(c.start_time)
          const cEnd = toMinutes(c.end_time)
          return (newStartMins < cEnd) && (newEndMins > cStart)
        })

        const isOut = !apptToMove.is_blockout && isOutsideBarberSchedule(newDate, newStartTimeStr, duration)

        if (overlappingAppts.length > 0 || isOut) {
          const activeBarberName = barbers.find(b => b.id === targetBarberId)?.name || 'Barber'
          const reasons: string[] = overlappingAppts.map((c: any) => {
            const cLabel = c.is_blockout
              ? (c.notes || 'Blocked Time')
              : c.status === 'blocked'
              ? 'Blocked Time'
              : (c.clients?.name || 'Walk-In')
            return `Overlaps with ${cLabel} (${formatTime(c.start_time)} – ${formatTime(c.end_time)})`
          })
          if (isOut) {
            reasons.push(`Falls outside ${activeBarberName}'s scheduled working hours / on a scheduled day off`)
          }
          const movedLabel = apptToMove.is_blockout
            ? (apptToMove.notes || 'Blocked Time')
            : (apptToMove.clients?.name || 'Walk-In')

          setIsRescheduling(false)
          setConflictOverridePrompt({
            title: 'Schedule Conflict Override',
            proposedSummary: `Move ${movedLabel} to ${formatDisplayDate(newDate)} (${formatTime(newStartTimeStr)} – ${formatTime(newEndTimeStr)})`,
            reasons,
            onConfirm: () => {
              setConflictOverridePrompt(null)
              handleDropReschedule(apptToMove, newDate, newStartTime, true)
            }
          })
          return
        }
      }

      // If clear or overridden, immediately run supabase update and refresh the calendar
      const { error: updateErr } = await supabase
        .from('appointments')
        .update({
          appointment_date: newDate,
          start_time: newStartTimeStr,
          end_time: newEndTimeStr
        })
        .eq('id', apptToMove.id)

      if (updateErr) throw new Error(updateErr.message)

      setRefreshTrigger(prev => prev + 1)

      // Open Barber SMS Confirmation Modal for moved client appointments with a real phone number
      if (!apptToMove.is_blockout && apptToMove.status !== 'blocked') {
        const cleanedDest = cleanPhone(apptToMove.clients?.phone || '')
        if (cleanedDest.length === 10 && cleanedDest !== '0000000000') {
          const oldBarberName = barbers.find(b => b.id === apptToMove.barber_id)?.name || 'LifeStyle Barber'
          const newBarberName = barbers.find(b => b.id === targetBarberId)?.name || oldBarberName
          const oldFriendlyDate = new Date(currentApptDate + 'T12:00:00Z').toLocaleDateString('en-US', {
            month: 'long',
            day: 'numeric',
            year: 'numeric',
            timeZone: 'UTC'
          })
          const newFriendlyDate = new Date(newDate + 'T12:00:00Z').toLocaleDateString('en-US', {
            month: 'long',
            day: 'numeric',
            year: 'numeric',
            timeZone: 'UTC'
          })
          const oldTimeFormatted = formatTime(apptToMove.start_time)
          const newTimeFormatted = formatTime(newStartTimeStr)
          const serviceName = apptToMove.services?.name || 'appointment'
          const firstName = getFriendlyFirstName(apptToMove.clients?.name)
          const draftedMsg = `Hey ${firstName}, your ${serviceName} at LifeStyle Barber with ${newBarberName} has been rescheduled from ${oldFriendlyDate} at ${oldTimeFormatted} to ${newFriendlyDate} at ${newTimeFormatted}. Please let us know if you need any adjustments! Reply STOP to unsubscribe.`

          setOverrideQuietHoursSendNow(false)
          setSmsConfirmMessage(draftedMsg)
          setSmsConfirmPrompt({
            contextTitle: 'Appointment Move / Reschedule Text',
            changeSummary: `${oldBarberName} (${oldFriendlyDate} at ${oldTimeFormatted}) → ${newBarberName} (${newFriendlyDate} at ${newTimeFormatted})`,
            clientName: apptToMove.clients?.name || 'Client',
            clientPhone: cleanedDest,
            appointmentId: apptToMove.id,
          })
        }
      }
    } catch (err: any) {
      console.error("Failed to reschedule:", err)
      alert(`Failed to reschedule appointment: ${err?.message || 'Unknown error'}`)
    } finally {
      setIsRescheduling(false)
    }
  }

  const handleSaveWorkingHours = async () => {
    if (!selectedBarberId) return
    setIsSavingWorkingHours(true)
    try {
      // Build unified working_hours payload supporting both day-name keys ("Sunday".."Saturday") and numeric indices (0..6)
      const workingHoursPayload: Record<string, any> = {}
      DAYS_OF_WEEK.forEach(day => {
        const cfg = barberWorkingHours[day.index] || DEFAULT_WORKING_HOURS[day.index]
        const startVal = (cfg?.start_time || (cfg as any)?.start || '09:00').slice(0, 5)
        const endVal = (cfg?.end_time || (cfg as any)?.end || '17:00').slice(0, 5)
        const dayEntry = {
          isWorking: Boolean(cfg?.isWorking),
          start: startVal,
          end: endVal,
          start_time: startVal,
          end_time: endVal,
        }
        workingHoursPayload[day.name] = dayEntry
        workingHoursPayload[day.index] = dayEntry
      })

      const { error } = await supabase
        .from('barbers')
        .update({ working_hours: workingHoursPayload })
        .eq('id', selectedBarberId)

      if (error) throw error

      // Also keep weekly_schedules table synced with barberWorkingHours
      const workingRows = DAYS_OF_WEEK
        .filter(day => Boolean((barberWorkingHours[day.index] || DEFAULT_WORKING_HOURS[day.index])?.isWorking))
        .map(day => {
          const cfg = barberWorkingHours[day.index] || DEFAULT_WORKING_HOURS[day.index]
          const startVal = (cfg?.start_time || (cfg as any)?.start || '09:00').slice(0, 5)
          const endVal = (cfg?.end_time || (cfg as any)?.end || '17:00').slice(0, 5)
          return {
            barber_id: selectedBarberId,
            day_of_week: day.index,
            start_time: `${startVal}:00`,
            end_time: `${endVal}:00`
          }
        })

      await supabase.from('weekly_schedules').delete().eq('barber_id', selectedBarberId)
      if (workingRows.length > 0) {
        await supabase.from('weekly_schedules').upsert(workingRows, { onConflict: 'barber_id,day_of_week' })
      }

      alert("Barber schedule updated successfully!")
      setBarbers(prev => prev.map(b => b.id === selectedBarberId ? { ...b, working_hours: workingHoursPayload } : b))
      setBarberWeeklySchedules(workingRows)
      setShowBarberSettingsModal(false)
      setRefreshTrigger(prev => prev + 1)
    } catch (err: any) {
      console.error("Failed to save working hours:", err)
      alert(`Failed to save working hours: ${err?.message || 'Database error'}`)
    } finally {
      setIsSavingWorkingHours(false)
    }
  }

  const handleExpressWalkIn = async (time: string, targetBarberId: string) => {
    if (!targetBarberId || !walkInService || isExpressBooking) return
    setIsExpressBooking(true)
    try {
      const genericPhone = "0000000000"
      let { data: walkinClient } = await supabase.from('clients').select('id').eq('phone', genericPhone).maybeSingle()
      let clientId = walkinClient?.id
      if (!clientId) {
        const { data: newClient } = await supabase.from('clients').insert({ name: 'Walk-In', phone: genericPhone }).select().single()
        clientId = newClient?.id
      }
      const [hours, minutes] = time.split(':').map(Number)
      const totalMinutes = hours * 60 + minutes + walkInService.duration_minutes
      const endTimeStr = `${Math.floor(totalMinutes / 60).toString().padStart(2, '0')}:${(totalMinutes % 60).toString().padStart(2, '0')}:00`

      await supabase.from('appointments').insert({ barber_id: targetBarberId, client_id: clientId, appointment_date: selectedDate, start_time: `${time}:00`, end_time: endTimeStr, status: 'walk-in', barber_seen_at: new Date().toISOString() })
      setWalkInService(null); setSelectedBarberId(targetBarberId); setActiveModule('calendar'); setRefreshTrigger(prev => prev + 1)
    } catch (error) { console.error(error); alert("Failed to block chair.") }
    finally { setIsExpressBooking(false) }
  }

  const handleSaveDayOverride = async () => {
    setIsSavingOverride(true)
    try {
      const { data: existing } = await supabase.from('schedule_overrides').select('id').eq('barber_id', selectedBarberId).eq('override_date', selectedDate).maybeSingle()
      if (existing) await supabase.from('schedule_overrides').update({ is_off: isDayOff, start_time: isDayOff ? null : `${overrideStart}:00`, end_time: isDayOff ? null : `${overrideEnd}:00` }).eq('id', existing.id)
      else await supabase.from('schedule_overrides').insert({ barber_id: selectedBarberId, override_date: selectedDate, is_off: isDayOff, start_time: isDayOff ? null : `${overrideStart}:00`, end_time: isDayOff ? null : `${overrideEnd}:00` })

      setShowManageDayModal(false); setRefreshTrigger(prev => prev + 1)
    } catch (err) { console.error(err); alert("Failed to update day status.") }
    finally { setIsSavingOverride(false) }
  }

  const handleBlockTimeChunk = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!blockStart || !blockEnd) return
    setIsSavingOverride(true)
    try {
      const { data: conflicts } = await supabase
        .from('appointments')
        .select('clients ( name ), start_time, end_time')
        .eq('barber_id', selectedBarberId)
        .eq('appointment_date', selectedDate)
        .neq('status', 'cancelled')

      if (conflicts) {
        const [bSH, bSM] = blockStart.split(':').map(Number)
        const [bEH, bEM] = blockEnd.split(':').map(Number)
        const startMins = bSH * 60 + bSM
        const endMins = bEH * 60 + bEM

        const hasConflict = conflicts.find((c: any) => {
          const [cH, cM] = c.start_time.split(':').map(Number)
          const [cEH, cEM] = c.end_time.split(':').map(Number)
          const cStart = cH * 60 + cM
          const cEnd = cEH * 60 + cEM
          return (startMins < cEnd && endMins > cStart)
        })

        if (hasConflict) {
          const conflictName = (hasConflict as any).clients?.name || 'Walk-In'
          alert(`Hold up — ${conflictName} is already locked in at this time. Clear or shift that slot first before blocking it out.`)
          setIsSavingOverride(false)
          return
        }
      }

      let { data: blockClient } = await supabase.from('clients').select('id').eq('phone', "0000000000").maybeSingle()
      let clientId = blockClient?.id
      if (!clientId) {
        const { data: newClient } = await supabase.from('clients').insert({ name: 'Blocked', phone: "0000000000" }).select().single()
        clientId = newClient?.id
      }
      await supabase.from('appointments').insert({ barber_id: selectedBarberId, client_id: clientId, appointment_date: selectedDate, start_time: `${blockStart}:00`, end_time: `${blockEnd}:00`, status: 'blocked', barber_seen_at: new Date().toISOString() })
      setShowManageDayModal(false); setBlockStart(''); setBlockEnd(''); setRefreshTrigger(prev => prev + 1)
    } catch (err) { console.error(err); alert("Failed to block time.") }
    finally { setIsSavingOverride(false) }
  }

  // --- APPOINTMENT DETAILS & CUT NOTES LOGIC ---
  const handleAcknowledgeBooking = async (bookingId: string) => {
    setAcknowledgingId(bookingId)
    try {
      const seenAt = new Date().toISOString()
      const { error } = await supabase
        .from('appointments')
        .update({ barber_seen_at: seenAt })
        .eq('id', bookingId)
      if (error) throw error
      setUnseenBookings(prev => prev.filter(b => b.id !== bookingId))
    } catch (err) {
      console.error('Failed to acknowledge booking:', err)
      alert('Failed to acknowledge booking.')
    } finally {
      setAcknowledgingId(null)
    }
  }

  const handleClearAllBarberAlerts = async () => {
    if (!selectedBarberId) return
    setClearingAllAlerts(true)
    try {
      const seenAt = new Date().toISOString()
      const { error } = await supabase
        .from('appointments')
        .update({ barber_seen_at: seenAt })
        .eq('barber_id', selectedBarberId)
        .is('barber_seen_at', null)
      if (error) throw error
      setUnseenBookings(prev => prev.filter(b => b.barber_id !== selectedBarberId))
    } catch (err) {
      console.error('Failed to clear barber alerts:', err)
      alert('Failed to clear alerts.')
    } finally {
      setClearingAllAlerts(false)
    }
  }

  const handleJumpToAlertSlot = (booking: any) => {
    if (!booking?.appointment_date) return
    setSelectedDate(booking.appointment_date)
    setBookDate(booking.appointment_date)
    setViewMode('day')
    setActiveModule('calendar')
    setShowAlertsModal(false)
  }

  const handleOpenAppt = async (appt: any) => {
    setSelectedAppt(appt)
    setEditApptMode(false)
    setClientNotes(appt.clients?.notes || '')
    setShowApptModal(true)
    const targetClientId = appt?.clients?.id || appt?.client_id
    const targetServiceId = appt?.service_id
    const [clientRes, serviceRes] = await Promise.all([
      targetClientId
        ? supabase
            .from('clients')
            .select('id, name, phone, notes, is_red_listed, red_listed_by, red_listed_reason, no_show_count')
            .eq('id', targetClientId)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      !appt?.services && targetServiceId
        ? supabase
            .from('services')
            .select('id, name, duration_minutes, price')
            .eq('id', targetServiceId)
            .maybeSingle()
        : Promise.resolve({ data: null })
    ])
    if (clientRes.data || serviceRes.data) {
      if (clientRes.data) setClientNotes(clientRes.data.notes || '')
      setSelectedAppt((prev: any) => prev ? {
        ...prev,
        clients: clientRes.data || prev.clients,
        services: serviceRes.data || prev.services
      } : prev)
    }
  }

  const handleStartEditAppt = () => {
    if (!selectedAppt) return
    setEditApptDate(selectedAppt.appointment_date || selectedDate)
    setEditApptTime((selectedAppt.start_time || '').slice(0, 5))

    const rawNotes = selectedAppt.notes || ''
    const multiMatch = rawNotes.match(/^\[Services:\s*(.+?)\s*\(\$[\d.]+\)\](?:\s*-\s*|\s*)(.*)$/s)
    if (multiMatch) {
      const parsedNames = multiMatch[1].split(/\s*\+\s*/).map((n: string) => n.trim()).filter(Boolean)
      const matchedSvcs = parsedNames
        .map((name: string) => adminServices.find(s => s.name.toLowerCase() === name.toLowerCase()))
        .filter(Boolean)
      if (matchedSvcs.length > 0) {
        setEditApptServices(matchedSvcs)
      } else if (selectedAppt.services) {
        setEditApptServices([selectedAppt.services])
      } else if (adminServices.length > 0) {
        setEditApptServices([adminServices[0]])
      }
      setEditApptNotes(multiMatch[2] || '')
    } else {
      if (selectedAppt.services) {
        setEditApptServices([selectedAppt.services])
      } else if (selectedAppt.service_id) {
        const foundSvc = adminServices.find(s => s.id === selectedAppt.service_id)
        setEditApptServices(foundSvc ? [foundSvc] : (adminServices.length > 0 ? [adminServices[0]] : []))
      } else if (adminServices.length > 0) {
        setEditApptServices([adminServices[0]])
      }
      setEditApptNotes(rawNotes)
    }
    setEditApptMode(true)
  }

  const handleRebookClient = () => {
    if (!selectedAppt) return
    const clientObj = selectedAppt.clients
    const rawClientName = clientObj?.name && clientObj.name !== 'Walk-In' && clientObj.name !== 'Blocked'
      ? clientObj.name
      : ''
    const rawClientPhone = clientObj?.phone && clientObj.phone !== '0000000000'
      ? formatPhoneNumber(clientObj.phone)
      : ''

    const rawNotes = selectedAppt.notes || ''
    const multiMatch = rawNotes.match(/^\[Services:\s*(.+?)\s*\(\$[\d.]+\)\](?:\s*-\s*|\s*)(.*)$/s)
    let matchedServices: any[] = []
    let cleanApptNotes = rawNotes

    if (multiMatch) {
      const parsedNames = multiMatch[1].split(/\s*\+\s*/).map((n: string) => n.trim()).filter(Boolean)
      matchedServices = parsedNames
        .map((name: string) => adminServices.find(s => s.name.toLowerCase() === name.toLowerCase()))
        .filter(Boolean)
      cleanApptNotes = multiMatch[2] || ''
    }

    if (matchedServices.length === 0) {
      const byId = selectedAppt.service_id
        ? adminServices.find(s => s.id === selectedAppt.service_id)
        : null
      const byName = !byId && selectedAppt.services?.name
        ? adminServices.find(s => s.name.toLowerCase() === selectedAppt.services.name.toLowerCase())
        : null
      if (byId) {
        matchedServices = [byId]
      } else if (byName) {
        matchedServices = [byName]
      } else if (selectedAppt.services) {
        matchedServices = [selectedAppt.services]
      }
    }

    const prefilledNotes = (cleanApptNotes || clientObj?.notes || '').trim()

    setShowApptModal(false)
    setEditApptMode(false)
    setIsBlockoutMode(false)
    setIsRepeatingBlockout(false)
    setShowExistingClientPicker(false)
    setClientSearchQuery('')
    setSelectedExistingClient(
      clientObj && clientObj.phone && clientObj.phone !== '0000000000' ? clientObj : null
    )
    setClientName(rawClientName)
    setClientPhone(rawClientPhone)
    setBookNotes(prefilledNotes)
    setBookServices(matchedServices)
    setBookDate(selectedDate)
    setBookTime('')
    setShowBookModal(true)
  }

  const submitEditedAppointment = async (bypassConflictCheck = false) => {
    if (!selectedAppt?.id || !editApptDate || !editApptTime || editApptServices.length === 0) return
    setIsUpdatingAppt(true)
    try {
      const combinedDuration = Math.max(
        15,
        editApptServices.reduce((sum, s) => sum + (Number(s?.duration_minutes) || 0), 0)
      )
      const combinedPrice = editApptServices.reduce((sum, s) => sum + (Number(s?.price) || 0), 0)
      const combinedNames = editApptServices.map(s => s.name).join(' + ')

      const startMins = toMinutes(editApptTime)
      const endMins = startMins + combinedDuration
      const newStartStr = `${editApptTime.slice(0, 5)}:00`
      const newEndStr = `${Math.floor(endMins / 60).toString().padStart(2, '0')}:${(endMins % 60).toString().padStart(2, '0')}:00`

      const targetBarberId = selectedAppt.barber_id || selectedBarberId
      if (!bypassConflictCheck) {
        const { data: conflicts, error: conflictErr } = await supabase
          .from('appointments')
          .select('id, clients ( name ), start_time, end_time, status, notes, is_blockout')
          .eq('barber_id', targetBarberId)
          .eq('appointment_date', editApptDate)
          .neq('status', 'cancelled')
        if (conflictErr) throw conflictErr

        const overlappingAppts = (conflicts || []).filter((c: any) => {
          if (String(c.id) === String(selectedAppt.id)) return false
          const cStart = toMinutes(c.start_time)
          const cEnd = toMinutes(c.end_time)
          return startMins < cEnd && endMins > cStart
        })

        const isOut = isOutsideBarberSchedule(editApptDate, editApptTime, combinedDuration)

        if (overlappingAppts.length > 0 || isOut) {
          const activeBarberName = barbers.find(b => b.id === targetBarberId)?.name || 'Barber'
          const reasons: string[] = overlappingAppts.map((c: any) => {
            const cLabel = c.is_blockout
              ? (c.notes || 'Blocked Time')
              : c.status === 'blocked'
              ? 'Blocked Time'
              : (c.clients?.name || 'Walk-In')
            return `Overlaps with ${cLabel} (${formatTime(c.start_time)} – ${formatTime(c.end_time)})`
          })
          if (isOut) {
            reasons.push(`Falls outside ${activeBarberName}'s scheduled working hours / on a scheduled day off`)
          }

          setIsUpdatingAppt(false)
          setConflictOverridePrompt({
            title: 'Schedule Conflict Override',
            proposedSummary: `Update ${selectedAppt.clients?.name || 'Appointment'} — ${combinedNames} (${formatTime(editApptTime)} – ${formatTime(newEndStr)}) on ${formatDisplayDate(editApptDate)}`,
            reasons,
            onConfirm: () => {
              setConflictOverridePrompt(null)
              submitEditedAppointment(true)
            }
          })
          return
        }
      }

      const trimmedEditNotes = editApptNotes.trim()
      const updatedNotes = editApptServices.length > 1
        ? `[Services: ${combinedNames} ($${combinedPrice})]${trimmedEditNotes ? ` - ${trimmedEditNotes}` : ''}`
        : (trimmedEditNotes || null)

      const oldApptDate = (selectedAppt.appointment_date || selectedDate).split('T')[0].trim()
      const oldApptStart = (selectedAppt.start_time || '').slice(0, 5)
      const hasScheduleChange = oldApptDate !== editApptDate || oldApptStart !== editApptTime.slice(0, 5)
      const editedApptSnapshot = selectedAppt

      const { error: updateErr } = await supabase
        .from('appointments')
        .update({
          appointment_date: editApptDate,
          start_time: newStartStr,
          end_time: newEndStr,
          service_id: editApptServices[0]?.id || null,
          notes: updatedNotes
        })
        .eq('id', selectedAppt.id)

      if (updateErr) throw updateErr

      setEditApptMode(false)
      setShowApptModal(false)
      setSelectedAppt(null)
      setRefreshTrigger(prev => prev + 1)

      if (hasScheduleChange && !editedApptSnapshot.is_blockout && editedApptSnapshot.status !== 'blocked') {
        const cleanedDest = cleanPhone(editedApptSnapshot.clients?.phone || '')
        if (cleanedDest.length === 10 && cleanedDest !== '0000000000') {
          const barberName = barbers.find(b => b.id === targetBarberId)?.name || 'LifeStyle Barber'
          const oldFriendlyDate = new Date(oldApptDate + 'T12:00:00Z').toLocaleDateString('en-US', {
            month: 'long',
            day: 'numeric',
            year: 'numeric',
            timeZone: 'UTC'
          })
          const newFriendlyDate = new Date(editApptDate + 'T12:00:00Z').toLocaleDateString('en-US', {
            month: 'long',
            day: 'numeric',
            year: 'numeric',
            timeZone: 'UTC'
          })
          const oldTimeFormatted = formatTime(oldApptStart)
          const newTimeFormatted = formatTime(editApptTime)
          const firstName = getFriendlyFirstName(editedApptSnapshot.clients?.name)
          const draftedMsg = `Hey ${firstName}, your ${combinedNames} appointment at LifeStyle Barber with ${barberName} has been rescheduled from ${oldFriendlyDate} at ${oldTimeFormatted} to ${newFriendlyDate} at ${newTimeFormatted}. Please let us know if you need any adjustments! Reply STOP to unsubscribe.`

          setOverrideQuietHoursSendNow(false)
          setSmsConfirmMessage(draftedMsg)
          setSmsConfirmPrompt({
            contextTitle: 'Appointment Move / Reschedule Text',
            changeSummary: `${barberName}: ${oldFriendlyDate} at ${oldTimeFormatted} → ${newFriendlyDate} at ${newTimeFormatted}`,
            clientName: editedApptSnapshot.clients?.name || 'Client',
            clientPhone: cleanedDest,
            appointmentId: editedApptSnapshot.id,
          })
        }
      }
    } catch (err: any) {
      console.error('Failed to update appointment:', err)
      alert(`Failed to update appointment: ${err?.message || 'Database error'}`)
    } finally {
      setIsUpdatingAppt(false)
    }
  }

  const handleSaveEditedAppointment = async (e: React.FormEvent) => {
    e.preventDefault()
    await submitEditedAppointment(false)
  }

  const handleSaveNotes = async () => {
    if (!selectedAppt?.clients?.id) return
    setIsUpdatingAppt(true)
    try {
      await supabase.from('clients').update({ notes: clientNotes }).eq('id', selectedAppt.clients.id)

      // Gracefully notify owner if phone is configured
      const ownerBarber = barbers.find(b => b.role === 'owner')
      if (ownerBarber?.phone) {
        try {
          await supabase.functions.invoke('twilio-sms', {
            body: {
              to: ownerBarber.phone,
              message: `LifeStyle Barber: Notes updated for ${selectedAppt.clients?.name || 'Client'}: "${clientNotes}"`
            }
          })
        } catch (smsErr) {
          console.warn("SMS note notification skipped or failed:", smsErr)
        }
      }

      setShowApptModal(false)
      setRefreshTrigger(prev => prev + 1)
    } catch (err) { console.error(err); alert("Failed to save notes.") }
    finally { setIsUpdatingAppt(false) }
  }

  const handleDeleteAppt = async () => {
    const appt = selectedAppt
    if (!appt?.id) return
    if (!confirm('Delete this appointment? It will be removed from the calendar.')) return
    setIsUpdatingAppt(true)
    try {
      // Soft-delete: RLS blocks hard DELETE. All time-rail fetches filter .neq('status', 'cancelled').
      const { error } = await supabase.from('appointments').update({ status: 'cancelled' }).eq('id', appt.id)
      if (error) throw error
      setShowApptModal(false)
      setSelectedAppt(null)
      setRefreshTrigger(prev => prev + 1)
    } catch (err) { console.error(err); alert("Failed to delete appointment.") }
    finally { setIsUpdatingAppt(false) }
  }

  const handleNoShow = async () => {
    const appt = selectedAppt
    if (!appt?.id) return
    setIsUpdatingAppt(true)
    try {
      const { error } = await supabase.from('appointments').update({ status: 'no-show' }).eq('id', appt.id)
      if (error) throw error

      const matchedBarber = barbers.find(b => b.id === appt.barber_id) || barbers.find(b => b.id === selectedBarberId)
      const barberName = matchedBarber?.name ? matchedBarber.name.split(' ')[0] : 'Your Barber'
      const friendlyDate = new Date(`${appt.appointment_date}T00:00:00Z`).toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC',
      })
      const friendlyTime = formatTime(appt.start_time)
      const clientId = appt.clients?.id || appt.client_id

      if (clientId) {
        let currentNoShowCount = appt.clients?.no_show_count || 0
        const { data: latestClient } = await supabase
          .from('clients')
          .select('no_show_count')
          .eq('id', clientId)
          .maybeSingle()
        if (latestClient && typeof latestClient.no_show_count === 'number') {
          currentNoShowCount = latestClient.no_show_count
        }

        const redListReason = `No-Call / No-Show on ${friendlyDate} (${friendlyTime}) with ${barberName}`
        const { error: clientUpdateErr } = await supabase
          .from('clients')
          .update({
            is_red_listed: true,
            red_listed_by: barberName,
            red_listed_reason: redListReason,
            no_show_count: currentNoShowCount + 1,
          })
          .eq('id', clientId)
        if (clientUpdateErr) throw clientUpdateErr
      }

      const rawPhone = cleanPhone(appt.clients?.phone || '')
      const firstName = getFriendlyFirstName(appt.clients?.name)
      let smsDispatched = false
      if (rawPhone.length === 10 && rawPhone !== '0000000000') {
        try {
          await supabase.functions.invoke('twilio-sms', {
            body: {
              to: `+1${rawPhone}`,
              message: `Hey ${firstName}, we missed you at LifeStyle Barber today with ${barberName} (${friendlyDate} at ${friendlyTime}) and wanted to make sure everything is okay! We know emergencies happen, so please let us know if something came up. As a reminder, we ask for 24 hours notice to cancel out of respect for our barbers' time, and missed spots may carry a fee before your next cut. Hope all is well! Reply STOP to unsubscribe.`
            }
          })
          smsDispatched = true
        } catch (smsErr) {
          console.warn('No-show policy SMS skipped or failed:', smsErr)
        }
      }

      const clientLabel = appt.clients?.name || 'Client'
      setStatusBanner({
        type: 'success',
        message: smsDispatched
          ? `${clientLabel} marked as No-Show, Red-Listed (Owes ${barberName}), and sent the 24-hour policy SMS.`
          : `${clientLabel} marked as No-Show and Red-Listed (Owes ${barberName}). No valid phone on file for SMS.`
      })
      setShowApptModal(false)
      setSelectedAppt(null)
      setRefreshTrigger(prev => prev + 1)
    } catch (err) {
      console.error(err)
      alert('Failed to mark no-show.')
    } finally {
      setIsUpdatingAppt(false)
    }
  }

  const handleClearRedList = async (clientId: string, clientLabel?: string) => {
    if (!clientId) return
    setIsUpdatingRedList(true)
    setIsUpdatingAppt(true)
    try {
      const { error } = await supabase
        .from('clients')
        .update({
          is_red_listed: false,
          red_listed_by: null,
          red_listed_reason: null,
        })
        .eq('id', clientId)
      if (error) throw error

      setClientsList(prev => prev.map(c => c.id === clientId ? { ...c, is_red_listed: false, red_listed_by: null, red_listed_reason: null } : c))
      setSelectedAppt((prev: any) => prev?.clients?.id === clientId ? { ...prev, clients: { ...prev.clients, is_red_listed: false, red_listed_by: null, red_listed_reason: null } } : prev)
      setSelectedProfileClient(prev => prev?.id === clientId ? { ...prev, is_red_listed: false, red_listed_by: null, red_listed_reason: null } : prev)
      setRefreshTrigger(prev => prev + 1)
      setStatusBanner({
        type: 'success',
        message: `${clientLabel || 'Client'} cleared from the Red List.`
      })
    } catch (err: any) {
      console.error('Failed to clear Red List:', err)
      alert(`Failed to clear Red List: ${err?.message || 'Database error'}`)
    } finally {
      setIsUpdatingRedList(false)
      setIsUpdatingAppt(false)
    }
  }

  const handleManualRedList = async (clientId: string, owedBarber: string, reasonInput?: string, clientLabel?: string) => {
    if (!clientId) return
    const barberLabel = (owedBarber || 'Michael').trim()
    const finalReason = (reasonInput || '').trim() || `Manual Red List Flag by ${barberLabel}`
    setIsUpdatingRedList(true)
    setIsUpdatingAppt(true)
    try {
      const { error } = await supabase
        .from('clients')
        .update({
          is_red_listed: true,
          red_listed_by: barberLabel,
          red_listed_reason: finalReason,
        })
        .eq('id', clientId)
      if (error) throw error

      setClientsList(prev => prev.map(c => c.id === clientId ? { ...c, is_red_listed: true, red_listed_by: barberLabel, red_listed_reason: finalReason } : c))
      setSelectedAppt((prev: any) => prev?.clients?.id === clientId ? { ...prev, clients: { ...prev.clients, is_red_listed: true, red_listed_by: barberLabel, red_listed_reason: finalReason } } : prev)
      setSelectedProfileClient(prev => prev?.id === clientId ? { ...prev, is_red_listed: true, red_listed_by: barberLabel, red_listed_reason: finalReason } : prev)
      setManualRedListReason('')
      setRefreshTrigger(prev => prev + 1)
      setStatusBanner({
        type: 'success',
        message: `${clientLabel || 'Client'} added to the Red List (Owes ${barberLabel}).`
      })
    } catch (err: any) {
      console.error('Failed to Red List client:', err)
      alert(`Failed to Red List client: ${err?.message || 'Database error'}`)
    } finally {
      setIsUpdatingRedList(false)
      setIsUpdatingAppt(false)
    }
  }

  const handleExportBackupCSV = () => {
    const csvEscape = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`
    const headers = [
      'Name',
      'Phone',
      'Persistent Cut Notes',
      'Total Appointments',
      'No-Show Count',
      'Red Listed',
      'Red Listed By',
      'Red List Reason',
    ]

    const rows = clientsList.map(client => {
      const apptCount = (allAppointmentsByClient[client.id] || []).length
      return [
        csvEscape(client.name || ''),
        csvEscape(formatPhoneNumber(client.phone || '')),
        csvEscape(client.notes || ''),
        csvEscape(apptCount),
        csvEscape(client.no_show_count || 0),
        csvEscape(client.is_red_listed ? 'Yes' : 'No'),
        csvEscape(client.red_listed_by || ''),
        csvEscape(client.red_listed_reason || ''),
      ].join(',')
    })

    const csvContent = [headers.map(csvEscape).join(','), ...rows].join('\r\n')
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const now = new Date()
    const dateStamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const link = document.createElement('a')
    link.href = url
    link.download = `lifestyle-barber-clients-backup-${dateStamp}.csv`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  // --- VAGARO CSV PARSER & BULK UPSERT UTILITY ---
  const handleVagaroCSVUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setIsImportingCSV(true)
    setCsvImportResult(null)

    try {
      const text = await file.text()
      const rows = parseCSV(text)
      if (rows.length === 0) {
        alert("The selected CSV file is empty.")
        return
      }

      // Dynamically locate the header row (Vagaro places a 5-row banner at the top, so headers sit on Row 6 / index 5)
      let headerIdx = rows.findIndex(row =>
        row.some(cell => cell.toLowerCase() === 'first name') &&
        row.some(cell => cell.toLowerCase() === 'last name' || cell.toLowerCase() === 'mobile')
      )
      if (headerIdx === -1) {
        headerIdx = rows.length > 5 ? 5 : 0
      }

      const headerRow = rows[headerIdx] || []
      const findColIdx = (keywords: string[], fallbackIdx: number) => {
        const idx = headerRow.findIndex(col => keywords.includes(col.trim().toLowerCase()))
        return idx !== -1 ? idx : fallbackIdx
      }

      const firstNameIdx = findColIdx(['first name'], 0)
      const lastNameIdx = findColIdx(['last name'], 1)
      const emailIdx = findColIdx(['email'], 5)
      const mobileIdx = findColIdx(['mobile', 'cell', 'phone'], 9)
      const appBookedIdx = findColIdx(['app. booked', 'appointments booked', 'app booked'], 15)
      const employeesSeenIdx = findColIdx(['employees seen', 'employee seen', 'staff seen'], 21)

      const isInvalidText = (val: string) => {
        const v = (val || '').trim()
        if (!v || v === '---' || v === '--' || v.toLowerCase() === 'n/a') return true
        if (/^\?+$/.test(v) || v.includes('???')) return true
        return false
      }

      const parsedByPhone = new Map<string, { name: string, phone: string, notes: string }>()

      for (let i = headerIdx + 1; i < rows.length; i++) {
        const row = rows[i]
        if (!row || row.length === 0) continue

        // Strip Mobile down to a 10-digit phone number (if 11 digits starting with 1, strip leading 1)
        const rawMobile = (row[mobileIdx] || '').trim()
        let digits = rawMobile.replace(/\D/g, '')
        if (digits.length === 11 && digits.startsWith('1')) {
          digits = digits.slice(1)
        }
        if (digits.length !== 10 || digits === '0000000000') {
          continue
        }

        const rawFirst = (row[firstNameIdx] || '').trim()
        const rawLast = (row[lastNameIdx] || '').trim()
        const rawEmail = (row[emailIdx] || '').trim()
        const rawAppBooked = (row[appBookedIdx] || '').trim()
        const rawEmployeesSeen = (row[employeesSeenIdx] || '').trim()

        const validEmail = isInvalidText(rawEmail) ? '' : rawEmail
        const validAppBooked = (isInvalidText(rawAppBooked) || rawAppBooked === '0') ? '' : rawAppBooked
        const validEmployeesSeen = isInvalidText(rawEmployeesSeen) ? '' : rawEmployeesSeen

        // INVALID NAME RULE: If First Name or Last Name consists of question marks (e.g., ???????), ---, or is empty,
        // DO NOT skip the contact as long as they have a valid phone number. Assign a clean fallback name.
        const validFirst = isInvalidText(rawFirst) ? '' : rawFirst
        const validLast = isInvalidText(rawLast) ? '' : rawLast
        const hasCorruptedName = isInvalidText(rawFirst) || isInvalidText(rawLast)

        let cleanName = [validFirst, validLast].filter(Boolean).join(' ').trim()
        if (!cleanName || (hasCorruptedName && !validFirst)) {
          if (!cleanName) {
            cleanName = validEmail ? `Unknown (${validEmail})` : 'Unknown Client'
          }
        }

        // Build initial metadata note combining non-empty Vagaro fields
        const metaParts: string[] = []
        if (validEmail) metaParts.push(`Email: ${validEmail}`)
        if (validEmployeesSeen) metaParts.push(`Barber: ${validEmployeesSeen}`)
        if (validAppBooked) metaParts.push(`Vagaro Cuts: ${validAppBooked}`)
        const vagaroNote = metaParts.join(' | ')

        const existingInCsv = parsedByPhone.get(digits)
        if (!existingInCsv) {
          parsedByPhone.set(digits, {
            name: cleanName,
            phone: digits,
            notes: vagaroNote
          })
        } else {
          // Prefer real name over Unknown fallback if duplicated in CSV
          const bestName = existingInCsv.name.startsWith('Unknown') && !cleanName.startsWith('Unknown')
            ? cleanName
            : existingInCsv.name
          const mergedNote = existingInCsv.notes
            ? (vagaroNote && !existingInCsv.notes.includes(vagaroNote) ? `${existingInCsv.notes} | ${vagaroNote}` : existingInCsv.notes)
            : vagaroNote
          parsedByPhone.set(digits, {
            name: bestName,
            phone: digits,
            notes: mergedNote
          })
        }
      }

      const contactsToSync = Array.from(parsedByPhone.values())
      if (contactsToSync.length === 0) {
        alert("No valid 10-digit mobile contacts were found in this CSV.")
        return
      }

      // Fetch existing clients in Supabase so custom barber notes are preserved/appended, never overwritten
      let existingDbClients: any[] = []
      const pageSize = 1000
      let from = 0
      while (true) {
        const { data: batch, error: fetchErr } = await supabase
          .from('clients')
          .select('phone, name, notes')
          .range(from, from + pageSize - 1)
        if (fetchErr) throw fetchErr
        if (!batch || batch.length === 0) break
        existingDbClients = [...existingDbClients, ...batch]
        if (batch.length < pageSize) break
        from += pageSize
      }

      const existingMap = new Map<string, { name: string, notes: string | null }>()
      for (const c of existingDbClients) {
        if (c.phone) existingMap.set(cleanPhone(c.phone), { name: c.name, notes: c.notes })
      }

      const finalPayload = contactsToSync.map(contact => {
        const existing = existingMap.get(contact.phone)
        let resolvedName = contact.name
        let resolvedNotes = contact.notes || null

        if (existing) {
          // If Supabase already has a real name and CSV has Unknown fallback, preserve the existing name
          if (contact.name.startsWith('Unknown') && existing.name && !existing.name.startsWith('Unknown')) {
            resolvedName = existing.name
          }
          // Preserve existing custom barber notes and append Vagaro metadata if not already present
          const existingNoteTrimmed = (existing.notes || '').trim()
          if (existingNoteTrimmed) {
            if (contact.notes && !existingNoteTrimmed.includes(contact.notes)) {
              resolvedNotes = `${existingNoteTrimmed} | ${contact.notes}`
            } else {
              resolvedNotes = existingNoteTrimmed
            }
          }
        }

        return {
          name: resolvedName,
          phone: contact.phone,
          notes: resolvedNotes
        }
      })

      // Bulk-upsert in batches of 150 matching on `phone`
      const batchSize = 150
      for (let i = 0; i < finalPayload.length; i += batchSize) {
        const chunk = finalPayload.slice(i, i + batchSize)
        const { error: upsertErr } = await supabase
          .from('clients')
          .upsert(chunk, { onConflict: 'phone' })
        if (upsertErr) throw upsertErr
      }

      setCsvImportResult(`Successfully imported & synced ${finalPayload.length} Vagaro client profiles.`)
      setRefreshTrigger(prev => prev + 1)
    } catch (err: any) {
      console.error("Vagaro CSV Import failed:", err)
      alert(`Failed to import Vagaro CSV: ${err?.message || 'Unknown error'}`)
    } finally {
      setIsImportingCSV(false)
      if (csvFileInputRef.current) {
        csvFileInputRef.current.value = ''
      }
    }
  }

  // --- MANUAL ADD CLIENT & CLIENT PROFILE MODAL HANDLERS ---
  const handleAddManualClient = async (e: React.FormEvent) => {
    e.preventDefault()
    const liveName = newClientName.trim()
    const livePhone = cleanPhone(newClientPhone)
    const liveNotes = newClientNotes.trim()

    if (!liveName || livePhone.length !== 10) {
      alert("Please provide a client name and a valid 10-digit phone number.")
      return
    }

    setIsSavingNewClient(true)
    try {
      const { data: existing } = await supabase
        .from('clients')
        .select('id, notes')
        .eq('phone', livePhone)
        .maybeSingle()

      let mergedNotes: string | null = liveNotes || null
      if (existing?.notes && existing.notes.trim()) {
        mergedNotes = liveNotes && !existing.notes.includes(liveNotes)
          ? `${existing.notes.trim()} | ${liveNotes}`
          : existing.notes.trim()
      }

      const { error } = await supabase
        .from('clients')
        .upsert({ name: liveName, phone: livePhone, notes: mergedNotes }, { onConflict: 'phone' })
      if (error) throw error

      setShowAddClientModal(false)
      setNewClientName('')
      setNewClientPhone('')
      setNewClientNotes('')
      setRefreshTrigger(prev => prev + 1)
    } catch (err: any) {
      console.error("Failed to add client:", err)
      alert(`Failed to save client: ${err?.message || 'Database error'}`)
    } finally {
      setIsSavingNewClient(false)
    }
  }

  const handleOpenClientProfile = async (client: Client) => {
    const activeBarberName = barbers.find(b => b.id === selectedBarberId)?.name?.split(' ')[0] || 'Michael'
    setSelectedProfileClient(client)
    setProfileName(client.name || '')
    setProfilePhone(formatPhoneNumber(client.phone || ''))
    setProfileNotes(client.notes || '')
    setManualRedListBarber(client.red_listed_by || activeBarberName)
    setManualRedListReason(client.red_listed_reason || '')

    const cachedAppts = allAppointmentsByClient[client.id] || []
    setProfileAppts(cachedAppts)
    setLoadingProfileAppts(true)

    try {
      const { data: freshAppts, error } = await supabase
        .from('appointments')
        .select('*')
        .eq('client_id', client.id)
        .order('appointment_date', { ascending: false })
        .order('start_time', { ascending: false })
      if (!error && freshAppts) {
        const validAppts = freshAppts.filter(a => !a.is_blockout && a.status !== 'blocked')
        setProfileAppts(validAppts)
      }
    } catch (err) {
      console.error("Failed to fetch client appointment history:", err)
    } finally {
      setLoadingProfileAppts(false)
    }
  }

  const handleSaveClientProfile = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedProfileClient?.id) return

    const updatedName = profileName.trim()
    const updatedPhone = cleanPhone(profilePhone)
    const updatedNotes = profileNotes.trim()

    if (!updatedName || updatedPhone.length !== 10) {
      alert("Please enter a valid client name and 10-digit phone number.")
      return
    }

    setIsSavingProfile(true)
    try {
      const { error } = await supabase
        .from('clients')
        .update({
          name: updatedName,
          phone: updatedPhone,
          notes: updatedNotes || null
        })
        .eq('id', selectedProfileClient.id)

      if (error) throw error

      setSelectedProfileClient((prev: any) => prev ? {
        ...prev,
        name: updatedName,
        phone: updatedPhone,
        notes: updatedNotes || null
      } : null)
      setRefreshTrigger(prev => prev + 1)
      alert("Client profile saved!")
    } catch (err: any) {
      console.error("Failed to update client profile:", err)
      alert(`Failed to update client profile: ${err?.message || 'Database error'}`)
    } finally {
      setIsSavingProfile(false)
    }
  }

  // --- SERVICES LOGIC ---
  const handleAddMasterService = async (e: React.FormEvent) => {
    e.preventDefault(); if (!newMasterName) return
    try { await supabase.from('master_services').insert({ name: newMasterName }); setNewMasterName(''); supabase.from('master_services').select('name').order('name').then(({data}) => { if(data) setMasterServices(data.map(s => s.name)) }) } catch (err) { console.error(err) }
  }
  const handleAddService = async (e: React.FormEvent) => {
    e.preventDefault(); if (!newServiceName || !newServicePrice || !selectedBarberId) return
    setIsSubmittingService(true)
    try { await supabase.from('services').insert({ barber_id: selectedBarberId, name: newServiceName, duration_minutes: parseInt(newServiceDuration), price: parseFloat(newServicePrice), is_active: true }); setNewServiceName(''); setNewServicePrice(''); setNewServiceDuration('30'); fetchMyServices() } catch (err) { console.error(err) } finally { setIsSubmittingService(false) }
  }
  const handleDeleteService = async (serviceId: string) => {
    try {
      // 1. Detach any appointments referencing this service_id so foreign-key constraints never block deletion
      await supabase
        .from('appointments')
        .update({ service_id: null })
        .eq('service_id', serviceId)

      // 2. Permanently delete the service row (and select('id') to verify RLS actually deleted the row)
      const { data: deletedRows, error } = await supabase
        .from('services')
        .delete()
        .eq('id', serviceId)
        .select('id')

      // 3. Fallback: if DELETE failed or affected 0 rows, soft-archive with is_active: false
      if (error || !deletedRows || deletedRows.length === 0) {
        const { error: archiveErr } = await supabase
          .from('services')
          .update({ is_active: false })
          .eq('id', serviceId)
        if (archiveErr) {
          setStatusBanner({
            type: 'error',
            message: `Failed to delete service: ${archiveErr.message || error?.message || 'Permission denied'}`
          })
          alert(`Failed to delete service: ${archiveErr.message || error?.message || 'Permission denied'}`)
          return
        }
      }

      setMyServices(prev => prev.filter(s => s.id !== serviceId))
      setAdminServices(prev => prev.filter(s => s.id !== serviceId))
      setConfirmDeleteServiceId(null)
      setStatusBanner({
        type: 'success',
        message: 'Service permanently removed from your menu.'
      })
      await fetchMyServices()
    } catch (err: any) {
      console.error('Failed to delete service:', err)
      setStatusBanner({
        type: 'error',
        message: `Failed to delete service: ${err?.message || 'Database error'}`
      })
      alert(`Failed to delete service: ${err?.message || 'Database error'}`)
    }
  }
  const handleSaveEdit = async (serviceId: string) => {
    try { await supabase.from('services').update({ name: editForm.name, duration_minutes: parseInt(editForm.duration), price: parseFloat(editForm.price) }).eq('id', serviceId); setEditingServiceId(null); fetchMyServices() } catch (err) { console.error(err) }
  }

  // --- AUTH LOGIC (SHARED 6-DIGIT SHOP PIN + BRUTE-FORCE COOLDOWN) ---
  const submitPin = async (pinValue: string) => {
    if (isAuthenticating || cooldownSeconds > 0 || pinValue.length !== 6) return
    setIsAuthenticating(true)
    setAuthError('')
    const { error } = await supabase.auth.signInWithPassword({
      email: SHOP_AUTH_EMAIL,
      password: pinValue,
    })
    if (error) {
      const nextAttempts = failedPinAttempts + 1
      setPin('')
      if (nextAttempts >= MAX_PIN_ATTEMPTS) {
        const lockTs = Date.now() + PIN_COOLDOWN_MS
        setFailedPinAttempts(0)
        setPinLockUntil(lockTs)
        setCooldownSeconds(Math.ceil(PIN_COOLDOWN_MS / 1000))
        setAuthError('')
        try {
          localStorage.setItem(PIN_ATTEMPTS_STORAGE_KEY, '0')
          localStorage.setItem(PIN_LOCK_STORAGE_KEY, String(lockTs))
        } catch {}
      } else {
        setFailedPinAttempts(nextAttempts)
        setAuthError(`Invalid passcode. ${MAX_PIN_ATTEMPTS - nextAttempts} attempt${MAX_PIN_ATTEMPTS - nextAttempts === 1 ? '' : 's'} left before 60s lock.`)
        try {
          localStorage.setItem(PIN_ATTEMPTS_STORAGE_KEY, String(nextAttempts))
        } catch {}
      }
    } else {
      setFailedPinAttempts(0)
      setPinLockUntil(0)
      setCooldownSeconds(0)
      setPin('')
      setAuthError('')
      try {
        localStorage.removeItem(PIN_LOCK_STORAGE_KEY)
        localStorage.setItem(PIN_ATTEMPTS_STORAGE_KEY, '0')
      } catch {}
    }
    setIsAuthenticating(false)
  }

  const updatePinValue = (nextValue: string) => {
    if (isAuthenticating || cooldownSeconds > 0) return
    const digitsOnly = nextValue.replace(/\D/g, '').slice(0, 6)
    setPin(digitsOnly)
    if (authError && digitsOnly.length > 0) setAuthError('')
    if (digitsOnly.length === 6) {
      submitPin(digitsOnly)
    }
  }

  const handleKeypadDigit = (digit: string) => {
    if (pin.length >= 6 || isAuthenticating || cooldownSeconds > 0) return
    updatePinValue(pin + digit)
  }

  const handleKeypadBackspace = () => {
    if (isAuthenticating || cooldownSeconds > 0 || pin.length === 0) return
    setPin((prev) => prev.slice(0, -1))
  }

  const handleKeypadClear = () => {
    if (isAuthenticating || cooldownSeconds > 0) return
    setPin('')
    setAuthError('')
  }

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    await submitPin(pin)
  }

  const handleLogout = async () => { await supabase.auth.signOut() }

  if (loading) return <div className="min-h-screen bg-[var(--color-brand-900)] flex items-center justify-center animate-pulse text-[var(--color-brand-muted)]">Checking credentials...</div>

  // --- LOGIN SCREEN (6-DIGIT SHOP PASSCODE PIN PAD) ---
  if (!session) {
    const isLockedOut = cooldownSeconds > 0
    return (
      <div className="min-h-screen bg-[var(--color-brand-900)] text-[var(--color-brand-light)] font-sans flex flex-col items-center justify-center p-4 sm:p-6 relative">
        {/* Top Navigation & Theme Header */}
        <div className="w-full max-w-sm flex items-center justify-between mb-4">
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold border border-[var(--color-brand-periwinkle)]/50 bg-[var(--color-brand-periwinkle)]/15 text-[var(--color-brand-periwinkle)] hover:bg-[var(--color-brand-periwinkle)] hover:text-white transition-all"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Shop Home
          </Link>
          <button
            type="button"
            onClick={toggleTheme}
            title={isLight ? 'Switch to Dark Mode' : 'Switch to Light Mode (Matt Mode)'}
            className="p-2 rounded-full border border-[var(--color-brand-periwinkle)]/50 bg-[var(--color-brand-periwinkle)]/15 text-[var(--color-brand-periwinkle)] hover:bg-[var(--color-brand-periwinkle)] hover:text-white transition-all cursor-pointer"
            aria-label="Toggle Light/Dark Theme"
          >
            {isLight ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
          </button>
        </div>

        <div className="w-full max-w-sm card-violet-gold p-6 sm:p-8 rounded-2xl">
          <div className="flex flex-col items-center text-center mb-6">
            <div className="bg-[var(--color-brand-900)] p-3.5 rounded-full border border-[#D4AF37]/60 shadow-[0_0_10px_rgba(212,175,55,0.2)] mb-3">
              <Lock className="w-7 h-7 text-[var(--color-brand-gold)]" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">Shop Passcode</h1>
            <p className="text-xs text-[var(--color-brand-muted)] mt-1">
              Enter the 6-digit LifeStyle Barber Portal PIN
            </p>
          </div>

          {isLockedOut && (
            <div className="bg-red-500/15 border border-red-500/50 text-red-500 text-xs sm:text-sm font-bold p-3 rounded-xl mb-5 text-center">
              Too many failed attempts. Try again in {cooldownSeconds}s.
            </div>
          )}

          {!isLockedOut && authError && (
            <div className="bg-red-500/15 border border-red-500/50 text-red-500 text-xs sm:text-sm font-semibold p-3 rounded-xl mb-5 text-center">
              {authError}
            </div>
          )}

          <form onSubmit={handleLogin} className="space-y-6">
            {/* 6 Visual PIN Boxes + Direct Keyboard / Mobile Numpad Overlay Input */}
            <div
              onClick={() => pinInputRef.current?.focus()}
              className="relative flex items-center justify-center gap-2.5 sm:gap-3 cursor-text py-1"
            >
              <input
                ref={pinInputRef}
                type="password"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="one-time-code"
                maxLength={6}
                disabled={isLockedOut || isAuthenticating}
                value={pin}
                onChange={(e) => updatePinValue(e.target.value)}
                aria-label="6-digit Shop Passcode"
                className="opacity-0 absolute inset-0 w-full h-full cursor-pointer disabled:cursor-not-allowed z-10"
              />
              {[0, 1, 2, 3, 4, 5].map((idx) => {
                const isFilled = idx < pin.length
                const isNext = idx === pin.length && !isLockedOut
                return (
                  <div
                    key={idx}
                    className={`w-10 h-12 sm:w-11 sm:h-13 rounded-xl border-2 flex items-center justify-center transition-all ${
                      isFilled
                        ? 'border-[var(--color-brand-periwinkle)] bg-[var(--color-brand-periwinkle)]/15 shadow-sm'
                        : isNext
                        ? 'border-[var(--color-brand-accent)] bg-[var(--color-brand-900)]'
                        : 'border-[var(--color-brand-700)] bg-[var(--color-brand-900)]'
                    }`}
                  >
                    <div
                      className={`w-3 h-3 rounded-full transition-all duration-150 ${
                        isFilled
                          ? 'bg-[var(--color-brand-periwinkle)] scale-110 shadow-[0_0_8px_var(--color-brand-periwinkle)]'
                          : 'bg-[var(--color-brand-700)]/60 scale-75'
                      }`}
                    />
                  </div>
                )
              })}
            </div>

            {/* On-Screen Touch Keypad */}
            <div className="grid grid-cols-3 gap-2.5 sm:gap-3">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
                <button
                  key={digit}
                  type="button"
                  disabled={isLockedOut || isAuthenticating || pin.length >= 6}
                  onClick={() => handleKeypadDigit(digit)}
                  className="h-14 rounded-xl bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] hover:border-[var(--color-brand-periwinkle)] active:bg-[var(--color-brand-periwinkle)] active:text-white text-xl font-bold text-[var(--color-brand-light)] transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed select-none shadow-sm"
                >
                  {digit}
                </button>
              ))}
              <button
                type="button"
                disabled={isLockedOut || isAuthenticating}
                onClick={handleKeypadClear}
                className="h-14 rounded-xl bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] hover:border-[var(--color-brand-periwinkle)] text-xs font-bold uppercase tracking-wider text-[var(--color-brand-muted)] hover:text-[var(--color-brand-periwinkle)] transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed select-none"
              >
                Clear
              </button>
              <button
                type="button"
                disabled={isLockedOut || isAuthenticating || pin.length >= 6}
                onClick={() => handleKeypadDigit('0')}
                className="h-14 rounded-xl bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] hover:border-[var(--color-brand-periwinkle)] active:bg-[var(--color-brand-periwinkle)] active:text-white text-xl font-bold text-[var(--color-brand-light)] transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed select-none shadow-sm"
              >
                0
              </button>
              <button
                type="button"
                disabled={isLockedOut || isAuthenticating || pin.length === 0}
                onClick={handleKeypadBackspace}
                aria-label="Backspace"
                className="h-14 rounded-xl bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] hover:border-[var(--color-brand-periwinkle)] text-[var(--color-brand-muted)] hover:text-[var(--color-brand-periwinkle)] flex items-center justify-center transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed select-none"
              >
                <Delete className="w-5 h-5" />
              </button>
            </div>

            <button
              type="submit"
              disabled={isLockedOut || isAuthenticating || pin.length !== 6}
              className="w-full bg-[var(--color-brand-accent)] text-white font-bold py-3 rounded-xl cursor-pointer hover:brightness-110 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-md text-sm"
            >
              {isAuthenticating ? 'Unlocking Portal...' : 'Unlock Barber Portal'}
            </button>
          </form>
        </div>
      </div>
    )
  }

  // --- CALENDAR RENDER HELPERS ---
  const monthMatrix = generateMonthMatrix(viewMonthDate.getFullYear(), viewMonthDate.getMonth())
  const weekEndDate = new Date(viewWeekStartDate)
  weekEndDate.setDate(weekEndDate.getDate() + 6)
  const isSameMonth = viewWeekStartDate.getMonth() === weekEndDate.getMonth()

  // REUSABLE VAGARO Y-AXIS (Hours with small :15, :30, :45 markers)
  const renderYAxis = () => (
    <div
      className="w-12 sm:w-14 flex-shrink-0 bg-[var(--color-brand-900)] border-r border-[var(--color-brand-700)] sticky left-0 z-30 select-none"
      style={{ height: `${TOTAL_RAIL_HEIGHT}px` }}
    >
      <div className="relative w-full h-full">
        {Array.from({ length: TOTAL_HOURS + 1 }).map((_, hourIdx) => {
          const hour = CALENDAR_START_HOUR + hourIdx
          const normalizedHour = hour % 24
          const hDisplay = normalizedHour === 0 ? '12 AM' : normalizedHour === 12 ? '12 PM' : normalizedHour > 12 ? `${normalizedHour - 12} PM` : `${normalizedHour} AM`
          const isNotLast = hourIdx < TOTAL_HOURS

          return (
            <div key={`y-hour-${hourIdx}`}>
              {/* Top of hour marker */}
              <div
                className="absolute right-0 pr-1 sm:pr-1.5 text-right -translate-y-1/2 flex items-center justify-end gap-0.5 sm:gap-1 pointer-events-none"
                style={{ top: `${hourIdx * PIXELS_PER_HOUR}px` }}
              >
                <span className="text-[9px] sm:text-[11px] font-bold text-[var(--color-brand-light)] leading-none whitespace-nowrap">
                  {hDisplay}
                </span>
                <span className="w-1 sm:w-1.5 h-[1px] bg-[var(--color-brand-700)]/80" />
              </div>

              {/* Sub-hour markers (:15, :30, :45) */}
              {isNotLast && (
                <>
                  <div
                    className="absolute right-0 pr-1 sm:pr-1.5 text-right -translate-y-1/2 flex items-center justify-end gap-0.5 sm:gap-1 pointer-events-none"
                    style={{ top: `${hourIdx * PIXELS_PER_HOUR + SLOT_HEIGHT}px` }}
                  >
                    <span className="text-[8px] sm:text-[9px] font-mono text-[var(--color-brand-muted)] opacity-50 leading-none">
                      :15
                    </span>
                    <span className="w-1 h-[1px] bg-[var(--color-brand-700)]/30" />
                  </div>
                  <div
                    className="absolute right-0 pr-1 sm:pr-1.5 text-right -translate-y-1/2 flex items-center justify-end gap-0.5 sm:gap-1 pointer-events-none"
                    style={{ top: `${hourIdx * PIXELS_PER_HOUR + SLOT_HEIGHT * 2}px` }}
                  >
                    <span className="text-[8px] sm:text-[9px] font-mono text-[var(--color-brand-muted)] opacity-70 leading-none">
                      :30
                    </span>
                    <span className="w-1 sm:w-1.5 h-[1px] bg-[var(--color-brand-700)]/50" />
                  </div>
                  <div
                    className="absolute right-0 pr-1 sm:pr-1.5 text-right -translate-y-1/2 flex items-center justify-end gap-0.5 sm:gap-1 pointer-events-none"
                    style={{ top: `${hourIdx * PIXELS_PER_HOUR + SLOT_HEIGHT * 3}px` }}
                  >
                    <span className="text-[8px] sm:text-[9px] font-mono text-[var(--color-brand-muted)] opacity-50 leading-none">
                      :45
                    </span>
                    <span className="w-1 h-[1px] bg-[var(--color-brand-700)]/30" />
                  </div>
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )

  // --- REUSABLE DRAG-AND-DROP COORDINATE AND RESCHEDULE HELPERS ---
  const updateHoveredSlot = (clientX: number, clientY: number) => {
    const elem = document.elementFromPoint(clientX, clientY)
    let colElem = elem?.closest('[data-day-column="true"]') as HTMLElement | null
    if (!colElem) {
      const allColumns = Array.from(document.querySelectorAll('[data-day-column="true"]')) as HTMLElement[]
      colElem = allColumns.find(c => {
        const r = c.getBoundingClientRect()
        return clientX >= r.left && clientX <= r.right
      }) || null
    }

    if (colElem) {
      const colDate = colElem.dataset.date || selectedDate
      const scrollContainer = (colElem.closest('.overflow-y-auto') || document.querySelector('.overflow-y-auto')) as HTMLElement | null
      const containerTop = scrollContainer ? scrollContainer.getBoundingClientRect().top : colElem.getBoundingClientRect().top
      const scrollTop = scrollContainer ? scrollContainer.scrollTop : 0
      const columnOffsetTop = colElem.offsetTop || 0
      const relativeY = (clientY - containerTop) + scrollTop - columnOffsetTop

      const maxSlotIndex = (TOTAL_HOURS * 4) - 1
      const slotIndex = Math.max(0, Math.min(maxSlotIndex, Math.floor(relativeY / SLOT_HEIGHT)))
      const totalMins = CALENDAR_START_HOUR * 60 + (slotIndex * 15)
      const slotTime = `${Math.floor(totalMins / 60).toString().padStart(2, '0')}:${(totalMins % 60).toString().padStart(2, '0')}`
      setHoveredDropSlot({ date: colDate, time: slotTime })
    } else {
      setHoveredDropSlot(null)
    }
  }

  const executeRescheduleAt = (appt: any, clientX: number, clientY: number) => {
    const elem = document.elementFromPoint(clientX, clientY)
    let colElem = elem?.closest('[data-day-column="true"]') as HTMLElement | null
    if (!colElem) {
      const allColumns = Array.from(document.querySelectorAll('[data-day-column="true"]')) as HTMLElement[]
      colElem = allColumns.find(c => {
        const r = c.getBoundingClientRect()
        return clientX >= r.left && clientX <= r.right
      }) || null
    }

    const scrollContainer = (colElem?.closest('.overflow-y-auto') || document.querySelector('.overflow-y-auto')) as HTMLElement | null

    let targetColumn = colElem
    if (!targetColumn && hoveredDropSlot?.date) {
      targetColumn = document.querySelector(`[data-day-column="true"][data-date="${hoveredDropSlot.date}"]`) as HTMLElement | null
    }
    if (!targetColumn) {
      targetColumn = (document.querySelector(`[data-day-column="true"][data-date="${selectedDate}"]`) as HTMLElement | null)
        || (document.querySelector('[data-day-column="true"]') as HTMLElement | null)
    }

    if (targetColumn) {
      const targetDate = targetColumn.dataset.date || hoveredDropSlot?.date || selectedDate
      const containerTop = scrollContainer ? scrollContainer.getBoundingClientRect().top : targetColumn.getBoundingClientRect().top
      const scrollTop = scrollContainer ? scrollContainer.scrollTop : 0
      const columnOffsetTop = targetColumn.offsetTop || 0
      const relativeY = (clientY - containerTop) + scrollTop - columnOffsetTop

      const maxSlotIndex = (TOTAL_HOURS * 4) - 1
      const slotIndex = Math.max(0, Math.min(maxSlotIndex, Math.floor(relativeY / SLOT_HEIGHT)))
      const totalMins = CALENDAR_START_HOUR * 60 + (slotIndex * 15)
      const slotTime = `${Math.floor(totalMins / 60).toString().padStart(2, '0')}:${(totalMins % 60).toString().padStart(2, '0')}`
      handleDropReschedule(appt, targetDate, slotTime)
    }
  }

  // --- HOLD-TO-DRAG (LONG-PRESS 550ms) MOBILE TOUCH ENGINE ---
  const handleTouchStart = (e: React.TouchEvent, appt: any) => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }

    const touch = e.touches[0]
    isDragActiveRef.current = false
    touchStartRef.current = {
      clientX: touch.clientX,
      clientY: touch.clientY,
      appt,
      hasMoved: false
    }

    // Deliberate Hold-to-Drag delay threshold (550ms)
    longPressTimerRef.current = setTimeout(() => {
      isDragActiveRef.current = true
      setIsTouchDragging(true)
      setTouchDraggedAppt(appt)
      setTouchPos({ x: touch.clientX, y: touch.clientY })

      if (scrollContainerRef.current) {
        scrollContainerRef.current.style.overflow = 'hidden'
        scrollContainerRef.current.style.touchAction = 'none'
      }

      // Subtle haptic feedback when detaching/unsticking
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        try {
          navigator.vibrate(50)
        } catch {
          // ignore if vibration policy restricted
        }
      }
    }, 550)
  }

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!touchStartRef.current) return
    const touch = e.touches[0]
    const dx = touch.clientX - touchStartRef.current.clientX
    const dy = touch.clientY - touchStartRef.current.clientY
    const dist = Math.hypot(dx, dy)

    if (!isDragActiveRef.current) {
      // Hold timer has NOT completed yet
      if (dist >= 10) {
        // Finger moved >10px: user is scrolling the calendar!
        // Immediately abort hold timer and do NOT hijack or prevent default scroll
        if (longPressTimerRef.current) {
          clearTimeout(longPressTimerRef.current)
          longPressTimerRef.current = null
        }
        touchStartRef.current.hasMoved = true
      }
      return
    }

    // Hold timer HAS completed (drag is active):
    touchStartRef.current.hasMoved = true
    if (e.cancelable) {
      e.preventDefault()
    }
    setTouchPos({ x: touch.clientX, y: touch.clientY })
    updateHoveredSlot(touch.clientX, touch.clientY)
  }

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.style.overflow = ''
      scrollContainerRef.current.style.touchAction = ''
    }

    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }

    if (!touchStartRef.current) return
    const { appt, hasMoved } = touchStartRef.current
    const wasDragActive = isDragActiveRef.current

    if (!wasDragActive) {
      // Drag was never activated
      // If released before 550ms and didn't scroll, treat as standard tap -> open details
      if (!hasMoved) {
        justDraggedRef.current = true
        setTimeout(() => { justDraggedRef.current = false }, 350)
        handleOpenAppt(appt)
      }
    } else {
      // Drag WAS active -> execute rescheduling drop
      justDraggedRef.current = true
      setTimeout(() => { justDraggedRef.current = false }, 350)

      const touch = e.changedTouches[0]
      executeRescheduleAt(appt, touch.clientX, touch.clientY)
    }

    touchStartRef.current = null
    isDragActiveRef.current = false
    setIsTouchDragging(false)
    setTouchDraggedAppt(null)
    setTouchPos(null)
    setHoveredDropSlot(null)
  }

  const handleTouchCancel = () => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.style.overflow = ''
      scrollContainerRef.current.style.touchAction = ''
    }

    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    touchStartRef.current = null
    isDragActiveRef.current = false
    setIsTouchDragging(false)
    setTouchDraggedAppt(null)
    setTouchPos(null)
    setHoveredDropSlot(null)
  }

  // --- DESKTOP CLICK / DRAG PARITY ENGINE ---
  const handleMouseDown = (e: React.MouseEvent, appt: any) => {
    if (e.button !== 0) return // Only primary click
    if (justDraggedRef.current) return

    const startX = e.clientX
    const startY = e.clientY
    let hasMoved = false

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const dx = moveEvent.clientX - startX
      const dy = moveEvent.clientY - startY
      const dist = Math.hypot(dx, dy)

      if (!hasMoved && dist >= 6) {
        hasMoved = true
        isDragActiveRef.current = true
        setIsTouchDragging(true)
        setTouchDraggedAppt(appt)
        setTouchPos({ x: moveEvent.clientX, y: moveEvent.clientY })
        if (scrollContainerRef.current) {
          scrollContainerRef.current.style.overflow = 'hidden'
          scrollContainerRef.current.style.touchAction = 'none'
        }
      }

      if (hasMoved) {
        moveEvent.preventDefault()
        setTouchPos({ x: moveEvent.clientX, y: moveEvent.clientY })
        updateHoveredSlot(moveEvent.clientX, moveEvent.clientY)
      }
    }

    const handleMouseUp = (upEvent: MouseEvent) => {
      if (scrollContainerRef.current) {
        scrollContainerRef.current.style.overflow = ''
        scrollContainerRef.current.style.touchAction = ''
      }
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)

      if (hasMoved && isDragActiveRef.current) {
        justDraggedRef.current = true
        setTimeout(() => { justDraggedRef.current = false }, 350)
        executeRescheduleAt(appt, upEvent.clientX, upEvent.clientY)
      }

      isDragActiveRef.current = false
      setIsTouchDragging(false)
      setTouchDraggedAppt(null)
      setTouchPos(null)
      setHoveredDropSlot(null)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
  }

  // REUSABLE TIME-RAIL RENDER ENGINE (ZERO BORDER DRIFT - GRADIENT-BASED)
  const renderTimeGrid = (gridDate: string, gridAppts: any[], isOff: boolean | undefined, isWeekView = false) => {
    const now = new Date()
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const isToday = gridDate === todayStr
    const currentMins = now.getHours() * 60 + now.getMinutes()
    const isWithinHours = currentMins >= CALENDAR_START_HOUR * 60 && currentMins <= CALENDAR_END_HOUR * 60
    const currentTop = ((currentMins - CALENDAR_START_HOUR * 60) / 60) * PIXELS_PER_HOUR
    const shift = !isOff ? getBarberShiftMins(selectedBarberId, gridDate) : null

    const offHoursShadeStyle = isLight
      ? {
          backgroundColor: 'rgba(23, 15, 46, 0.08)',
          backgroundImage:
            'repeating-linear-gradient(45deg, transparent, transparent 10px, rgba(23, 15, 46, 0.06) 10px, rgba(23, 15, 46, 0.06) 20px)',
        }
      : {
          backgroundColor: '#050308',
          backgroundImage: `
            repeating-linear-gradient(-45deg, rgba(255, 255, 255, 0.045) 0px, rgba(255, 255, 255, 0.045) 4px, transparent 4px, transparent 10px),
            linear-gradient(to bottom, rgba(255, 255, 255, 0.04) 1px, transparent 1px)
          `,
          backgroundSize: `auto, 100% ${PIXELS_PER_HOUR}px`,
        }

    return (
      <div
        data-day-column="true"
        data-date={gridDate}
        className={`relative flex-1 w-full ${isWeekView ? 'border-r border-[var(--color-brand-700)]/60 min-w-0' : 'w-full'}`}
        style={{
          height: `${TOTAL_RAIL_HEIGHT}px`,
          backgroundColor: isLight ? undefined : (isOff ? '#050308' : 'rgba(35, 18, 66, 0.55)'),
          backgroundImage: `
            linear-gradient(to bottom, ${isLight ? 'rgba(23, 15, 46, 0.16)' : (isOff ? 'rgba(255, 255, 255, 0.04)' : 'rgba(196, 181, 253, 0.20)')} 1px, transparent 1px),
            linear-gradient(to bottom, ${isLight ? 'rgba(23, 15, 46, 0.06)' : (isOff ? 'rgba(255, 255, 255, 0.015)' : 'rgba(196, 181, 253, 0.07)')} 1px, transparent 1px)
          `,
          backgroundSize: `100% ${PIXELS_PER_HOUR}px, 100% ${SLOT_HEIGHT}px`,
          backgroundRepeat: 'repeat-y',
        }}
      >
        {/* Out-of-Hours Shading on Working Days (Before Shift & After Shift) */}
        {shift && shift.startMins > 0 && (
          <div
            className={`absolute left-0 w-full pointer-events-none z-0 ${
              isLight
                ? 'bg-[var(--color-brand-900)]/50 opacity-50 border-b border-[var(--color-brand-700)]/50'
                : 'bg-black/75 opacity-95 border-b border-[var(--color-brand-700)]'
            }`}
            style={{
              top: 0,
              height: `${shift.startMins * (PIXELS_PER_HOUR / 60)}px`,
              ...offHoursShadeStyle,
            }}
          />
        )}
        {shift && shift.endMins < 24 * 60 && (
          <div
            className={`absolute left-0 w-full pointer-events-none z-0 ${
              isLight
                ? 'bg-[var(--color-brand-900)]/50 opacity-50 border-t border-[var(--color-brand-700)]/50'
                : 'bg-black/75 opacity-95 border-t border-[var(--color-brand-700)]'
            }`}
            style={{
              top: `${shift.endMins * (PIXELS_PER_HOUR / 60)}px`,
              bottom: 0,
              ...offHoursShadeStyle,
            }}
          />
        )}

        {/* Non-working day shaded diagonal-stripe backdrop (slots remain clickable for extra shifts) */}
        {isOff && (
          <div
            className={`absolute inset-0 z-[5] pointer-events-none ${isLight ? '' : 'bg-black/75'}`}
            style={
              isLight
                ? {
                    backgroundColor: 'rgba(23, 15, 46, 0.07)',
                    backgroundImage:
                      'repeating-linear-gradient(45deg, transparent, transparent 10px, rgba(23, 15, 46, 0.06) 10px, rgba(23, 15, 46, 0.06) 20px)',
                  }
                : {
                    backgroundColor: 'rgba(5, 3, 8, 0.85)',
                    backgroundImage: `
                      repeating-linear-gradient(-45deg, rgba(255, 255, 255, 0.045) 0px, rgba(255, 255, 255, 0.045) 4px, transparent 4px, transparent 10px),
                      linear-gradient(to bottom, rgba(255, 255, 255, 0.04) 1px, transparent 1px)
                    `,
                    backgroundSize: `auto, 100% ${PIXELS_PER_HOUR}px`,
                  }
            }
          />
        )}

        {/* Empty Tap-to-Book Slots (borderless - zero physical height stacking) */}
        {Array.from({ length: TOTAL_HOURS * 4 }).map((_, i) => {
          const totalMins = CALENDAR_START_HOUR * 60 + (i * 15)
          const timeStr = `${Math.floor(totalMins / 60).toString().padStart(2, '0')}:${(totalMins % 60).toString().padStart(2, '0')}`
          const isSlotHovered = hoveredDropSlot?.date === gridDate && hoveredDropSlot?.time === timeStr

          return (
            <button
              key={`slot-${i}`}
              data-slot="true"
              data-date={gridDate}
              data-time={timeStr}
              onClick={() => {
                if (touchDraggedAppt || justDraggedRef.current) return
                requestOpenBookingModal(
                  gridDate,
                  timeStr,
                  isOff ? [{ override_date: gridDate, is_off: true }] : undefined
                )
              }}
              title={isSlotHovered ? `Drop to reschedule to ${formatTime(timeStr)}` : `Book ${formatTime(timeStr)}`}
              className={`absolute left-0 w-full m-0 p-0 border-0 outline-none transition-colors z-10 ${
                isSlotHovered
                  ? 'bg-[var(--color-brand-accent)]/35 ring-1 ring-inset ring-[var(--color-brand-accent)]'
                  : 'cursor-pointer hover:bg-[var(--color-brand-accent)]/15 active:bg-[var(--color-brand-accent)]/25'
              }`}
              style={{
                top: `${i * SLOT_HEIGHT}px`,
                height: `${SLOT_HEIGHT}px`,
              }}
            >
              {isSlotHovered && touchDraggedAppt && (
                <div className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-[var(--color-brand-light)] pointer-events-none bg-[var(--color-brand-accent)]/30 truncate px-1">
                  Reschedule: {formatTime(timeStr)}
                </div>
              )}
            </button>
          )
        })}

        {/* Live Current Time Red Indicator Line */}
        {isToday && isWithinHours && (
          <div
            className="absolute left-0 right-0 z-20 pointer-events-none flex items-center overflow-hidden"
            style={{ top: `${currentTop}px` }}
          >
            <div className="w-2.5 h-2.5 rounded-full bg-red-500 -ml-1 shadow-[0_0_8px_rgba(239,68,68,0.9)] ring-2 ring-[var(--color-brand-900)] flex-shrink-0" />
            <div className="flex-1 h-[2px] bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.7)]" />
          </div>
        )}

        {/* Dynamic Appointment Blocks */}
        {gridAppts.map(appt => {
          const top = timeToPixels(appt.start_time)
          const durationMins = Math.max(15, toMinutes(appt.end_time) - toMinutes(appt.start_time))
          const height = durationMins * PIXELS_PER_MINUTE

          const isBlockout = Boolean(appt.is_blockout)
          const isBlocked = appt.status === 'blocked' || isBlockout
          const isCompleted = appt.status === 'completed'
          const isRedListed = !isBlockout && !isBlocked && Boolean(appt.clients?.is_red_listed)
          const redListedOwedBy = (appt.clients?.red_listed_by || 'BARBER').toUpperCase()
          const isThisBeingDragged = touchDraggedAppt?.id === appt.id

          const colorClasses = isBlockout
            ? (isLight ? 'bg-[#C4BBE0] border-[#8273AD] text-[#170F2E] shadow-sm' : 'bg-zinc-800 border-zinc-600 text-zinc-300')
            : isBlocked
            ? (isLight ? 'bg-[#E5D2C4] border-[#C26A2B] text-[#431407] shadow-sm' : 'bg-orange-950/90 border-orange-500/80 text-orange-200')
            : isCompleted
            ? (isLight ? 'bg-[#C7DEC9] border-[#2E7D4F] text-[#052E16] shadow-sm' : 'bg-emerald-950/90 border-emerald-500/80 text-emerald-200')
            : 'bg-[var(--color-brand-800)] border-[var(--color-brand-accent)] border-t-[#D4AF37]/70 text-[var(--color-brand-light)] shadow-md'

          const redListCardClass = isRedListed ? '!border-red-500 ring-1 ring-red-500/60' : ''

          const serviceName = appt.services?.name || 'Service'

          if (isWeekView) {
            return (
              <button
                key={appt.id}
                data-appt-card="true"
                onTouchStart={(e) => handleTouchStart(e, appt)}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
                onTouchCancel={handleTouchCancel}
                onMouseDown={(e) => handleMouseDown(e, appt)}
                onClick={(e) => {
                  e.stopPropagation()
                  if (touchDraggedAppt || isTouchDragging || justDraggedRef.current || isDragActiveRef.current) return
                  handleOpenAppt(appt)
                }}
                className={`absolute left-px right-px m-0 box-border rounded-sm p-1 overflow-hidden border shadow-sm flex flex-col text-left z-20 cursor-grab active:cursor-grabbing hover:brightness-125 transition-all select-none ${
                  isThisBeingDragged
                    ? 'scale-105 shadow-2xl ring-2 ring-[var(--color-brand-accent)] z-30 opacity-80 animate-pulse touch-none'
                    : 'touch-pan-y'
                } ${colorClasses} ${redListCardClass}`}
                style={{
                  top: `${top}px`,
                  height: `${height}px`,
                  touchAction: isThisBeingDragged ? 'none' : 'pan-y'
                }}
              >
                {!isBlockout && !isBlocked && (
                  <div className={`text-[8px] sm:text-[9px] font-extrabold uppercase tracking-tight leading-tight truncate overflow-hidden whitespace-nowrap w-full pointer-events-none ${
                    isCompleted
                      ? (isLight ? 'text-emerald-800' : 'text-emerald-300')
                      : isLight
                      ? 'text-[var(--color-brand-periwinkle)]'
                      : 'text-[var(--color-brand-gold)]'
                  }`}>
                    ✂️ {serviceName}
                  </div>
                )}
                <div className="text-[9px] sm:text-[10px] font-bold leading-snug break-words whitespace-normal w-full pointer-events-none">
                  {isRedListed ? '🚩 ' : ''}{isBlockout ? (appt.notes || 'Blocked') : isBlocked ? 'BLOCKED' : appt.clients?.name || 'Walk-In'}
                </div>
                {isRedListed && height >= 42 ? (
                  <div className="text-[8px] font-extrabold bg-red-600 text-white px-1 py-px rounded truncate leading-tight mt-0.5 w-fit max-w-full pointer-events-none">
                    🚩 RED LIST • OWES {redListedOwedBy}
                  </div>
                ) : height >= 45 ? (
                  <div className="text-[8px] sm:text-[9px] opacity-75 truncate overflow-hidden whitespace-nowrap leading-none mt-0.5 w-full pointer-events-none">
                    {formatTime(appt.start_time).replace(':00', '')}
                  </div>
                ) : null}
              </button>
            )
          }

          return (
            <button
              key={appt.id}
              data-appt-card="true"
              onTouchStart={(e) => handleTouchStart(e, appt)}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
              onTouchCancel={handleTouchCancel}
              onMouseDown={(e) => handleMouseDown(e, appt)}
              onClick={(e) => {
                e.stopPropagation()
                if (touchDraggedAppt || isTouchDragging || justDraggedRef.current || isDragActiveRef.current) return
                handleOpenAppt(appt)
              }}
              className={`absolute left-1.5 right-1.5 m-0 box-border rounded-lg ${height <= 64 ? 'py-1 px-2.5' : 'py-1.5 px-2.5 sm:p-2'} overflow-hidden border shadow-md flex flex-col text-left z-20 cursor-grab active:cursor-grabbing hover:brightness-110 transition-all select-none ${
                isThisBeingDragged
                  ? 'scale-105 shadow-2xl ring-2 ring-[var(--color-brand-accent)] z-30 opacity-80 animate-pulse touch-none'
                  : 'touch-pan-y'
              } ${colorClasses} ${redListCardClass}`}
              style={{
                top: `${top}px`,
                height: `${height}px`,
                touchAction: isThisBeingDragged ? 'none' : 'pan-y'
              }}
            >
              {height <= 64 ? (
                <div className="pointer-events-none flex flex-col justify-center h-full min-w-0">
                  <div className="flex items-center justify-between gap-1.5 leading-tight">
                    {isBlockout ? (
                      <span className={`text-[10px] font-bold uppercase tracking-wide flex items-center gap-1 truncate ${isLight ? 'text-slate-600' : 'text-zinc-400'}`}>
                        <Ban className="w-3 h-3 flex-shrink-0" /> Blockout
                      </span>
                    ) : isBlocked ? (
                      <span className={`text-[10px] font-bold uppercase tracking-wide flex items-center gap-1 truncate ${isLight ? 'text-orange-700' : 'text-orange-400'}`}>
                        <Lock className="w-3 h-3 flex-shrink-0" /> Blocked Time
                      </span>
                    ) : (
                      <span className={`text-[10px] sm:text-[11px] font-extrabold uppercase tracking-wide truncate ${
                        isCompleted ? (isLight ? 'text-emerald-800' : 'text-emerald-300') : isLight ? 'text-[var(--color-brand-periwinkle)]' : 'text-[var(--color-brand-gold)]'
                      }`}>
                        ✂️ {serviceName}
                      </span>
                    )}
                    {isRedListed && (
                      <span className="bg-red-600 text-white text-[9px] font-extrabold px-1 rounded flex-shrink-0">
                        🚩 RED LIST • OWES {redListedOwedBy}
                      </span>
                    )}
                  </div>
                  <div className="flex items-baseline justify-between gap-2 mt-0.5 leading-tight">
                    <span className={`font-bold text-sm leading-tight break-words whitespace-normal ${isBlockout ? (isLight ? 'text-slate-800' : 'text-zinc-200') : 'text-[var(--color-brand-light)]'}`}>
                      {isBlockout ? (appt.notes || 'Blocked Time') : isBlocked ? 'BLOCKED TIME' : appt.clients?.name || 'Walk-In'}
                    </span>
                    <span className={`text-[11px] font-semibold flex-shrink-0 ${
                      isBlockout ? (isLight ? 'text-slate-600' : 'text-zinc-400') : isBlocked ? (isLight ? 'text-orange-700' : 'text-orange-400') : isCompleted ? (isLight ? 'text-emerald-700' : 'text-emerald-400') : 'text-[var(--color-brand-accent)]'
                    }`}>
                      {formatTime(appt.start_time)} - {formatTime(appt.end_time)}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="pointer-events-none flex flex-col h-full">
                  <div className="flex items-center justify-between gap-1.5">
                    {isBlockout ? (
                      <span className={`text-xs font-bold uppercase tracking-wide flex items-center gap-1 truncate ${isLight ? 'text-slate-600' : 'text-zinc-400'}`}>
                        <Ban className="w-3.5 h-3.5 flex-shrink-0" /> Blockout
                      </span>
                    ) : isBlocked ? (
                      <span className={`text-xs font-bold uppercase tracking-wide flex items-center gap-1 truncate ${isLight ? 'text-orange-700' : 'text-orange-400'}`}>
                        <Lock className="w-3.5 h-3.5 flex-shrink-0" /> Blocked Time
                      </span>
                    ) : (
                      <span className={`text-xs font-extrabold uppercase tracking-wide truncate ${
                        isCompleted
                          ? (isLight ? 'text-emerald-800' : 'text-emerald-300')
                          : isLight
                          ? 'text-[var(--color-brand-periwinkle)]'
                          : 'text-[var(--color-brand-gold)]'
                      }`}>
                        ✂️ {serviceName}
                      </span>
                    )}
                    <span className="flex items-center gap-1 flex-shrink-0">
                      {isRedListed && (
                        <span className="bg-red-600 text-white text-[9px] sm:text-[10px] font-extrabold px-1.5 py-0.5 rounded shadow-sm whitespace-nowrap">
                          🚩 RED LIST • OWES {redListedOwedBy}
                        </span>
                      )}
                      {appt.notes && !isBlockout && <FileText className="w-3.5 h-3.5 flex-shrink-0 opacity-80" />}
                    </span>
                  </div>
                  <div className={`font-bold text-sm mt-0.5 leading-tight break-words whitespace-normal ${isBlockout ? (isLight ? 'text-slate-800' : 'text-zinc-200') : 'text-[var(--color-brand-light)]'}`}>
                    {isBlockout ? (appt.notes || 'Blocked Time') : isBlocked ? 'BLOCKED TIME' : appt.clients?.name || 'Walk-In'}
                  </div>
                  <div className={`text-xs font-semibold truncate mt-0.5 ${
                    isBlockout ? (isLight ? 'text-slate-600' : 'text-zinc-400') : isBlocked ? (isLight ? 'text-orange-700' : 'text-orange-400') : isCompleted ? (isLight ? 'text-emerald-700' : 'text-emerald-400') : 'text-[var(--color-brand-accent)]'
                  }`}>
                    {formatTime(appt.start_time)} - {formatTime(appt.end_time)}
                  </div>
                  {height >= 85 && !isBlockout && (
                    <div className="mt-auto flex items-center justify-between gap-2 text-[11px] text-[var(--color-brand-muted)] truncate">
                      {appt.clients?.phone && appt.clients?.phone !== '0000000000' && (
                        <span className="font-mono truncate">{formatPhoneNumber(appt.clients.phone)}</span>
                      )}
                      {appt.notes && (
                        <span className="italic truncate opacity-85">{appt.notes}</span>
                      )}
                    </div>
                  )}
                </div>
              )}
            </button>
          )
        })}
      </div>
    )
  }

  // REUSABLE DASHBOARD MODALS
  const renderModals = () => (
    <>
      {/* APPOINTMENT DETAILS & CUT NOTES MODAL */}
      {showApptModal && selectedAppt && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-in fade-in duration-200">
           <div className="bg-[var(--color-brand-800)] w-full max-w-md rounded-2xl flex flex-col border border-[var(--color-brand-700)] shadow-2xl overflow-hidden max-h-[90vh]">
              <div className="flex items-center justify-between p-6 border-b border-[var(--color-brand-700)] flex-shrink-0">
                <div>
                  {!selectedAppt.is_blockout && selectedAppt.services?.name && (
                    <p className="text-xs font-extrabold uppercase tracking-wider text-[var(--color-brand-gold)] mb-1">
                      ✂️ {selectedAppt.services.name}
                    </p>
                  )}
                  <h2 className="text-xl font-bold">
                    {editApptMode
                      ? 'Edit Appointment'
                      : selectedAppt.is_blockout
                      ? (selectedAppt.notes || 'Blocked Time')
                      : selectedAppt.clients?.name || 'Walk-In'}
                  </h2>
                  <div className="flex items-center gap-2 mt-0.5">
                    <p className="text-sm text-[var(--color-brand-accent)] font-semibold">
                      {formatTime(selectedAppt.start_time)} - {formatTime(selectedAppt.end_time)}
                    </p>
                    {!selectedAppt.is_blockout && selectedAppt.clients?.phone && selectedAppt.clients.phone !== '0000000000' && (
                      <span className="text-xs text-[var(--color-brand-muted)] font-mono">
                        • {formatPhoneNumber(selectedAppt.clients.phone)}
                      </span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => {
                    setEditApptMode(false)
                    setShowApptModal(false)
                  }}
                  className="text-[var(--color-brand-muted)] hover:text-[var(--color-brand-light)] cursor-pointer"
                >
                  <X className="w-6 h-6" />
                </button>
              </div>

              {editApptMode ? (
                <form onSubmit={handleSaveEditedAppointment} className="p-6 space-y-4 overflow-y-auto flex-1">
                  {/* Date Picker */}
                  <div>
                    <label className="block text-xs font-bold text-[var(--color-brand-muted)] uppercase tracking-wider mb-1.5">
                      Date
                    </label>
                    <input
                      type="date"
                      required
                      value={editApptDate}
                      onChange={(e) => setEditApptDate(e.target.value)}
                      className={`w-full bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] rounded-xl p-3 outline-none ${isLight ? '[color-scheme:light]' : '[color-scheme:dark]'} cursor-pointer text-[var(--color-brand-light)]`}
                    />
                  </div>

                  {/* Multi-Service Selector */}
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between">
                      <label className="block text-xs font-bold text-[var(--color-brand-muted)] uppercase tracking-wider">
                        Selected Services
                      </label>
                      {editApptServices.length > 0 && (
                        <span className="text-xs font-bold text-[var(--color-brand-gold)]">
                          {editApptServices.length} {editApptServices.length === 1 ? 'Service' : 'Services'} •{' '}
                          {editApptServices.reduce((sum, s) => sum + (Number(s?.duration_minutes) || 0), 0)}m • $
                          {editApptServices.reduce((sum, s) => sum + (Number(s?.price) || 0), 0)}
                        </span>
                      )}
                    </div>

                    {editApptServices.length > 0 && (
                      <div className="space-y-1.5">
                        {editApptServices.map((svc, idx) => (
                          <div
                            key={`${svc.id}-${idx}`}
                            className="flex items-center justify-between gap-2 bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] px-3 py-2 rounded-xl"
                          >
                            <div className="min-w-0">
                              <p className="text-sm font-bold text-[var(--color-brand-light)] truncate">{svc.name}</p>
                              <p className="text-xs text-[var(--color-brand-muted)]">
                                {svc.duration_minutes}m • <span className="text-[var(--color-brand-gold)] font-semibold">${svc.price}</span>
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => setEditApptServices(prev => prev.filter((_, i) => i !== idx))}
                              className="p-1.5 rounded-lg text-[var(--color-brand-muted)] hover:text-red-400 hover:bg-red-500/15 transition-colors cursor-pointer flex-shrink-0"
                              aria-label={`Remove ${svc.name}`}
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    <select
                      value=""
                      onChange={(e) => {
                        const chosen = adminServices.find(s => s.id === e.target.value)
                        if (chosen) {
                          setEditApptServices(prev => [...prev, chosen])
                        }
                      }}
                      className="w-full bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] rounded-xl p-3 outline-none appearance-none cursor-pointer text-[var(--color-brand-light)]"
                    >
                      <option value="" disabled>Add a service...</option>
                      {adminServices.map(s => (
                        <option key={s.id} value={s.id}>
                          + {s.name} ({s.duration_minutes}m • ${s.price})
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Start Time Dropdown (ignoring this appointment's own overlap, plus occupied double-book override slots) */}
                  <div>
                    <label className="block text-xs font-bold text-[var(--color-brand-muted)] uppercase tracking-wider mb-1.5">
                      Start Time
                    </label>
                    {(() => {
                      const outsideEditSlots = editApptAllSlots.filter(t => !editApptRegularSlots.includes(t))
                      const occupiedEditSlots = ALL_DAY_15_MIN_SLOTS.filter(
                        t => !editApptRegularSlots.includes(t) && !outsideEditSlots.includes(t)
                      )
                      return (
                        <select
                          required
                          value={ALL_DAY_15_MIN_SLOTS.includes(editApptTime) ? editApptTime : ''}
                          onChange={(e) => setEditApptTime(e.target.value)}
                          disabled={editApptServices.length === 0}
                          className="w-full bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] rounded-xl p-3 outline-none appearance-none cursor-pointer disabled:opacity-50 text-[var(--color-brand-light)]"
                        >
                          <option value="" disabled>
                            {editApptServices.length === 0 ? 'Add a service first' : 'Select time...'}
                          </option>
                          {editApptRegularSlots.length > 0 && (
                            <optgroup label="Regular Scheduled Hours">
                              {editApptRegularSlots.map(time => (
                                <option key={time} value={time}>{formatTime(time)}</option>
                              ))}
                            </optgroup>
                          )}
                          {outsideEditSlots.length > 0 && (
                            <optgroup label="Outside Scheduled Hours (Squeeze-In / Exception)">
                              {outsideEditSlots.map(time => (
                                <option key={time} value={time}>{formatTime(time)}</option>
                              ))}
                            </optgroup>
                          )}
                          {occupiedEditSlots.length > 0 && (
                            <optgroup label="Occupied / Conflict Slots (Double-Book Override)">
                              {occupiedEditSlots.map(time => (
                                <option key={time} value={time}>{formatTime(time)} (Occupied)</option>
                              ))}
                            </optgroup>
                          )}
                        </select>
                      )
                    })()}
                  </div>

                  {/* Appointment Notes */}
                  <div>
                    <label className="block text-xs font-bold text-[var(--color-brand-muted)] uppercase tracking-wider mb-1.5">
                      Appointment Notes (Optional)
                    </label>
                    <textarea
                      value={editApptNotes}
                      onChange={(e) => setEditApptNotes(e.target.value)}
                      rows={2}
                      placeholder="Appointment notes..."
                      className="w-full bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] rounded-xl p-3 text-sm text-[var(--color-brand-light)] outline-none focus:border-[var(--color-brand-accent)] resize-none"
                    />
                  </div>

                  <div className="flex items-center gap-3 pt-2">
                    <button
                      type="button"
                      onClick={() => setEditApptMode(false)}
                      disabled={isUpdatingAppt}
                      className="flex-1 py-3 rounded-xl border border-[var(--color-brand-700)] text-sm font-bold text-[var(--color-brand-muted)] hover:text-[var(--color-brand-light)] hover:bg-[var(--color-brand-900)]/60 transition-colors cursor-pointer disabled:opacity-50"
                    >
                      Cancel Edit
                    </button>
                    <button
                      type="submit"
                      disabled={isUpdatingAppt || !editApptDate || !editApptTime || editApptServices.length === 0}
                      className="flex-1 py-3 rounded-xl bg-[var(--color-brand-accent)] hover:brightness-110 text-white text-sm font-bold transition-all cursor-pointer disabled:opacity-50 shadow-md"
                    >
                      {isUpdatingAppt ? 'Saving...' : 'Save Changes'}
                    </button>
                  </div>
                </form>
              ) : (
              <div className="p-6 space-y-5 overflow-y-auto flex-1">
                 {/* Red List Warning Alert & Fee Recovery Controls */}
                 {!selectedAppt.is_blockout && selectedAppt.clients?.is_red_listed && (() => {
                   const rlClient = selectedAppt.clients
                   const owedBarber = rlClient.red_listed_by || 'Shop'
                   const feeReminderSmsHref = buildFeeReminderSmsHref(rlClient.phone, rlClient.name, rlClient.red_listed_by)
                   return (
                     <div className="bg-red-950/90 border-2 border-red-500 text-red-100 rounded-xl p-4 space-y-3 shadow-lg">
                       <div className="flex items-start justify-between gap-2">
                         <div>
                           <p className="text-sm font-extrabold tracking-wide text-red-200">
                             🚩 RED LISTED BY {owedBarber}
                           </p>
                           <p className="text-xs text-red-100/90 mt-1">
                             {rlClient.red_listed_reason || 'No-Call / No-Show balance due before next cut.'}
                           </p>
                         </div>
                         <span className="text-[11px] font-extrabold bg-red-600 text-white px-2 py-0.5 rounded-full whitespace-nowrap">
                           No-Shows: {rlClient.no_show_count || 0}
                         </span>
                       </div>
                       <div className="flex flex-wrap gap-2 pt-1">
                         {feeReminderSmsHref && (
                           <a
                             href={feeReminderSmsHref}
                             className="flex-1 min-w-[140px] bg-red-600 hover:bg-red-500 text-white text-xs font-bold py-2.5 px-3 rounded-lg flex items-center justify-center gap-1.5 transition-colors"
                           >
                             <MessageSquare className="w-3.5 h-3.5" />
                             <span>Text Fee Reminder</span>
                           </a>
                         )}
                         <button
                           type="button"
                           disabled={isUpdatingRedList || isUpdatingAppt}
                           onClick={() => handleClearRedList(rlClient.id, rlClient.name)}
                           className="flex-1 min-w-[130px] bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold py-2.5 px-3 rounded-lg flex items-center justify-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
                         >
                           <CheckCircle2 className="w-3.5 h-3.5" />
                           <span>Clear Red List</span>
                         </button>
                       </div>
                     </div>
                   )
                 })()}

                 {/* Contact Buttons */}
                 {!selectedAppt.is_blockout && selectedAppt.clients?.phone && selectedAppt.clients.phone !== '0000000000' && (
                   <div className="flex gap-3">
                     <a href={`tel:${cleanPhone(selectedAppt.clients.phone)}`} className="flex-1 bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] text-center py-3 rounded-xl font-bold hover:border-[var(--color-brand-accent)] transition-colors flex items-center justify-center gap-2 cursor-pointer">
                       <Phone className="w-4 h-4 text-[var(--color-brand-accent)]" /> Call
                     </a>
                     <a href={`sms:${cleanPhone(selectedAppt.clients.phone)}`} className="flex-1 bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] text-center py-3 rounded-xl font-bold hover:border-[var(--color-brand-accent)] transition-colors flex items-center justify-center gap-2 cursor-pointer">
                       <MessageSquare className="w-4 h-4 text-[var(--color-brand-accent)]" /> Text
                     </a>
                   </div>
                 )}

                 {/* Appointment-Specific Booking Notes (appointments.notes) */}
                 <div className="space-y-2">
                   <label className="block text-xs font-bold text-[var(--color-brand-muted)] uppercase tracking-wider">
                     {selectedAppt.is_blockout ? 'Blockout Reason' : 'Appointment Booking Notes'}
                   </label>
                   {selectedAppt.notes ? (
                     <div className="bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] text-[var(--color-brand-light)] text-sm rounded-xl p-3">
                       {selectedAppt.notes}
                     </div>
                   ) : (
                     <div className="bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] text-[var(--color-brand-muted)] text-sm rounded-xl p-3 italic">
                       {selectedAppt.is_blockout ? 'No reason specified.' : 'No appointment-specific booking notes provided.'}
                     </div>
                   )}
                 </div>

                 {/* Persistent Client Cut Notes (clients.notes) */}
                 {!selectedAppt.is_blockout && (
                   <div className="space-y-2">
                     <div className="flex items-center justify-between">
                       <label className="block text-xs font-bold text-[var(--color-brand-muted)] uppercase tracking-wider">
                         Persistent Client Cut Notes
                       </label>
                       {selectedAppt.clients?.id && selectedAppt.clients?.phone !== '0000000000' && (
                         <button
                           type="button"
                           onClick={() => {
                             const clientObj = selectedAppt.clients
                             setShowApptModal(false)
                             handleOpenClientProfile(clientObj)
                           }}
                           className="text-xs font-bold text-[var(--color-brand-accent)] hover:underline cursor-pointer"
                         >
                           View Full Profile & History →
                         </button>
                       )}
                     </div>
                     <textarea
                       value={clientNotes}
                       onChange={(e) => setClientNotes(e.target.value)}
                       placeholder="e.g. #2 high fade, finger length on top..."
                       className="w-full bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] text-[var(--color-brand-light)] rounded-xl p-3 h-28 outline-none focus:border-[var(--color-brand-accent)] resize-none text-sm"
                     />
                     <button
                       onClick={handleSaveNotes}
                       disabled={isUpdatingAppt || clientNotes === (selectedAppt.clients?.notes || '')}
                       className="w-full bg-[var(--color-brand-accent)] hover:brightness-110 text-white font-bold py-3 rounded-xl transition-all disabled:opacity-50 cursor-pointer shadow-sm"
                     >
                       {isUpdatingAppt ? 'Saving...' : 'Save Cut Notes'}
                     </button>
                   </div>
                 )}

                 <hr className="border-[var(--color-brand-700)]" />

                 {/* Actions */}
                 <div className="space-y-2">
                   <label className="block text-xs font-bold text-[var(--color-brand-muted)] uppercase tracking-wider mb-3">
                     {selectedAppt.is_blockout ? 'Manage Blockout' : 'Update Status'}
                   </label>
                   {!selectedAppt.is_blockout && (
                     <button
                       type="button"
                       onClick={handleRebookClient}
                       disabled={isUpdatingAppt}
                       className="w-full py-3 rounded-xl border border-[var(--color-brand-gold)]/70 bg-[var(--color-brand-accent)]/20 hover:bg-[var(--color-brand-accent)] text-[var(--color-brand-light)] hover:text-white text-xs sm:text-sm font-bold transition-all cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2 shadow-sm mb-2"
                     >
                       <Calendar className="w-4 h-4 text-[var(--color-brand-gold)]" />
                       <span>Rebook Client</span>
                     </button>
                   )}
                   <div className={selectedAppt.is_blockout ? 'grid grid-cols-1 gap-2' : 'grid grid-cols-3 gap-2'}>
                     {!selectedAppt.is_blockout && (
                       <button
                         type="button"
                         onClick={handleStartEditAppt}
                         disabled={isUpdatingAppt}
                         className="flex flex-col items-center justify-center gap-1 py-4 rounded-xl border border-[var(--color-brand-periwinkle)]/60 bg-[var(--color-brand-periwinkle)]/15 text-[var(--color-brand-periwinkle)] hover:bg-[var(--color-brand-periwinkle)] hover:text-white transition-all cursor-pointer disabled:opacity-50"
                       >
                         <Edit className="w-5 h-5" />
                         <span className="text-xs font-bold">Edit</span>
                       </button>
                     )}
                     {!selectedAppt.is_blockout && (
                       <button onClick={handleNoShow} disabled={isUpdatingAppt} className="flex flex-col items-center justify-center gap-1 py-4 rounded-xl border border-[var(--color-brand-700)] hover:bg-red-900/20 hover:border-red-500 hover:text-red-400 transition-colors cursor-pointer disabled:opacity-50">
                         <UserX className="w-5 h-5" />
                         <span className="text-xs font-bold">No-Show</span>
                       </button>
                     )}
                     <button onClick={handleDeleteAppt} disabled={isUpdatingAppt} className="flex flex-col items-center justify-center gap-1 py-4 rounded-xl border border-[var(--color-brand-700)] hover:bg-red-900/30 hover:border-red-600 hover:text-red-400 transition-colors cursor-pointer disabled:opacity-50">
                       <Trash2 className="w-5 h-5" />
                       <span className="text-xs font-bold">{selectedAppt.is_blockout ? 'Remove Blockout' : 'Delete'}</span>
                     </button>
                   </div>
                   {!selectedAppt.is_blockout && selectedAppt.clients?.id && selectedAppt.clients?.phone !== '0000000000' && !selectedAppt.clients?.is_red_listed && (() => {
                     const apptBarberName = (barbers.find(b => b.id === selectedAppt.barber_id) || barbers.find(b => b.id === selectedBarberId))?.name?.split(' ')[0] || 'Michael'
                     return (
                       <button
                         type="button"
                         disabled={isUpdatingRedList || isUpdatingAppt}
                         onClick={() => handleManualRedList(selectedAppt.clients.id, apptBarberName, `Manual Red List Flag by ${apptBarberName}`, selectedAppt.clients.name)}
                         className="w-full mt-2 py-3 rounded-xl border border-red-500/50 bg-red-950/30 hover:bg-red-600 hover:text-white text-red-400 text-xs font-bold transition-colors cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2"
                       >
                         <Flag className="w-4 h-4" />
                         <span>🚩 Red List Client</span>
                       </button>
                     )
                   })()}
                 </div>

              </div>
              )}
           </div>
        </div>
      )}

      {/* BARBER SMS CONFIRMATION MODAL (3 DELIVERY CHOICES + 9PM-7AM PACIFIC QUIET HOURS GUARD) */}
      {smsConfirmPrompt && (() => {
        const { isQuietHours, next7AMLabel } = getPacificQuietHoursInfo()
        const isSendNowLocked = isQuietHours && !overrideQuietHoursSendNow

        return (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-[65] animate-in fade-in duration-200">
            <div className="bg-[var(--color-brand-800)] w-full max-w-md rounded-2xl flex flex-col border border-[var(--color-brand-700)] shadow-2xl overflow-hidden max-h-[92vh]">
              <div className="flex items-center justify-between p-5 sm:p-6 border-b border-[var(--color-brand-700)] flex-shrink-0">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="p-2 rounded-full bg-[var(--color-brand-900)] border border-[#D4AF37]/60 flex-shrink-0">
                    <MessageSquare className="w-5 h-5 text-[var(--color-brand-gold)]" />
                  </div>
                  <div className="min-w-0">
                    <h2 className="text-lg sm:text-xl font-bold text-[var(--color-brand-light)] truncate">
                      {smsConfirmPrompt.contextTitle}
                    </h2>
                    <p className="text-xs text-[var(--color-brand-muted)] truncate">
                      {smsConfirmPrompt.clientName} • <span className="font-mono">{formatPhoneNumber(smsConfirmPrompt.clientPhone)}</span>
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  disabled={isDispatchingConfirmSms}
                  onClick={() => {
                    setSmsConfirmPrompt(null)
                    setOverrideQuietHoursSendNow(false)
                  }}
                  className="text-[var(--color-brand-muted)] hover:text-[var(--color-brand-light)] cursor-pointer flex-shrink-0"
                >
                  <X className="w-6 h-6" />
                </button>
              </div>

              <div className="p-5 sm:p-6 space-y-4 overflow-y-auto flex-1">
                {/* Change Summary */}
                <div className="bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] rounded-xl p-3 text-xs sm:text-sm font-bold text-[var(--color-brand-light)]">
                  {smsConfirmPrompt.changeSummary}
                </div>

                {/* 9:00 PM - 7:00 AM Pacific Quiet Hours Warning Banner */}
                {isQuietHours && (
                  <div
                    className={`rounded-xl p-3.5 border-2 space-y-2.5 shadow-md ${
                      isLight
                        ? 'bg-amber-100/95 border-amber-600 text-amber-950'
                        : 'bg-amber-950/85 border-[#D4AF37]/80 text-amber-100'
                    }`}
                  >
                    <div className="flex items-start gap-2.5">
                      <Moon className={`w-4 h-4 flex-shrink-0 mt-0.5 ${isLight ? 'text-amber-700' : 'text-[var(--color-brand-gold)]'}`} />
                      <div className="text-xs leading-snug">
                        <span className="font-extrabold uppercase tracking-wide block mb-0.5">
                          Quiet Hours Active (9:00 PM – 7:00 AM Pacific)
                        </span>
                        <span>
                          Texts are held overnight so clients aren't woken up. Queue for <strong>{next7AMLabel}</strong> or check below to override.
                        </span>
                      </div>
                    </div>

                    <label className="flex items-center gap-2 pt-1 cursor-pointer select-none text-xs font-bold">
                      <input
                        type="checkbox"
                        checked={overrideQuietHoursSendNow}
                        onChange={(e) => setOverrideQuietHoursSendNow(e.target.checked)}
                        className="w-4 h-4 rounded accent-[var(--color-brand-accent)] cursor-pointer"
                      />
                      <span>Override quiet hours &amp; send now</span>
                    </label>
                  </div>
                )}

                {/* Editable SMS Message Box */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-bold text-[var(--color-brand-muted)] uppercase tracking-wider">
                    SMS Message Preview (Editable)
                  </label>
                  <textarea
                    rows={4}
                    value={smsConfirmMessage}
                    onChange={(e) => setSmsConfirmMessage(e.target.value)}
                    className="w-full bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] rounded-xl p-3 text-xs sm:text-sm text-[var(--color-brand-light)] outline-none focus:border-[var(--color-brand-accent)] resize-none leading-relaxed"
                  />
                </div>

                {/* 3 Delivery Action Buttons */}
                <div className="flex flex-col gap-2.5 pt-2">
                  <button
                    type="button"
                    disabled={isDispatchingConfirmSms || !smsConfirmMessage.trim()}
                    onClick={handleQueueSmsFor7AM}
                    className={`w-full py-3 px-4 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2 shadow-md ${
                      isQuietHours
                        ? 'bg-[var(--color-brand-accent)] hover:brightness-110 text-white ring-1 ring-[#D4AF37]/70'
                        : 'bg-[var(--color-brand-periwinkle)]/15 border border-[var(--color-brand-periwinkle)]/60 text-[var(--color-brand-periwinkle)] hover:bg-[var(--color-brand-periwinkle)] hover:text-white'
                    }`}
                  >
                    <Clock className="w-4 h-4" />
                    <span>Wait Until 7:00 AM ({next7AMLabel})</span>
                  </button>

                  <button
                    type="button"
                    disabled={isDispatchingConfirmSms || !smsConfirmMessage.trim() || isSendNowLocked}
                    onClick={handleSendConfirmSmsNow}
                    className={`w-full py-3 px-4 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-md ${
                      !isQuietHours
                        ? 'bg-[var(--color-brand-accent)] hover:brightness-110 text-white'
                        : 'bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] hover:border-[var(--color-brand-accent)] text-[var(--color-brand-light)]'
                    }`}
                  >
                    <MessageSquare className="w-4 h-4" />
                    <span>
                      {isDispatchingConfirmSms
                        ? 'Sending...'
                        : isSendNowLocked
                        ? 'Send Now (Locked During Quiet Hours)'
                        : 'Send Now'}
                    </span>
                  </button>

                  <button
                    type="button"
                    disabled={isDispatchingConfirmSms}
                    onClick={() => {
                      setSmsConfirmPrompt(null)
                      setOverrideQuietHoursSendNow(false)
                    }}
                    className="w-full py-2.5 px-4 rounded-xl border border-[var(--color-brand-700)] text-xs sm:text-sm font-bold text-[var(--color-brand-muted)] hover:text-[var(--color-brand-light)] hover:bg-[var(--color-brand-900)]/60 transition-colors cursor-pointer disabled:opacity-50"
                  >
                    Don't Send Text
                  </button>
                </div>
              </div>
            </div>
          </div>
        )
      })()}

      {/* SCHEDULE CONFLICT OVERRIDE CONFIRMATION MODAL */}
      {conflictOverridePrompt && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-[60] animate-in fade-in duration-200">
          <div className="bg-[var(--color-brand-800)] w-full max-w-md rounded-2xl flex flex-col border border-[var(--color-brand-700)] shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between p-5 sm:p-6 border-b border-[var(--color-brand-700)]">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-full bg-[var(--color-brand-900)] border border-[#D4AF37]/60">
                  <AlertTriangle className="w-5 h-5 text-[var(--color-brand-gold)]" />
                </div>
                <h2 className="text-lg sm:text-xl font-bold text-[var(--color-brand-light)]">
                  {conflictOverridePrompt.title}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setConflictOverridePrompt(null)}
                className="text-[var(--color-brand-muted)] hover:text-[var(--color-brand-light)] cursor-pointer"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            <div className="p-5 sm:p-6 space-y-4">
              <div className="bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] rounded-xl p-3 text-xs sm:text-sm font-bold text-[var(--color-brand-light)]">
                {conflictOverridePrompt.proposedSummary}
              </div>

              <div className="space-y-2">
                <p className="text-xs font-bold uppercase tracking-wider text-[var(--color-brand-gold)]">
                  Conflict Details:
                </p>
                <ul className="space-y-1.5">
                  {conflictOverridePrompt.reasons.map((reason, idx) => (
                    <li
                      key={idx}
                      className="flex items-start gap-2 text-xs sm:text-sm text-[var(--color-brand-light)] bg-[var(--color-brand-900)]/70 border border-[var(--color-brand-700)]/70 rounded-lg px-3 py-2"
                    >
                      <AlertTriangle className="w-4 h-4 text-[var(--color-brand-gold)] flex-shrink-0 mt-0.5" />
                      <span>{reason}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <p className="text-xs sm:text-sm text-[var(--color-brand-muted)] leading-relaxed">
                Would you like to override this schedule conflict and confirm anyway?
              </p>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setConflictOverridePrompt(null)}
                  className="px-4 py-2.5 rounded-xl border border-[var(--color-brand-700)] text-sm font-bold text-[var(--color-brand-muted)] hover:text-[var(--color-brand-light)] hover:bg-[var(--color-brand-900)]/60 transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={conflictOverridePrompt.onConfirm}
                  className="px-5 py-2.5 rounded-xl bg-[var(--color-brand-periwinkle)] hover:bg-[var(--color-brand-periwinkle-hover)] text-white text-sm font-bold transition-all cursor-pointer shadow-md"
                >
                  Override & Confirm
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* UPFRONT OUTSIDE WORKING HOURS CONFIRMATION GATE MODAL */}
      {outOfHoursPrompt && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-in fade-in duration-200">
          <div className="bg-[var(--color-brand-800)] w-full max-w-md rounded-2xl flex flex-col border border-[var(--color-brand-700)] shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between p-5 sm:p-6 border-b border-[var(--color-brand-700)]">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-full bg-[var(--color-brand-900)] border border-[#D4AF37]/60">
                  <Clock className="w-5 h-5 text-[var(--color-brand-gold)]" />
                </div>
                <h2 className="text-lg sm:text-xl font-bold text-[var(--color-brand-light)]">Outside Working Hours</h2>
              </div>
              <button
                type="button"
                onClick={() => setOutOfHoursPrompt(null)}
                className="text-[var(--color-brand-muted)] hover:text-[var(--color-brand-light)] cursor-pointer"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            <div className="p-5 sm:p-6 space-y-5">
              <p className="text-sm sm:text-base text-[var(--color-brand-light)] leading-relaxed">
                Hey, just so you know, this is outside of your working hours. You can still book a chunk of time as usual and the rest of the day around it will remain blocked off as a non-working day.
              </p>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setOutOfHoursPrompt(null)}
                  className="px-4 py-2.5 rounded-xl border border-[var(--color-brand-700)] text-sm font-bold text-[var(--color-brand-muted)] hover:text-[var(--color-brand-light)] hover:bg-[var(--color-brand-900)]/60 transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const targetDate = outOfHoursPrompt.date
                    const targetTime = outOfHoursPrompt.time
                    setBookDate(targetDate)
                    setBookTime(targetTime)
                    if (targetTime) {
                      setBlockEndTime(minutesToTime(toMinutes(targetTime) + 60))
                    }
                    setOutOfHoursPrompt(null)
                    setShowBookModal(true)
                  }}
                  className="px-6 py-2.5 rounded-xl bg-[var(--color-brand-periwinkle)] hover:bg-[var(--color-brand-periwinkle-hover)] text-white text-sm font-bold transition-all cursor-pointer shadow-md"
                >
                  Okay
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MANUAL BOOK & BLOCK TIME MODAL */}
      {showBookModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-in fade-in duration-200">
           <div className="bg-[var(--color-brand-800)] w-full max-w-md rounded-2xl flex flex-col border border-[var(--color-brand-700)] shadow-2xl overflow-hidden max-h-[90vh]">
              <div className="flex items-center justify-between p-6 border-b border-[var(--color-brand-700)] flex-shrink-0">
                <h2 className="text-xl font-bold">{isBlockoutMode ? 'Block Time' : 'Manual Book'}</h2>
                <button
                  onClick={() => {
                    setShowBookModal(false)
                    setIsBlockoutMode(false)
                    setIsRepeatingBlockout(false)
                    setBookServices([])
                    setBookTime('')
                    setBlockEndTime('')
                    setBookNotes('')
                    setClientName('')
                    setClientPhone('')
                    setSelectedExistingClient(null)
                    setShowExistingClientPicker(false)
                    setClientSearchQuery('')
                  }}
                  className="text-[var(--color-brand-muted)] hover:text-[var(--color-brand-light)] cursor-pointer"
                >
                  <X className="w-6 h-6" />
                </button>
              </div>

              {/* Mode Tabs: Book Client vs Block Time */}
              <div className="flex bg-[var(--color-brand-900)] p-1 rounded-xl mx-6 mt-4 border border-[var(--color-brand-700)] flex-shrink-0">
                <button
                  type="button"
                  onClick={() => setIsBlockoutMode(false)}
                  className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all cursor-pointer ${
                    !isBlockoutMode
                      ? 'bg-[var(--color-brand-accent)] text-white shadow-md'
                      : 'text-[var(--color-brand-muted)] hover:text-[var(--color-brand-light)]'
                  }`}
                >
                  Book Client
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setIsBlockoutMode(true)
                    if (!blockEndTime && bookTime) {
                      setBlockEndTime(minutesToTime(toMinutes(bookTime) + 60))
                    }
                  }}
                  className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all cursor-pointer ${
                    isBlockoutMode
                      ? 'bg-zinc-700 text-white shadow-md'
                      : 'text-[var(--color-brand-muted)] hover:text-[var(--color-brand-light)]'
                  }`}
                >
                  Block Time
                </button>
              </div>

              <form onSubmit={handleAdminBooking} className="p-6 space-y-4 overflow-y-auto flex-1">
                 {/* DATE FIELD - ALWAYS SHOWN */}
                 <div>
                   <label className="block text-xs font-bold text-[var(--color-brand-muted)] uppercase tracking-wider mb-1.5">Date</label>
                   <input
                     type="date"
                     required
                     value={bookDate}
                     onChange={(e) => {
                       const nextDate = e.target.value
                       if (!nextDate) return
                       const effectiveOverrides = [
                         ...(dayViewOverride ? [dayViewOverride] : []),
                         ...weekOverrides,
                         ...monthOverrides,
                       ]
                       if (!isBlockoutMode && isNonWorkingDate(nextDate, effectiveOverrides)) {
                         setShowBookModal(false)
                         setOutOfHoursPrompt({ date: nextDate, time: bookTime, isBlockout: false })
                         return
                       }
                       setBookDate(nextDate)
                     }}
                     className={`w-full bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] rounded-xl p-3 outline-none ${isLight ? '[color-scheme:light]' : '[color-scheme:dark]'} cursor-pointer text-[var(--color-brand-light)]`}
                   />
                 </div>

                 {!isBlockoutMode ? (
                   <>
                     {/* MULTI-SERVICE SELECTOR */}
                     <div className="space-y-2.5">
                       <div className="flex items-center justify-between">
                         <label className="block text-xs font-bold text-[var(--color-brand-muted)] uppercase tracking-wider">
                           {bookServices.length > 0 ? 'Selected Services' : 'Service'}
                         </label>
                         {bookServices.length > 0 && (
                           <span className="text-xs font-bold text-[var(--color-brand-gold)]">
                             {bookServices.length} {bookServices.length === 1 ? 'Service' : 'Services'} • {bookTotalDurationMinutes}m • ${bookTotalPrice}
                           </span>
                         )}
                       </div>

                       {bookServices.length > 0 && (
                         <div className="space-y-1.5">
                           {bookServices.map((svc, idx) => (
                             <div
                               key={`${svc.id}-${idx}`}
                               className="flex items-center justify-between gap-2 bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] px-3 py-2 rounded-xl"
                             >
                               <div className="min-w-0">
                                 <p className="text-sm font-bold text-[var(--color-brand-light)] truncate">{svc.name}</p>
                                 <p className="text-xs text-[var(--color-brand-muted)]">
                                   {svc.duration_minutes}m • <span className="text-[var(--color-brand-gold)] font-semibold">${svc.price}</span>
                                 </p>
                               </div>
                               <button
                                 type="button"
                                 onClick={() => setBookServices(prev => prev.filter((_, i) => i !== idx))}
                                 className="p-1.5 rounded-lg text-[var(--color-brand-muted)] hover:text-red-400 hover:bg-red-500/15 transition-colors cursor-pointer flex-shrink-0"
                                 aria-label={`Remove ${svc.name}`}
                               >
                                 <X className="w-4 h-4" />
                               </button>
                             </div>
                           ))}
                         </div>
                       )}

                       <select
                         value=""
                         onChange={(e) => {
                           const chosen = adminServices.find(s => s.id === e.target.value)
                           if (chosen) {
                             setBookServices(prev => [...prev, chosen])
                           }
                         }}
                         className="w-full bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] rounded-xl p-3 outline-none appearance-none cursor-pointer text-[var(--color-brand-light)]"
                       >
                         <option value="" disabled>
                           {bookServices.length === 0 ? 'Select a service...' : 'Add another service...'}
                         </option>
                         {adminServices.map(s => (
                           <option key={s.id} value={s.id}>
                             {bookServices.length === 0 ? `${s.name} (${s.duration_minutes}m • $${s.price})` : `+ ${s.name} (${s.duration_minutes}m • $${s.price})`}
                           </option>
                         ))}
                       </select>
                     </div>

                     {/* START TIME SELECT (REGULAR OPEN SLOTS + SQUEEZE-IN / EXCEPTION SLOTS + OCCUPIED OVERRIDE SLOTS) */}
                     <div>
                       <label className="block text-xs font-bold text-[var(--color-brand-muted)] uppercase tracking-wider mb-1.5">Start Time</label>
                       {(() => {
                         const outsideSlots = allCollisionFreeSlots.filter(t => !bookSlots.includes(t))
                         const occupiedSlots = ALL_DAY_15_MIN_SLOTS.filter(
                           t => !bookSlots.includes(t) && !outsideSlots.includes(t)
                         )
                         return (
                           <>
                             <select
                               required
                               value={ALL_DAY_15_MIN_SLOTS.includes(bookTime) ? bookTime : ''}
                               onChange={(e) => setBookTime(e.target.value)}
                               className="w-full bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] rounded-xl p-3 outline-none appearance-none cursor-pointer text-[var(--color-brand-light)]"
                             >
                               <option value="" disabled>
                                 Select time...
                               </option>
                               {bookSlots.length > 0 && (
                                 <optgroup label="Regular Scheduled Hours">
                                   {bookSlots.map(time => (
                                     <option key={time} value={time}>{formatTime(time)}</option>
                                   ))}
                                 </optgroup>
                               )}
                               {outsideSlots.length > 0 && (
                                 <optgroup label="Outside Scheduled Hours (Squeeze-In / Exception)">
                                   {outsideSlots.map(time => (
                                     <option key={time} value={time}>{formatTime(time)}</option>
                                   ))}
                                 </optgroup>
                               )}
                               {occupiedSlots.length > 0 && (
                                 <optgroup label="Occupied / Conflict Slots (Double-Book Override)">
                                   {occupiedSlots.map(time => (
                                     <option key={time} value={time}>{formatTime(time)} (Occupied)</option>
                                   ))}
                                 </optgroup>
                               )}
                             </select>
                           </>
                         )
                       })()}
                     </div>

                     <div className="space-y-3 pt-4 border-t border-[var(--color-brand-700)]">
                        {/* SELECT EXISTING CLIENT FROM DIRECTORY */}
                        <div className="space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-bold text-[var(--color-brand-muted)] uppercase tracking-wider">
                              Client Details
                            </span>
                            <button
                              type="button"
                              onClick={() => setShowExistingClientPicker(prev => !prev)}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold border border-[var(--color-brand-periwinkle)]/60 bg-[var(--color-brand-periwinkle)]/15 text-[var(--color-brand-periwinkle)] hover:bg-[var(--color-brand-periwinkle)] hover:text-white transition-all cursor-pointer"
                            >
                              <Users className="w-3.5 h-3.5" />
                              <span>{showExistingClientPicker ? 'Close Directory' : 'Select Existing Client'}</span>
                            </button>
                          </div>

                          {selectedExistingClient && (
                            <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-[var(--color-brand-periwinkle)]/15 border border-[var(--color-brand-periwinkle)]/60">
                              <div className="min-w-0 flex items-center gap-2">
                                <User className="w-3.5 h-3.5 text-[var(--color-brand-periwinkle)] flex-shrink-0" />
                                <div className="min-w-0">
                                  <p className="text-xs font-bold text-[var(--color-brand-light)] truncate">
                                    {selectedExistingClient.name}{' '}
                                    <span className="font-mono font-normal text-[var(--color-brand-muted)]">
                                      ({formatPhoneNumber(selectedExistingClient.phone)})
                                    </span>
                                  </p>
                                </div>
                              </div>
                              <button
                                type="button"
                                title="Clear selected client"
                                aria-label="Clear selected client"
                                onClick={() => {
                                  setSelectedExistingClient(null)
                                  setClientName('')
                                  setClientPhone('')
                                  setBookNotes('')
                                }}
                                className="p-1 rounded-lg text-[var(--color-brand-muted)] hover:text-red-400 hover:bg-red-500/15 transition-colors cursor-pointer flex-shrink-0"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          )}

                          {showExistingClientPicker && (() => {
                            const q = clientSearchQuery.trim().toLowerCase()
                            const qDigits = clientSearchQuery.replace(/\D/g, '')
                            const directoryMatches = clientsList
                              .filter(c => {
                                if (!c.phone || c.phone === '0000000000') return false
                                if (!q) return true
                                const nameMatches = (c.name || '').toLowerCase().includes(q)
                                const phoneMatches = qDigits.length > 0 && cleanPhone(c.phone).includes(qDigits)
                                return nameMatches || phoneMatches
                              })
                              .slice(0, 40)

                            return (
                              <div className="bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] rounded-xl p-2.5 space-y-2 shadow-inner">
                                <div className="relative">
                                  <Search className="w-3.5 h-3.5 text-[var(--color-brand-muted)] absolute left-3 top-1/2 -translate-y-1/2" />
                                  <input
                                    type="text"
                                    value={clientSearchQuery}
                                    onChange={(e) => setClientSearchQuery(e.target.value)}
                                    placeholder="Search clients by name or phone..."
                                    className="w-full bg-[var(--color-brand-800)] border border-[var(--color-brand-700)] rounded-lg py-2 pl-8 pr-7 text-xs text-[var(--color-brand-light)] outline-none focus:border-[var(--color-brand-periwinkle)]"
                                  />
                                  {clientSearchQuery && (
                                    <button
                                      type="button"
                                      onClick={() => setClientSearchQuery('')}
                                      className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-brand-muted)] hover:text-[var(--color-brand-light)] cursor-pointer"
                                    >
                                      <X className="w-3.5 h-3.5" />
                                    </button>
                                  )}
                                </div>

                                <div className="max-h-44 overflow-y-auto space-y-1 pr-0.5">
                                  {directoryMatches.length === 0 ? (
                                    <p className="text-xs text-[var(--color-brand-muted)] text-center py-3 italic">
                                      No matching clients found.
                                    </p>
                                  ) : (
                                    directoryMatches.map(c => (
                                      <button
                                        key={c.id}
                                        type="button"
                                        onClick={() => {
                                          setSelectedExistingClient(c)
                                          setClientName(c.name)
                                          setClientPhone(formatPhoneNumber(c.phone))
                                          if (!bookNotes.trim() && c.notes) {
                                            setBookNotes(c.notes)
                                          }
                                          setShowExistingClientPicker(false)
                                          setClientSearchQuery('')
                                        }}
                                        className="w-full text-left px-2.5 py-2 rounded-lg bg-[var(--color-brand-800)]/80 hover:bg-[var(--color-brand-accent)]/20 border border-transparent hover:border-[var(--color-brand-accent)]/50 transition-all cursor-pointer flex flex-col gap-0.5"
                                      >
                                        <div className="flex items-center justify-between gap-2">
                                          <span className="text-xs font-bold text-[var(--color-brand-light)] truncate">
                                            {c.name}
                                          </span>
                                          <span className="text-[11px] font-mono text-[var(--color-brand-muted)] flex-shrink-0">
                                            {formatPhoneNumber(c.phone)}
                                          </span>
                                        </div>
                                        {c.is_red_listed && (
                                          <span className="inline-flex items-center w-fit text-[9px] font-extrabold bg-red-600 text-white px-1.5 py-0.5 rounded mt-0.5">
                                            🚩 RED LIST • OWES {(c.red_listed_by || 'SHOP').toUpperCase()}
                                          </span>
                                        )}
                                        {c.notes && (
                                          <p className="text-[11px] text-[var(--color-brand-muted)] truncate italic">
                                            ✂️ {c.notes}
                                          </p>
                                        )}
                                      </button>
                                    ))
                                  )}
                                </div>
                              </div>
                            )
                          })()}
                        </div>

                        {(() => {
                          const cleanedBookPhone = cleanPhone(clientPhone)
                          const trimmedBookName = clientName.trim().toLowerCase()
                          const matchedRedListedClient = clientsList.find((c) => {
                            if (!c.is_red_listed) return false
                            if (cleanedBookPhone.length === 10 && cleanPhone(c.phone || '') === cleanedBookPhone) return true
                            if (trimmedBookName.length >= 3 && (c.name || '').trim().toLowerCase() === trimmedBookName) return true
                            return false
                          })
                          if (!matchedRedListedClient) return null
                          return (
                            <div className="bg-red-950/90 border-2 border-red-500 text-red-100 rounded-xl p-3 text-xs font-bold flex items-start gap-2.5 shadow-md">
                              <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                              <span>
                                🚩 Heads up: {matchedRedListedClient.name} is RED LISTED (Owes {matchedRedListedClient.red_listed_by || 'a barber'} — {matchedRedListedClient.red_listed_reason || 'Missed appointment fee required'}).
                              </span>
                            </div>
                          )
                        })()}
                        <div className="relative">
                          <User className="w-4 h-4 text-[var(--color-brand-muted)] absolute left-3 top-1/2 -translate-y-1/2" />
                          <input
                            type="text"
                            required
                            placeholder="Client Name"
                            value={clientName}
                            onChange={(e) => setClientName(e.target.value)}
                            className="w-full bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] rounded-xl p-3 pl-10 text-[var(--color-brand-light)] outline-none focus:border-[var(--color-brand-accent)]"
                          />
                        </div>
                        <div className="relative">
                          <Phone className="w-4 h-4 text-[var(--color-brand-muted)] absolute left-3 top-1/2 -translate-y-1/2" />
                          <input
                            type="tel"
                            required
                            placeholder="Phone Number"
                            value={clientPhone}
                            onChange={(e) => setClientPhone(e.target.value)}
                            className="w-full bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] rounded-xl p-3 pl-10 text-[var(--color-brand-light)] outline-none focus:border-[var(--color-brand-accent)]"
                          />
                        </div>
                        <div className="relative">
                          <FileText className="w-4 h-4 text-[var(--color-brand-muted)] absolute left-3 top-3.5" />
                          <textarea
                            placeholder="Appointment Notes (Optional)"
                            value={bookNotes}
                            onChange={(e) => setBookNotes(e.target.value)}
                            rows={2}
                            className="w-full bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] rounded-xl p-3 pl-10 text-[var(--color-brand-light)] outline-none focus:border-[var(--color-brand-accent)] resize-none"
                          />
                        </div>
                     </div>

                     <button
                       type="submit"
                       disabled={isBooking || !bookTime || bookServices.length === 0 || !clientName || !clientPhone}
                       className="w-full bg-[var(--color-brand-accent)] text-white font-bold p-3 rounded-xl mt-4 cursor-pointer disabled:opacity-50 hover:not-disabled:brightness-110 transition-all"
                     >
                       {isBooking ? 'Booking...' : 'Confirm Appointment'}
                     </button>
                   </>
                 ) : (
                   <>
                     {/* BLOCKOUT MODE: START TIME, END TIME, REPEATING SWITCH, AND NOTES */}
                     <div className="grid grid-cols-2 gap-4">
                       <div>
                         <label className="block text-xs font-bold text-[var(--color-brand-muted)] uppercase tracking-wider mb-1.5">Start Time</label>
                         <input
                           type="time"
                           required
                           value={bookTime}
                           onChange={(e) => setBookTime(e.target.value)}
                           className={`w-full bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] rounded-xl p-3 outline-none ${isLight ? '[color-scheme:light]' : '[color-scheme:dark]'} cursor-pointer text-[var(--color-brand-light)]`}
                         />
                       </div>
                       <div>
                         <label className="block text-xs font-bold text-[var(--color-brand-muted)] uppercase tracking-wider mb-1.5">End Time</label>
                         <input
                           type="time"
                           required
                           value={blockEndTime}
                           onChange={(e) => setBlockEndTime(e.target.value)}
                           className={`w-full bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] rounded-xl p-3 outline-none ${isLight ? '[color-scheme:light]' : '[color-scheme:dark]'} cursor-pointer text-[var(--color-brand-light)]`}
                         />
                       </div>
                     </div>

                     {(() => {
                       const { formattedCutoff, totalDaysInRange } = getEndOfWeekSundayInfo(bookDate)
                       return (
                         <div className="flex items-center justify-between gap-3 p-3.5 rounded-xl bg-[var(--color-brand-900)]/80 border border-[var(--color-brand-700)]">
                           <div className="min-w-0">
                             <div className="text-sm font-bold text-[var(--color-brand-light)]">
                               Repeat through end of week ({formattedCutoff})
                             </div>
                             <div className="text-xs text-[var(--color-brand-muted)] leading-snug mt-0.5">
                               Auto-block this exact time window on working days through {formattedCutoff} ({totalDaysInRange} {totalDaysInRange === 1 ? 'day' : 'days'} in current week).
                             </div>
                           </div>
                           <button
                             type="button"
                             role="switch"
                             aria-checked={isRepeatingBlockout}
                             onClick={() => setIsRepeatingBlockout(prev => !prev)}
                             className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                               isRepeatingBlockout ? 'bg-[var(--color-brand-accent)]' : 'bg-[var(--color-brand-700)]'
                             }`}
                           >
                             <span
                               className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                                 isRepeatingBlockout ? 'translate-x-5' : 'translate-x-0'
                               }`}
                             />
                           </button>
                         </div>
                       )
                     })()}

                     <div className="space-y-1.5 pt-2">
                       <label className="block text-xs font-bold text-[var(--color-brand-muted)] uppercase tracking-wider">Reason / Notes</label>
                       <div className="relative">
                         <FileText className="w-4 h-4 text-[var(--color-brand-muted)] absolute left-3 top-3.5" />
                         <textarea
                           placeholder="e.g. Lunch, Doctor, Running Late..."
                           value={bookNotes}
                           onChange={(e) => setBookNotes(e.target.value)}
                           rows={2}
                           className="w-full bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] rounded-xl p-3 pl-10 text-[var(--color-brand-light)] outline-none focus:border-[var(--color-brand-accent)] resize-none"
                         />
                       </div>
                     </div>

                     <button
                       type="submit"
                       disabled={isBooking || !bookTime || !blockEndTime}
                       className="w-full bg-zinc-700 hover:bg-zinc-600 text-white font-bold p-3 rounded-xl mt-4 cursor-pointer disabled:opacity-50 transition-colors shadow-md flex items-center justify-center gap-2"
                     >
                       <Ban className="w-4 h-4" />
                       {isBooking ? 'Blocking Time...' : 'Confirm Blockout'}
                     </button>
                   </>
                 )}
              </form>
           </div>
        </div>
      )}

      {/* BARBER SETTINGS / WORKING HOURS MODAL */}
      {showBarberSettingsModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-in fade-in duration-200">
          <div className="bg-[var(--color-brand-800)] w-full max-w-lg rounded-2xl flex flex-col border border-[var(--color-brand-700)] shadow-2xl overflow-hidden max-h-[90vh]">
            <div className="flex items-center justify-between p-5 sm:p-6 border-b border-[var(--color-brand-700)] flex-shrink-0">
              <div>
                <h2 className="text-xl font-bold flex items-center gap-2">
                  <SlidersHorizontal className="w-5 h-5 text-[var(--color-brand-accent)]" />
                  Barber Working Hours
                </h2>
                <p className="text-xs sm:text-sm text-[var(--color-brand-muted)]">
                  {barbers.find(b => b.id === selectedBarberId)?.name || 'Selected Barber'}'s Weekly Schedule
                </p>
              </div>
              <button
                onClick={() => setShowBarberSettingsModal(false)}
                className="text-[var(--color-brand-muted)] hover:text-[var(--color-brand-light)] cursor-pointer p-1 rounded-lg"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            <div className="p-5 sm:p-6 space-y-3.5 overflow-y-auto flex-1">
              {loadingWorkingHours ? (
                <div className="text-center py-12 text-[var(--color-brand-muted)] animate-pulse">
                  Loading schedule...
                </div>
              ) : (
                DAYS_OF_WEEK.map(day => {
                  const daySched = barberWorkingHours[day.index] || DEFAULT_WORKING_HOURS[day.index]
                  const isWorking = daySched.isWorking

                  return (
                    <div
                      key={day.index}
                      className={`p-3.5 rounded-xl border transition-all ${
                        isWorking
                          ? 'bg-[var(--color-brand-900)] border-[var(--color-brand-700)]'
                          : 'bg-[var(--color-brand-900)]/40 border-[var(--color-brand-700)]/40 opacity-70'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2.5">
                        <span className="font-bold text-sm sm:text-base text-[var(--color-brand-light)]">
                          {day.name}
                        </span>

                        <div className="flex items-center gap-2">
                          <span className={`text-xs font-semibold ${isWorking ? 'text-[var(--color-brand-accent)]' : 'text-red-500'}`}>
                            {isWorking ? 'Working' : 'Off'}
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              setBarberWorkingHours(prev => ({
                                ...prev,
                                [day.index]: {
                                  ...prev[day.index],
                                  isWorking: !isWorking,
                                }
                              }))
                            }}
                            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer ${
                              isWorking ? 'bg-[var(--color-brand-accent)]' : 'bg-[var(--color-brand-700)]'
                            }`}
                          >
                            <span
                              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                                isWorking ? 'translate-x-6' : 'translate-x-1'
                              }`}
                            />
                          </button>
                        </div>
                      </div>

                      {isWorking ? (
                        <div className="flex items-center gap-2.5">
                          <div className="flex-1">
                            <label className="block text-[10px] font-bold text-[var(--color-brand-muted)] uppercase mb-1">Start Time</label>
                            <input
                              type="time"
                              value={daySched.start_time}
                              onChange={(e) => {
                                const val = e.target.value
                                setBarberWorkingHours(prev => ({
                                  ...prev,
                                  [day.index]: {
                                    ...prev[day.index],
                                    start_time: val
                                  }
                                }))
                              }}
                              className={`w-full bg-[var(--color-brand-800)] text-[var(--color-brand-light)] border border-[var(--color-brand-700)] rounded-lg p-2 text-xs sm:text-sm outline-none ${isLight ? '[color-scheme:light]' : '[color-scheme:dark]'} cursor-pointer`}
                            />
                          </div>
                          <span className="text-[var(--color-brand-muted)] pt-5 text-xs">to</span>
                          <div className="flex-1">
                            <label className="block text-[10px] font-bold text-[var(--color-brand-muted)] uppercase mb-1">End Time</label>
                            <input
                              type="time"
                              value={daySched.end_time}
                              onChange={(e) => {
                                const val = e.target.value
                                setBarberWorkingHours(prev => ({
                                  ...prev,
                                  [day.index]: {
                                    ...prev[day.index],
                                    end_time: val
                                  }
                                }))
                              }}
                              className={`w-full bg-[var(--color-brand-800)] text-[var(--color-brand-light)] border border-[var(--color-brand-700)] rounded-lg p-2 text-xs sm:text-sm outline-none ${isLight ? '[color-scheme:light]' : '[color-scheme:dark]'} cursor-pointer`}
                            />
                          </div>
                        </div>
                      ) : (
                        <div className="text-xs text-[var(--color-brand-muted)] italic">
                          Barber is unavailable for bookings on {day.name}s.
                        </div>
                      )}
                    </div>
                  )
                })
              )}
            </div>

            <div className="p-5 sm:p-6 border-t border-[var(--color-brand-700)] bg-[var(--color-brand-900)] flex items-center justify-between gap-3 flex-shrink-0">
              <button
                type="button"
                onClick={() => setShowManageDayModal(true)}
                className="text-xs text-[var(--color-brand-accent)] hover:underline cursor-pointer font-bold"
              >
                Single Date Overrides →
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowBarberSettingsModal(false)}
                  className="px-4 py-2.5 rounded-xl border border-[var(--color-brand-700)] text-xs font-bold hover:bg-[var(--color-brand-700)]/40 transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSaveWorkingHours}
                  disabled={isSavingWorkingHours || loadingWorkingHours}
                  className="px-5 py-2.5 rounded-xl bg-[var(--color-brand-accent)] text-white text-xs font-bold hover:brightness-110 transition-all cursor-pointer disabled:opacity-50 shadow-md"
                >
                  {isSavingWorkingHours ? 'Saving...' : 'Save Schedule'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MANAGE DAY MODAL (Vagaro-Style Overrides & Blocking) */}
      {showManageDayModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-in fade-in duration-200">
           <div className="bg-[var(--color-brand-800)] w-full max-w-md rounded-2xl flex flex-col border border-[var(--color-brand-700)] shadow-2xl overflow-hidden">

              <div className="flex items-center justify-between p-6 border-b border-[var(--color-brand-700)]">
                <div>
                  <h2 className="text-xl font-bold">Manage Schedule</h2>
                  <p className="text-sm text-[var(--color-brand-accent)]">{new Date(selectedDate).toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric', timeZone: 'UTC' })}</p>
                </div>
                <button onClick={() => setShowManageDayModal(false)} className="text-[var(--color-brand-muted)] hover:text-[var(--color-brand-light)] cursor-pointer"><X className="w-6 h-6" /></button>
              </div>

              <div className="p-6 space-y-8 overflow-y-auto max-h-[80vh]">

                {/* 1. Full Day Override Tool */}
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="font-bold text-lg text-[var(--color-brand-light)]">Entire Day Status</h3>
                    <button
                      onClick={() => setIsDayOff(!isDayOff)}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer ${isDayOff ? 'bg-red-500' : 'bg-[var(--color-brand-accent)]'}`}
                    >
                      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${isDayOff ? 'translate-x-6' : 'translate-x-1'}`}/>
                    </button>
                  </div>

                  {isDayOff ? (
                    <div className="bg-red-500/10 border border-red-500/40 p-4 rounded-xl text-red-500 text-sm font-semibold">
                      You are marked OFF for this entire day. Clients cannot book you.
                    </div>
                  ) : (
                    <div className="bg-[var(--color-brand-900)] p-4 rounded-xl border border-[var(--color-brand-700)] space-y-3">
                      <p className="text-xs text-[var(--color-brand-muted)] uppercase tracking-wider font-bold">Custom Working Hours</p>
                      <div className="flex items-center gap-3">
                        <input type="time" value={overrideStart} onChange={(e) => setOverrideStart(e.target.value)} className={`w-full bg-[var(--color-brand-800)] text-[var(--color-brand-light)] border border-[var(--color-brand-700)] rounded-lg p-2 outline-none ${isLight ? '[color-scheme:light]' : '[color-scheme:dark]'} cursor-pointer`} />
                        <span className="text-[var(--color-brand-muted)]">to</span>
                        <input type="time" value={overrideEnd} onChange={(e) => setOverrideEnd(e.target.value)} className={`w-full bg-[var(--color-brand-800)] text-[var(--color-brand-light)] border border-[var(--color-brand-700)] rounded-lg p-2 outline-none ${isLight ? '[color-scheme:light]' : '[color-scheme:dark]'} cursor-pointer`} />
                      </div>
                    </div>
                  )}
                  <button onClick={handleSaveDayOverride} disabled={isSavingOverride} className="w-full bg-[var(--color-brand-800)] border border-[var(--color-brand-700)] text-[var(--color-brand-light)] font-bold p-3 rounded-xl hover:border-[var(--color-brand-accent)] transition-all cursor-pointer disabled:opacity-50">
                    Save Day Status
                  </button>
                </div>

                <hr className="border-[var(--color-brand-700)]" />

                {/* 2. Block Time Chunk Tool */}
                <form onSubmit={handleBlockTimeChunk} className={`space-y-4 ${isDayOff ? 'opacity-50 pointer-events-none' : ''}`}>
                  <h3 className="font-bold text-lg text-[var(--color-brand-light)]">Block Specific Time</h3>
                  <p className="text-sm text-[var(--color-brand-muted)]">Block out a chunk of the day (e.g., lunch, meetings) so online clients cannot book it.</p>

                  <div className="flex items-center gap-3">
                    <input type="time" required value={blockStart} onChange={(e) => setBlockStart(e.target.value)} className={`w-full bg-[var(--color-brand-900)] text-[var(--color-brand-light)] border border-[var(--color-brand-700)] rounded-lg p-3 outline-none ${isLight ? '[color-scheme:light]' : '[color-scheme:dark]'} cursor-pointer`} />
                    <span className="text-[var(--color-brand-muted)]">to</span>
                    <input type="time" required value={blockEnd} onChange={(e) => setBlockEnd(e.target.value)} className={`w-full bg-[var(--color-brand-900)] text-[var(--color-brand-light)] border border-[var(--color-brand-700)] rounded-lg p-3 outline-none ${isLight ? '[color-scheme:light]' : '[color-scheme:dark]'} cursor-pointer`} />
                  </div>
                  <button type="submit" disabled={isSavingOverride || !blockStart || !blockEnd} className="w-full bg-orange-600/20 text-orange-500 border border-orange-500/50 font-bold p-3 rounded-xl hover:bg-orange-600/40 transition-all cursor-pointer disabled:opacity-50">
                    Inject Block
                  </button>
                </form>

              </div>
           </div>
        </div>
      )}

      {/* MANUAL ADD CLIENT MODAL */}
      {showAddClientModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-in fade-in duration-200">
          <div className="bg-[var(--color-brand-800)] w-full max-w-md rounded-2xl flex flex-col border border-[var(--color-brand-700)] shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between p-6 border-b border-[var(--color-brand-700)]">
              <div>
                <h2 className="text-xl font-bold flex items-center gap-2">
                  <Plus className="w-5 h-5 text-[var(--color-brand-accent)]" />
                  Add New Client
                </h2>
                <p className="text-xs text-[var(--color-brand-muted)] mt-0.5">
                  Create or sync a client record in your directory
                </p>
              </div>
              <button
                onClick={() => {
                  setShowAddClientModal(false)
                  setNewClientName('')
                  setNewClientPhone('')
                  setNewClientNotes('')
                }}
                className="text-[var(--color-brand-muted)] hover:text-[var(--color-brand-light)] cursor-pointer"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            <form onSubmit={handleAddManualClient} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-bold text-[var(--color-brand-muted)] uppercase tracking-wider mb-1.5">
                  Client Name
                </label>
                <div className="relative">
                  <User className="w-4 h-4 text-[var(--color-brand-muted)] absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    required
                    placeholder="First & Last Name"
                    value={newClientName}
                    onChange={(e) => setNewClientName(e.target.value)}
                    className="w-full bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] rounded-xl p-3 pl-10 text-[var(--color-brand-light)] outline-none focus:border-[var(--color-brand-accent)]"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-[var(--color-brand-muted)] uppercase tracking-wider mb-1.5">
                  Phone Number (10 Digits)
                </label>
                <div className="relative">
                  <Phone className="w-4 h-4 text-[var(--color-brand-muted)] absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="tel"
                    required
                    placeholder="(509) 555-1234"
                    value={newClientPhone}
                    onChange={(e) => setNewClientPhone(e.target.value)}
                    className="w-full bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] rounded-xl p-3 pl-10 text-[var(--color-brand-light)] outline-none focus:border-[var(--color-brand-accent)]"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-[var(--color-brand-muted)] uppercase tracking-wider mb-1.5">
                  Persistent Cut Notes (Optional)
                </label>
                <div className="relative">
                  <FileText className="w-4 h-4 text-[var(--color-brand-muted)] absolute left-3 top-3.5" />
                  <textarea
                    placeholder="e.g. #1.5 mid skin fade, hard part on left..."
                    value={newClientNotes}
                    onChange={(e) => setNewClientNotes(e.target.value)}
                    rows={3}
                    className="w-full bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] rounded-xl p-3 pl-10 text-[var(--color-brand-light)] outline-none focus:border-[var(--color-brand-accent)] resize-none text-sm"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={isSavingNewClient || !newClientName.trim() || !newClientPhone.trim()}
                className="w-full bg-[var(--color-brand-accent)] text-white font-bold p-3.5 rounded-xl mt-2 cursor-pointer disabled:opacity-50 hover:brightness-110 transition-all shadow-md"
              >
                {isSavingNewClient ? 'Saving Client...' : 'Save Client'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* CLIENT PROFILE & HISTORY MODAL */}
      {selectedProfileClient && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-in fade-in duration-200">
          <div className="bg-[var(--color-brand-800)] w-full max-w-2xl rounded-2xl flex flex-col border border-[var(--color-brand-700)] shadow-2xl overflow-hidden max-h-[90vh]">
            {/* Modal Header */}
            <div className="flex items-center justify-between p-5 sm:p-6 border-b border-[var(--color-brand-700)] flex-shrink-0">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-11 h-11 rounded-full bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] flex items-center justify-center text-[var(--color-brand-accent)] font-bold text-lg flex-shrink-0">
                  {(selectedProfileClient.name || 'C').charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <h2 className="text-xl font-bold text-[var(--color-brand-light)] truncate">
                    {selectedProfileClient.name}
                  </h2>
                  <p className="text-xs sm:text-sm text-[var(--color-brand-accent)] font-mono">
                    {formatPhoneNumber(selectedProfileClient.phone)} • {profileAppts.length} {profileAppts.length === 1 ? 'Appointment' : 'Appointments'}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setSelectedProfileClient(null)}
                className="text-[var(--color-brand-muted)] hover:text-[var(--color-brand-light)] cursor-pointer p-1"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            {/* Modal Scrollable Body */}
            <div className="p-5 sm:p-6 space-y-6 overflow-y-auto flex-1">
              {/* Red List Status Panel */}
              {selectedProfileClient.is_red_listed ? (() => {
                const owedBarber = selectedProfileClient.red_listed_by || 'Shop'
                const feeReminderSmsHref = buildFeeReminderSmsHref(selectedProfileClient.phone, selectedProfileClient.name, selectedProfileClient.red_listed_by)
                return (
                  <div className="bg-red-950/90 border-2 border-red-500 text-red-100 rounded-xl p-4 sm:p-5 space-y-3 shadow-lg">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <h3 className="text-sm font-extrabold text-red-200 tracking-wide">
                          🚩 RED LIST STATUS • OWES {owedBarber.toUpperCase()}
                        </h3>
                        <p className="text-xs text-red-100/90 mt-1">
                          {selectedProfileClient.red_listed_reason || 'No-Call / No-Show balance open'}
                        </p>
                      </div>
                      <span className="text-[11px] font-extrabold bg-red-600 text-white px-2.5 py-0.5 rounded-full">
                        No-Shows: {selectedProfileClient.no_show_count || 0}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-2.5 pt-1">
                      {feeReminderSmsHref && (
                        <a
                          href={feeReminderSmsHref}
                          className="flex-1 min-w-[150px] bg-red-600 hover:bg-red-500 text-white text-xs sm:text-sm font-bold py-2.5 px-3 rounded-xl flex items-center justify-center gap-2 transition-colors"
                        >
                          <MessageSquare className="w-4 h-4" />
                          <span>Text Fee Reminder</span>
                        </a>
                      )}
                      <button
                        type="button"
                        disabled={isUpdatingRedList}
                        onClick={() => handleClearRedList(selectedProfileClient.id, selectedProfileClient.name)}
                        className="flex-1 min-w-[190px] bg-emerald-600 hover:bg-emerald-500 text-white text-xs sm:text-sm font-bold py-2.5 px-3 rounded-xl flex items-center justify-center gap-2 transition-colors cursor-pointer disabled:opacity-50"
                      >
                        <CheckCircle2 className="w-4 h-4" />
                        <span>{isUpdatingRedList ? 'Updating...' : 'Clear Red List (Mark Paid/Resolved)'}</span>
                      </button>
                    </div>
                  </div>
                )
              })() : (
                <div className="bg-[var(--color-brand-900)]/90 border border-[var(--color-brand-700)] rounded-xl p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-xs font-bold text-[var(--color-brand-muted)] uppercase tracking-wider flex items-center gap-1.5">
                      <Flag className="w-3.5 h-3.5 text-red-400" />
                      Red List Status
                    </h3>
                    {(selectedProfileClient.no_show_count || 0) > 0 && (
                      <span className="text-[11px] font-bold text-red-400 bg-red-950/50 border border-red-500/40 px-2 py-0.5 rounded-full">
                        Past No-Shows: {selectedProfileClient.no_show_count}
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    <select
                      value={manualRedListBarber}
                      onChange={(e) => setManualRedListBarber(e.target.value)}
                      className="bg-[var(--color-brand-800)] border border-[var(--color-brand-700)] rounded-lg px-3 py-2 text-xs font-bold text-[var(--color-brand-light)] outline-none focus:border-red-500 cursor-pointer"
                    >
                      {['Michael', 'Matt', 'Flor'].map(name => (
                        <option key={name} value={name}>Owes {name}</option>
                      ))}
                    </select>
                    <input
                      type="text"
                      placeholder="Reason (e.g. No-show / balance owed)"
                      value={manualRedListReason}
                      onChange={(e) => setManualRedListReason(e.target.value)}
                      className="sm:col-span-2 bg-[var(--color-brand-800)] border border-[var(--color-brand-700)] rounded-lg px-3 py-2 text-xs text-[var(--color-brand-light)] outline-none focus:border-red-500"
                    />
                  </div>
                  <button
                    type="button"
                    disabled={isUpdatingRedList}
                    onClick={() => handleManualRedList(selectedProfileClient.id, manualRedListBarber, manualRedListReason, selectedProfileClient.name)}
                    className="w-full sm:w-auto px-4 py-2 rounded-lg border border-red-500/60 bg-red-950/30 hover:bg-red-600 hover:text-white text-red-400 text-xs font-bold transition-colors cursor-pointer disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
                  >
                    <Flag className="w-3.5 h-3.5" />
                    <span>{isUpdatingRedList ? 'Flagging...' : '🚩 Red List Client'}</span>
                  </button>
                </div>
              )}

              {/* Quick Call / Text Actions */}
              {selectedProfileClient.phone && selectedProfileClient.phone !== '0000000000' && (
                <div className="flex gap-3">
                  <a
                    href={`tel:${cleanPhone(selectedProfileClient.phone)}`}
                    className="flex-1 bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] text-center py-2.5 rounded-xl text-sm font-bold hover:border-[var(--color-brand-accent)] transition-colors flex items-center justify-center gap-2 cursor-pointer"
                  >
                    <Phone className="w-4 h-4 text-[var(--color-brand-accent)]" /> Call Client
                  </a>
                  <a
                    href={`sms:${cleanPhone(selectedProfileClient.phone)}`}
                    className="flex-1 bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] text-center py-2.5 rounded-xl text-sm font-bold hover:border-[var(--color-brand-accent)] transition-colors flex items-center justify-center gap-2 cursor-pointer"
                  >
                    <MessageSquare className="w-4 h-4 text-[var(--color-brand-accent)]" /> Text Client
                  </a>
                </div>
              )}

              {/* Editable Profile Form */}
              <form onSubmit={handleSaveClientProfile} className="bg-[var(--color-brand-900)]/90 border border-[var(--color-brand-700)] rounded-xl p-4 sm:p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold text-[var(--color-brand-muted)] uppercase tracking-wider flex items-center gap-1.5">
                    <User className="w-3.5 h-3.5 text-[var(--color-brand-accent)]" />
                    Client Profile & Persistent Cut Notes
                  </h3>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  <div>
                    <label className="block text-[11px] font-bold text-[var(--color-brand-muted)] uppercase tracking-wider mb-1">
                      Full Name
                    </label>
                    <input
                      type="text"
                      required
                      value={profileName}
                      onChange={(e) => setProfileName(e.target.value)}
                      className="w-full bg-[var(--color-brand-800)] border border-[var(--color-brand-700)] rounded-lg p-2.5 text-sm text-[var(--color-brand-light)] outline-none focus:border-[var(--color-brand-accent)]"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold text-[var(--color-brand-muted)] uppercase tracking-wider mb-1">
                      Phone Number
                    </label>
                    <input
                      type="tel"
                      required
                      value={profilePhone}
                      onChange={(e) => setProfilePhone(e.target.value)}
                      className="w-full bg-[var(--color-brand-800)] border border-[var(--color-brand-700)] rounded-lg p-2.5 text-sm text-[var(--color-brand-light)] font-mono outline-none focus:border-[var(--color-brand-accent)]"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-[var(--color-brand-muted)] uppercase tracking-wider mb-1">
                    Persistent Cut Notes (Guard Sizes, Formula, Vagaro Metadata)
                  </label>
                  <textarea
                    value={profileNotes}
                    onChange={(e) => setProfileNotes(e.target.value)}
                    placeholder="Add persistent cut notes, guard preferences, or client details..."
                    rows={3}
                    className="w-full bg-[var(--color-brand-800)] border border-[var(--color-brand-700)] rounded-lg p-3 text-sm text-[var(--color-brand-light)] outline-none focus:border-[var(--color-brand-accent)] resize-none"
                  />
                </div>

                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={isSavingProfile}
                    className="bg-[var(--color-brand-accent)] text-white font-bold px-5 py-2.5 rounded-xl text-xs sm:text-sm hover:brightness-110 transition-all cursor-pointer disabled:opacity-50 flex items-center gap-2 shadow-md"
                  >
                    <Save className="w-4 h-4" />
                    {isSavingProfile ? 'Saving Changes...' : 'Save Profile & Notes'}
                  </button>
                </div>
              </form>

              {/* Chronological Appointment History */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold text-[var(--color-brand-muted)] uppercase tracking-wider flex items-center gap-1.5">
                    <History className="w-4 h-4 text-[var(--color-brand-accent)]" />
                    Appointment History ({profileAppts.length})
                  </h3>
                </div>

                {loadingProfileAppts ? (
                  <div className="text-center py-8 text-sm text-[var(--color-brand-muted)] animate-pulse bg-[var(--color-brand-900)] rounded-xl border border-[var(--color-brand-700)]">
                    Loading chronological history...
                  </div>
                ) : profileAppts.length === 0 ? (
                  <div className="text-center py-8 text-sm text-[var(--color-brand-muted)] bg-[var(--color-brand-900)] rounded-xl border border-dashed border-[var(--color-brand-700)]">
                    No appointments recorded in the PWA for this client yet.
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {profileAppts.map((appt) => {
                      const barberObj = barbers.find(b => b.id === appt.barber_id)
                      const serviceObj = allShopServices.find(s => s.id === appt.service_id)
                      const statusBadge = appt.status === 'cancelled'
                        ? (isLight ? 'bg-[#E6CCD2] text-[#7F1D1D] border-[#B91C1C]/40' : 'bg-red-950/80 text-red-300 border-red-800/60')
                        : appt.status === 'no-show'
                        ? (isLight ? 'bg-[#E5D2C4] text-[#7C2D12] border-[#C2410C]/40' : 'bg-orange-950/80 text-orange-300 border-orange-800/60')
                        : appt.status === 'completed'
                        ? (isLight ? 'bg-[#C7DEC9] text-[#14532D] border-[#15803D]/40' : 'bg-emerald-950/80 text-emerald-300 border-emerald-800/60')
                        : appt.status === 'walk-in'
                        ? (isLight ? 'bg-[#E8DBB8] text-[#78350F] border-[#B48A1E]/50' : 'bg-amber-950/80 text-amber-300 border-amber-800/60')
                        : 'bg-[#D4AF37]/10 text-[var(--color-brand-gold)] border-[#D4AF37]/50'

                      return (
                        <div
                          key={appt.id}
                          className="bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] rounded-xl p-3.5 flex flex-col gap-2"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-sm text-[var(--color-brand-light)]">
                                {formatDisplayDate(appt.appointment_date)}, {appt.appointment_date?.split('-')[0]}
                              </span>
                              <span className="text-xs font-semibold text-[var(--color-brand-accent)]">
                                {formatTime(appt.start_time)} – {formatTime(appt.end_time)}
                              </span>
                            </div>
                            <span className={`text-[10px] font-bold uppercase px-2.5 py-0.5 rounded-full border ${statusBadge}`}>
                              {appt.status || 'booked'}
                            </span>
                          </div>

                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--color-brand-muted)]">
                            <span className="flex items-center gap-1">
                              <Scissors className="w-3.5 h-3.5 text-[var(--color-brand-accent)]" />
                              <strong className="text-[var(--color-brand-light)]">{serviceObj?.name || (appt.status === 'walk-in' ? 'Walk-In Service' : 'Haircut / Service')}</strong>
                            </span>
                            <span className="flex items-center gap-1">
                              <User className="w-3.5 h-3.5 text-[var(--color-brand-accent)]" />
                              Barber: <strong className="text-[var(--color-brand-light)]">{barberObj?.name || 'Shop Barber'}</strong>
                            </span>
                          </div>

                          {appt.notes && (
                            <div className="bg-[var(--color-brand-800)] border border-[var(--color-brand-700)]/80 rounded-lg p-2.5 text-xs text-[var(--color-brand-light)] flex items-start gap-2 mt-0.5">
                              <FileText className="w-3.5 h-3.5 text-[var(--color-brand-accent)] flex-shrink-0 mt-0.5" />
                              <div>
                                <span className="font-bold text-[var(--color-brand-muted)] uppercase text-[10px] block mb-0.5">
                                  Appointment Booking Note:
                                </span>
                                {appt.notes}
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* PER-BARBER NEW BOOKING ALERTS DRAWER / MODAL */}
      {showAlertsModal && (() => {
        const activeBarberObj = barbers.find(b => b.id === selectedBarberId)
        const activeBarberFirstName = activeBarberObj?.name?.split(' ')[0] || 'Barber'
        const activeUnseenList = unseenBookings.filter(b => b.barber_id === selectedBarberId)

        return (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-in fade-in duration-200">
            <div className="bg-[var(--color-brand-800)] w-full max-w-lg rounded-2xl flex flex-col border border-[var(--color-brand-700)] shadow-2xl overflow-hidden max-h-[90vh]">
              <div className="flex items-center justify-between p-5 border-b border-[var(--color-brand-700)] flex-shrink-0 gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-9 h-9 rounded-full bg-[var(--color-brand-900)] border border-[#D4AF37]/60 flex items-center justify-center text-[var(--color-brand-gold)] flex-shrink-0">
                    <Bell className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <h2 className="text-lg font-bold truncate">
                      New Booking Alerts — {activeBarberFirstName}
                    </h2>
                    <p className="text-xs text-[var(--color-brand-muted)]">
                      {activeUnseenList.length} unseen online {activeUnseenList.length === 1 ? 'booking' : 'bookings'}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowAlertsModal(false)}
                  className="text-[var(--color-brand-muted)] hover:text-[var(--color-brand-light)] cursor-pointer p-1"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {activeUnseenList.length > 0 && (
                <div className="px-5 py-3 bg-[var(--color-brand-900)]/60 border-b border-[var(--color-brand-700)] flex items-center justify-between gap-2 flex-shrink-0">
                  <span className="text-xs font-semibold text-[var(--color-brand-muted)]">
                    Switching barber tabs preserves unread alerts.
                  </span>
                  <button
                    type="button"
                    disabled={clearingAllAlerts}
                    onClick={handleClearAllBarberAlerts}
                    className="px-3 py-1.5 rounded-lg bg-[var(--color-brand-accent)] text-white text-xs font-bold hover:brightness-110 transition-all cursor-pointer disabled:opacity-50 whitespace-nowrap"
                  >
                    {clearingAllAlerts ? 'Clearing...' : `Clear All for ${activeBarberFirstName}`}
                  </button>
                </div>
              )}

              <div className="p-5 space-y-3 overflow-y-auto flex-1">
                {activeUnseenList.length === 0 ? (
                  <div className="text-center py-10 bg-[var(--color-brand-900)]/70 border border-dashed border-[var(--color-brand-700)] rounded-xl p-6">
                    <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto mb-2" />
                    <p className="text-sm font-bold text-[var(--color-brand-light)]">
                      All caught up for {activeBarberFirstName}!
                    </p>
                    <p className="text-xs text-[var(--color-brand-muted)] mt-1">
                      New online bookings for {activeBarberFirstName} will appear here until acknowledged.
                    </p>
                  </div>
                ) : (
                  activeUnseenList.map(booking => (
                    <div
                      key={booking.id}
                      className="bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] rounded-xl p-4 space-y-3 shadow-sm"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-xs font-extrabold uppercase tracking-wide text-[var(--color-brand-gold)] truncate">
                            ✂️ {booking.services?.name || 'Service'}
                          </p>
                          <h3 className="text-base font-bold text-[var(--color-brand-light)] truncate mt-0.5">
                            {booking.clients?.name || 'Client'}
                          </h3>
                          {booking.clients?.phone && booking.clients.phone !== '0000000000' && (
                            <p className="text-xs font-mono text-[var(--color-brand-muted)]">
                              {formatPhoneNumber(booking.clients.phone)}
                            </p>
                          )}
                        </div>
                        <div className="text-right flex-shrink-0">
                          <p className="text-xs font-bold text-[var(--color-brand-light)]">
                            {formatDisplayDate(booking.appointment_date)}
                          </p>
                          <p className="text-xs font-semibold text-[var(--color-brand-accent)]">
                            {formatTime(booking.start_time)} – {formatTime(booking.end_time)}
                          </p>
                        </div>
                      </div>

                      {booking.notes && (
                        <div className="bg-[var(--color-brand-800)] border border-[var(--color-brand-700)] rounded-lg p-2.5 text-xs text-[var(--color-brand-light)] flex items-start gap-2">
                          <FileText className="w-3.5 h-3.5 text-[var(--color-brand-accent)] flex-shrink-0 mt-0.5" />
                          <span>{booking.notes}</span>
                        </div>
                      )}

                      <div className="flex gap-2 pt-1">
                        <button
                          type="button"
                          onClick={() => handleJumpToAlertSlot(booking)}
                          className="flex-1 py-2 px-3 rounded-lg border border-[var(--color-brand-periwinkle)]/60 bg-[var(--color-brand-periwinkle)]/15 text-[var(--color-brand-periwinkle)] hover:bg-[var(--color-brand-periwinkle)] hover:text-white text-xs font-bold transition-all cursor-pointer flex items-center justify-center gap-1.5"
                        >
                          <Calendar className="w-3.5 h-3.5" />
                          <span>Jump to Slot</span>
                        </button>
                        <button
                          type="button"
                          disabled={acknowledgingId === booking.id}
                          onClick={() => handleAcknowledgeBooking(booking.id)}
                          className="flex-1 py-2 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition-all cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1.5"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>{acknowledgingId === booking.id ? 'Saving...' : 'Acknowledge'}</span>
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )
      })()}
    </>
  )

  // --- 1. EDGE-TO-EDGE LIVE CALENDAR VIEW ---
  if (activeModule === 'calendar') {
    const now = new Date()
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

    return (
      <div
        onTouchStart={(e) => {
          if (e.touches.length !== 1) {
            calendarSwipeStartRef.current = null
            return
          }
          const startedOnAppt = Boolean((e.target as HTMLElement | null)?.closest?.('[data-appt-card]'))
          calendarSwipeStartRef.current = {
            x: e.touches[0].clientX,
            y: e.touches[0].clientY,
            startedOnAppt,
          }
        }}
        onTouchEnd={(e) => {
          const start = calendarSwipeStartRef.current
          calendarSwipeStartRef.current = null
          if (!start || e.changedTouches.length === 0) return

          const dx = e.changedTouches[0].clientX - start.x
          const dy = e.changedTouches[0].clientY - start.y

          // Strict Gesture Guards (CRITICAL)
          if (start.startedOnAppt) return
          if (isDragActiveRef.current || touchDraggedAppt) return
          if (Math.abs(dx) < 65) return
          if (Math.abs(dx) <= Math.abs(dy) * 1.4) return

          if (dx < 0) {
            stepCalendarPeriod(1)
          } else if (dx > 0) {
            stepCalendarPeriod(-1)
          }
        }}
        className="h-[100dvh] w-full bg-[var(--color-brand-900)] text-[var(--color-brand-light)] font-sans flex flex-col overflow-hidden relative"
      >
        {/* Touch / Mouse Drag Floating Preview (Visually Detached Chip Following Finger / Cursor) */}
        {touchPos && touchDraggedAppt && isTouchDragging && (() => {
          const durationMins = toMinutes(touchDraggedAppt.end_time) - toMinutes(touchDraggedAppt.start_time)
          const previewHeight = durationMins * PIXELS_PER_MINUTE
          const isBlockout = Boolean(touchDraggedAppt.is_blockout)
          const isBlocked = touchDraggedAppt.status === 'blocked' || isBlockout
          const isCompleted = touchDraggedAppt.status === 'completed'
          const isRedListed = !isBlockout && !isBlocked && Boolean(touchDraggedAppt.clients?.is_red_listed)
          const colorClasses = isBlockout
            ? (isLight ? 'bg-[#C4BBE0] border-[#8273AD] ring-[#8273AD]/50 text-[#170F2E]' : 'bg-zinc-800 border-zinc-600 ring-zinc-500/50 text-zinc-200')
            : isBlocked
            ? (isLight ? 'bg-[#E5D2C4] border-[#C26A2B] ring-[#C26A2B]/50 text-[#431407]' : 'bg-orange-950/95 border-orange-500 ring-orange-500/50 text-orange-200')
            : isCompleted
            ? (isLight ? 'bg-[#C7DEC9] border-[#2E7D4F] ring-[#2E7D4F]/50 text-[#052E16]' : 'bg-emerald-950/95 border-emerald-500 ring-emerald-500/50 text-emerald-200')
            : 'bg-[var(--color-brand-800)]/95 border-[var(--color-brand-accent)] ring-[var(--color-brand-accent)]/50 text-[var(--color-brand-light)]'

          return (
            <div
              className={`fixed z-50 pointer-events-none -translate-x-1/2 -translate-y-full mb-3 px-3.5 py-2 rounded-xl text-xs font-bold shadow-[0_20px_45px_rgba(0,0,0,0.45)] border-2 ring-2 select-none scale-105 transition-transform flex flex-col justify-between overflow-hidden min-w-[170px] max-w-[240px] ${colorClasses} ${isRedListed ? '!border-red-500 !ring-red-500/70' : ''}`}
              style={{
                left: `${touchPos.x}px`,
                top: `${touchPos.y - 12}px`,
                height: `${previewHeight}px`,
                touchAction: 'none'
              }}
            >
              <div className="flex items-center gap-2.5">
                {isBlockout ? (
                  <Ban className={`w-4 h-4 flex-shrink-0 animate-pulse ${isLight ? 'text-slate-600' : 'text-zinc-400'}`} />
                ) : (
                  <Clock className="w-4 h-4 text-[var(--color-brand-accent)] flex-shrink-0 animate-pulse" />
                )}
                <div className="flex flex-col text-left min-w-0">
                  {!isBlockout && !isBlocked && (
                    <span className="truncate max-w-[200px] text-[10px] font-extrabold uppercase tracking-wide text-[var(--color-brand-gold)]">
                      ✂️ {touchDraggedAppt.services?.name || 'Service'}
                    </span>
                  )}
                  <span className="break-words whitespace-normal leading-tight text-sm text-[var(--color-brand-light)] font-bold">
                    {isBlockout ? (touchDraggedAppt.notes || 'Blocked Time') : isBlocked ? 'BLOCKED TIME' : touchDraggedAppt.clients?.name || 'Walk-In'}
                  </span>
                  <span className={`text-[10px] font-semibold truncate ${isBlockout ? (isLight ? 'text-slate-600' : 'text-zinc-400') : 'text-[var(--color-brand-accent)]'}`}>
                    {hoveredDropSlot ? `${formatTime(hoveredDropSlot.time)} (${hoveredDropSlot.date})` : formatTime(touchDraggedAppt.start_time)}
                  </span>
                </div>
              </div>
            </div>
          )
        })()}

        {/* COMPACT STICKY HEADER */}
        <header className="sticky top-0 z-40 bg-[var(--color-brand-900)]/95 backdrop-blur-md border-b border-[var(--color-brand-700)] select-none flex-shrink-0">
          {/* Top Bar: Back Nav, Barber Pill Switcher, Theme & Quick Actions */}
          <div className="flex flex-wrap items-center justify-between px-3 sm:px-4 py-2 border-b border-[var(--color-brand-700)]/50 gap-2">
            <div className="flex items-center gap-2 sm:gap-2.5 min-w-0">
              <button
                onClick={() => setActiveModule('home')}
                title="Back to Dashboard"
                className="p-1.5 rounded-lg bg-[var(--color-brand-periwinkle)]/15 border border-[var(--color-brand-periwinkle)]/50 text-[var(--color-brand-periwinkle)] hover:bg-[var(--color-brand-periwinkle)] hover:text-white transition-all cursor-pointer flex-shrink-0"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>

              {/* Persistent Active Barber Pill Switcher */}
              <div className="flex items-center gap-1 bg-[var(--color-brand-800)] p-1 rounded-full border border-[var(--color-brand-700)] overflow-x-auto max-w-[235px] sm:max-w-none">
                {barbers.map(barber => {
                  const isActiveBarber = barber.id === selectedBarberId
                  const barberUnseenCount = unseenBookings.filter(b => b.barber_id === barber.id).length
                  return (
                    <button
                      key={barber.id}
                      type="button"
                      onClick={() => selectActiveBarber(barber.id)}
                      className={`px-2.5 sm:px-3 py-1 rounded-full text-xs font-bold whitespace-nowrap transition-all cursor-pointer inline-flex items-center gap-1 ${
                        isActiveBarber
                          ? 'bg-[var(--color-brand-accent)] text-white shadow-sm'
                          : 'text-[var(--color-brand-muted)] hover:text-[var(--color-brand-light)] hover:bg-[var(--color-brand-900)]/60'
                      }`}
                    >
                      <span>{barber.name.split(' ')[0]}</span>
                      {barberUnseenCount > 0 && (
                        <span className="inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full text-[10px] font-extrabold bg-red-600 text-white leading-none">
                          {barberUnseenCount}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
              {(() => {
                const activeBarberUnseenCount = unseenBookings.filter(b => b.barber_id === selectedBarberId).length
                return (
                  <button
                    type="button"
                    onClick={() => setShowAlertsModal(true)}
                    title="New Booking Alerts"
                    aria-label="New Booking Alerts"
                    className="relative p-1.5 rounded-lg bg-[var(--color-brand-periwinkle)]/15 border border-[var(--color-brand-periwinkle)]/50 text-[var(--color-brand-periwinkle)] hover:bg-[var(--color-brand-periwinkle)] hover:text-white transition-all cursor-pointer"
                  >
                    <Bell className="w-4 h-4" />
                    {activeBarberUnseenCount > 0 && (
                      <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[10px] font-extrabold flex items-center justify-center shadow-sm">
                        {activeBarberUnseenCount}
                      </span>
                    )}
                  </button>
                )
              })()}
              <button
                type="button"
                onClick={toggleTheme}
                title={isLight ? 'Switch to Dark Mode' : 'Switch to Light Mode (Matt Mode)'}
                className="p-1.5 rounded-lg bg-[var(--color-brand-periwinkle)]/15 border border-[var(--color-brand-periwinkle)]/50 text-[var(--color-brand-periwinkle)] hover:bg-[var(--color-brand-periwinkle)] hover:text-white transition-all cursor-pointer"
                aria-label="Toggle Light/Dark Theme"
              >
                {isLight ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
              </button>
              <button
                onClick={handleToday}
                className="px-2.5 py-1.5 rounded-lg text-xs font-bold bg-[var(--color-brand-periwinkle)]/15 border border-[var(--color-brand-periwinkle)]/50 text-[var(--color-brand-periwinkle)] hover:bg-[var(--color-brand-periwinkle)] hover:text-white transition-all cursor-pointer"
              >
                Today
              </button>
              <button
                onClick={() => setShowBarberSettingsModal(true)}
                className="flex items-center gap-1 bg-[var(--color-brand-800)] border border-[var(--color-brand-700)] hover:border-[var(--color-brand-periwinkle)] px-2.5 py-1.5 rounded-lg text-xs font-bold text-[var(--color-brand-light)] transition-colors cursor-pointer"
              >
                <SlidersHorizontal className="w-3.5 h-3.5 text-[var(--color-brand-muted)]" />
                <span className="hidden sm:inline">Manage</span>
              </button>
              <button
                onClick={() => {
                  requestOpenBookingModal(selectedDate, '')
                }}
                className="flex items-center gap-1 bg-[var(--color-brand-accent)] text-white px-3 py-1.5 rounded-lg text-xs font-bold hover:brightness-110 transition-all cursor-pointer shadow-sm"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Book</span>
              </button>
            </div>
          </div>

          {/* Sub Bar: Periwinkle Date Navigation & View Mode Segmented Switcher */}
          <div className="flex items-center justify-between px-3 sm:px-4 py-2 gap-2 bg-[var(--color-brand-900)]">
            {/* Date Nav */}
            <div className="flex items-center gap-1 sm:gap-1.5 min-w-0">
              <button
                onClick={handlePrev}
                className="p-1.5 rounded-lg bg-[var(--color-brand-periwinkle)]/15 border border-[var(--color-brand-periwinkle)]/50 text-[var(--color-brand-periwinkle)] hover:bg-[var(--color-brand-periwinkle)] hover:text-white transition-all cursor-pointer"
                title="Previous"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                onClick={handleNext}
                className="p-1.5 rounded-lg bg-[var(--color-brand-periwinkle)]/15 border border-[var(--color-brand-periwinkle)]/50 text-[var(--color-brand-periwinkle)] hover:bg-[var(--color-brand-periwinkle)] hover:text-white transition-all cursor-pointer"
                title="Next"
              >
                <ChevronRight className="w-4 h-4" />
              </button>

              <div className="relative flex items-center cursor-pointer group ml-1.5 min-w-0">
                <span className="text-xs sm:text-sm font-bold text-[var(--color-brand-light)] group-hover:text-[var(--color-brand-periwinkle)] transition-colors truncate">
                  {viewMode === 'month' && `${monthNames[viewMonthDate.getMonth()]} ${viewMonthDate.getFullYear()}`}
                  {viewMode === 'week' && `${monthNames[viewWeekStartDate.getMonth()].slice(0,3)} ${viewWeekStartDate.getDate()} – ${isSameMonth ? '' : monthNames[weekEndDate.getMonth()].slice(0,3) + ' '}${weekEndDate.getDate()}, ${viewWeekStartDate.getFullYear()}`}
                  {viewMode === 'day' && formatDisplayDate(selectedDate)}
                </span>
                <Calendar className="w-3.5 h-3.5 ml-1.5 text-[var(--color-brand-periwinkle)] flex-shrink-0" />
                <input
                  type="date"
                  value={selectedDate}
                  onChange={(e) => {
                    setSelectedDate(e.target.value)
                    setBookDate(e.target.value)
                  }}
                  className={`opacity-0 absolute inset-0 w-full h-full cursor-pointer ${isLight ? '[color-scheme:light]' : '[color-scheme:dark]'}`}
                />
              </div>
              {viewMode === 'day' && isNonWorkingDate(selectedDate, dayViewOverride ? [dayViewOverride] : []) && (
                <span
                  className={`ml-1.5 px-2 py-0.5 rounded-full text-[10px] sm:text-xs font-bold border flex-shrink-0 ${
                    isLight
                      ? 'text-[#991B1B] bg-[#E6CCD2] border-[#B91C1C]/40'
                      : 'text-red-300 bg-red-950/70 border-red-800/70'
                  }`}
                >
                  Scheduled Day Off
                </span>
              )}
            </div>

            {/* Segmented View Mode Toggle (Vivid Periwinkle) */}
            <div className="bg-[var(--color-brand-800)] p-0.5 rounded-lg border border-[var(--color-brand-periwinkle)]/40 flex items-center flex-shrink-0 gap-0.5">
              <button
                onClick={() => setViewMode('month')}
                className={`px-2.5 sm:px-3 py-1 rounded-md text-xs font-bold transition-all cursor-pointer ${
                  viewMode === 'month'
                    ? 'bg-[var(--color-brand-periwinkle)] text-white shadow-sm'
                    : 'text-[var(--color-brand-periwinkle)] hover:bg-[var(--color-brand-periwinkle)]/15'
                }`}
              >
                Month
              </button>
              <button
                onClick={() => setViewMode('week')}
                className={`px-2.5 sm:px-3 py-1 rounded-md text-xs font-bold transition-all cursor-pointer ${
                  viewMode === 'week'
                    ? 'bg-[var(--color-brand-periwinkle)] text-white shadow-sm'
                    : 'text-[var(--color-brand-periwinkle)] hover:bg-[var(--color-brand-periwinkle)]/15'
                }`}
              >
                Week
              </button>
              <button
                onClick={() => setViewMode('day')}
                className={`px-2.5 sm:px-3 py-1 rounded-md text-xs font-bold transition-all cursor-pointer ${
                  viewMode === 'day'
                    ? 'bg-[var(--color-brand-periwinkle)] text-white shadow-sm'
                    : 'text-[var(--color-brand-periwinkle)] hover:bg-[var(--color-brand-periwinkle)]/15'
                }`}
              >
                Day
              </button>
            </div>
          </div>
        </header>

        {statusBanner && (
          <div className="bg-[var(--color-brand-800)] border-b border-emerald-500/60 px-4 py-2.5 flex items-center justify-between gap-3 z-30 flex-shrink-0 shadow-sm">
            <div className="flex items-center gap-2 text-xs sm:text-sm text-[var(--color-brand-light)] font-semibold">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
              <span>{statusBanner.message}</span>
            </div>
            <button
              type="button"
              onClick={() => setStatusBanner(null)}
              className="text-[var(--color-brand-muted)] hover:text-[var(--color-brand-light)] cursor-pointer flex-shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* CALENDAR MAIN BODY (w-full flex-1 edge-to-edge) */}
        <main className="w-full flex-1 overflow-hidden flex flex-col relative">
          {/* DAY VIEW */}
          {viewMode === 'day' && (() => {
            const isDayNonWorking = isNonWorkingDate(selectedDate, dayViewOverride ? [dayViewOverride] : [])
            return (
              <div
                ref={(el) => {
                  dayScrollContainerRef.current = el
                  scrollContainerRef.current = el
                }}
                className={`flex-1 w-full overflow-y-auto overflow-x-hidden relative flex flex-col transition-all duration-180 ease-out will-change-transform ${
                  calendarSwipeAnim === 'left'
                    ? 'translate-x-4 opacity-75'
                    : calendarSwipeAnim === 'right'
                    ? '-translate-x-4 opacity-75'
                    : 'translate-x-0 opacity-100'
                }`}
              >
                {isDayNonWorking && (
                  <div className={`border-b px-4 py-1.5 text-xs font-semibold flex items-center justify-between z-30 flex-shrink-0 ${
                    isLight ? 'bg-[#E6CCD2] border-[#B91C1C]/40 text-[#7F1D1D]' : 'bg-red-950/80 border-red-800 text-red-200'
                  }`}>
                    <span>Scheduled Day Off — empty slots remain open if you pick up an extra shift.</span>
                    <button onClick={() => setShowManageDayModal(true)} className="underline cursor-pointer font-bold ml-2">Manage Day</button>
                  </div>
                )}
                <div className="flex flex-1 min-w-full">
                  {renderYAxis()}
                  {loadingAppts ? (
                    <div className="flex-1 p-8 text-[var(--color-brand-muted)] flex items-center justify-center animate-pulse">
                      Loading lineup...
                    </div>
                  ) : (
                    renderTimeGrid(selectedDate, appointments, isDayNonWorking, false)
                  )}
                </div>
              </div>
            )
          })()}

          {/* WEEK VIEW */}
          {viewMode === 'week' && (
            <div
              className={`flex-1 w-full flex flex-col overflow-hidden transition-all duration-180 ease-out will-change-transform ${
                calendarSwipeAnim === 'left'
                  ? 'translate-x-4 opacity-75'
                  : calendarSwipeAnim === 'right'
                  ? '-translate-x-4 opacity-75'
                  : 'translate-x-0 opacity-100'
              }`}
            >
              {/* Sticky Day Column Headers */}
              <div className="flex bg-[var(--color-brand-800)] border-b border-[var(--color-brand-700)] select-none flex-shrink-0 w-full">
                <div className="w-12 sm:w-14 flex-shrink-0 border-r border-[var(--color-brand-700)] bg-[var(--color-brand-900)]" />
                <div className="flex-1 grid grid-cols-7 w-full min-w-0">
                  {Array.from({ length: 7 }).map((_, i) => {
                    const d = new Date(viewWeekStartDate)
                    d.setDate(d.getDate() + i)
                    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
                    const isToday = dateStr === todayStr
                    const isSelected = dateStr === selectedDate
                    const isOff = isNonWorkingDate(dateStr, weekOverrides)
                    return (
                      <button
                        key={dateStr}
                        onClick={() => handleDayClick(dateStr)}
                        title={`Zoom into ${dateStr}`}
                        style={
                          isOff
                            ? {
                                backgroundColor: isLight ? 'rgba(23, 15, 46, 0.08)' : '#050308',
                                backgroundImage: isLight
                                  ? 'repeating-linear-gradient(45deg, transparent, transparent 8px, rgba(23, 15, 46, 0.05) 8px, rgba(23, 15, 46, 0.05) 16px)'
                                  : 'repeating-linear-gradient(-45deg, rgba(255, 255, 255, 0.045) 0px, rgba(255, 255, 255, 0.045) 4px, transparent 4px, transparent 10px)'
                              }
                            : undefined
                        }
                        className={`px-0.5 py-1.5 sm:p-2 text-center border-r border-[var(--color-brand-700)]/60 hover:bg-[var(--color-brand-accent)]/15 transition-colors cursor-pointer group min-w-0 overflow-hidden relative ${
                          isToday ? 'bg-[var(--color-brand-accent)]/10' : ''
                        } ${isOff ? (isLight ? 'opacity-75' : 'text-[var(--color-brand-muted)]/70') : ''}`}
                      >
                        <div className="flex items-center justify-center gap-1 min-w-0">
                          <span className={`text-[9px] sm:text-[10px] uppercase font-bold tracking-tight truncate ${
                            isToday ? 'text-[var(--color-brand-accent)]' : 'text-[var(--color-brand-muted)] group-hover:text-[var(--color-brand-light)]'
                          }`}>
                            {dayNamesShort[d.getDay()]}
                          </span>
                          {isOff && (
                            <span className={`text-[8px] font-bold px-1 rounded border leading-tight ${
                              isLight ? 'text-[#991B1B] bg-[#E6CCD2] border-[#B91C1C]/40' : 'text-red-300 bg-red-950/85 border-red-700/80'
                            }`}>
                              OFF
                            </span>
                          )}
                        </div>
                        <div className={`text-xs sm:text-base font-bold truncate ${
                          isToday ? 'text-[var(--color-brand-accent)]' : isSelected ? 'text-[var(--color-brand-light)] underline' : (isOff && !isLight ? 'text-[var(--color-brand-muted)]/60' : 'text-[var(--color-brand-light)]')
                        }`}>
                          {d.getDate()}
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Scrollable Week Grid */}
              <div
                ref={(el) => {
                  weekScrollContainerRef.current = el
                  scrollContainerRef.current = el
                }}
                className="flex-1 w-full overflow-y-auto overflow-x-auto relative flex"
              >
                <div className="flex w-full flex-1 min-w-0">
                  {renderYAxis()}
                  <div className="grid grid-cols-7 flex-1 w-full min-w-0">
                    {Array.from({ length: 7 }).map((_, i) => {
                      const d = new Date(viewWeekStartDate)
                      d.setDate(d.getDate() + i)
                      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
                      const dayAppts = weekAppointments.filter(a => a.appointment_date === dateStr)
                      const isOff = isNonWorkingDate(dateStr, weekOverrides)
                      return (
                        <div key={dateStr} className="relative min-w-0 sm:min-w-[145px] w-full">
                          {renderTimeGrid(dateStr, dayAppts, isOff, true)}
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* MONTH VIEW */}
          {viewMode === 'month' && (
            <div
              className={`flex-1 w-full flex flex-col overflow-hidden transition-all duration-180 ease-out will-change-transform ${
                calendarSwipeAnim === 'left'
                  ? 'translate-x-4 opacity-75'
                  : calendarSwipeAnim === 'right'
                  ? '-translate-x-4 opacity-75'
                  : 'translate-x-0 opacity-100'
              }`}
            >
              {/* Day of Week Headers */}
              <div className="grid grid-cols-7 border-b border-[var(--color-brand-700)] bg-[var(--color-brand-800)] py-2 select-none flex-shrink-0">
                {dayNamesShort.map(day => (
                  <div key={day} className="text-center text-[10px] sm:text-xs font-bold text-[var(--color-brand-muted)] uppercase tracking-wider">
                    {day}
                  </div>
                ))}
              </div>

              {/* Month Matrix Grid */}
              <div className="flex-1 grid grid-cols-7 auto-rows-fr gap-px bg-[var(--color-brand-700)]/40 overflow-y-auto">
                {monthMatrix.map((date, index) => {
                  if (!date) {
                    return <div key={`empty-${index}`} className="bg-[var(--color-brand-900)]/40 min-h-[90px] sm:min-h-[110px]" />
                  }

                  const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
                  const isToday = dateStr === todayStr
                  const dayAppts = monthAppointments.filter(a => a.appointment_date === dateStr)
                  const isOff = isNonWorkingDate(dateStr, monthOverrides)

                  return (
                    <button
                      key={dateStr}
                      onClick={() => handleDayClick(dateStr)}
                      style={
                        isOff
                          ? {
                              backgroundColor: isLight ? 'rgba(23, 15, 46, 0.08)' : '#050308',
                              backgroundImage: isLight
                                ? 'repeating-linear-gradient(45deg, transparent, transparent 10px, rgba(23, 15, 46, 0.05) 10px, rgba(23, 15, 46, 0.05) 20px)'
                                : 'repeating-linear-gradient(-45deg, rgba(255, 255, 255, 0.045) 0px, rgba(255, 255, 255, 0.045) 4px, transparent 4px, transparent 10px)'
                            }
                          : undefined
                      }
                      className={`${
                        isLight
                          ? 'bg-[var(--color-brand-900)] hover:bg-[var(--color-brand-800)]/70'
                          : isOff
                          ? 'bg-[#050308] hover:bg-[#120924]'
                          : 'bg-[#170C2E] hover:bg-[var(--color-brand-800)]/90'
                      } transition-colors p-1.5 sm:p-2 min-h-[90px] sm:min-h-[110px] flex flex-col items-start text-left relative group cursor-pointer overflow-hidden ${
                        isToday ? 'ring-1 ring-inset ring-[var(--color-brand-accent)]' : ''
                      } ${isOff && isLight ? 'opacity-70' : ''}`}
                    >
                      {/* Date Header */}
                      <div className="w-full flex items-center justify-between">
                        <span className={`text-xs sm:text-sm font-bold flex items-center justify-center w-6 h-6 rounded-full ${
                          isToday
                            ? 'bg-[var(--color-brand-accent)] text-white shadow-sm'
                            : isOff && !isLight
                            ? 'text-[var(--color-brand-muted)]/60 group-hover:text-[var(--color-brand-light)]'
                            : 'text-[var(--color-brand-light)] group-hover:text-[var(--color-brand-accent)]'
                        }`}>
                          {date.getDate()}
                        </span>
                        {isOff && (
                          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${
                            isLight ? 'text-[#991B1B] bg-[#E6CCD2] border-[#B91C1C]/40' : 'text-red-300 bg-red-950/85 border-red-700/80 shadow-sm'
                          }`}>
                            OFF
                          </span>
                        )}
                        {!isOff && dayAppts.length > 0 && (
                          <span className="text-[10px] font-bold text-[var(--color-brand-accent)] hidden sm:inline">
                            {dayAppts.length} {dayAppts.length === 1 ? 'appt' : 'appts'}
                          </span>
                        )}
                      </div>

                      {/* Appointment Chips inside Day Square */}
                      {dayAppts.length > 0 && (
                        <div className="w-full space-y-1 overflow-hidden mt-1 flex-1">
                          {dayAppts.slice(0, 3).map(appt => {
                            const isBlockout = Boolean(appt.is_blockout)
                            const isBlocked = appt.status === 'blocked' || isBlockout
                            const isCompleted = appt.status === 'completed'
                            const isRedListed = !isBlockout && !isBlocked && Boolean(appt.clients?.is_red_listed)
                            const redListedOwedBy = (appt.clients?.red_listed_by || 'BARBER').toUpperCase()
                            const chipBg = isBlockout
                              ? (isLight ? 'bg-[#C4BBE0] border-[#8273AD] text-[#170F2E]' : 'bg-zinc-800 border-zinc-600 text-zinc-300')
                              : isBlocked
                              ? (isLight ? 'bg-[#E5D2C4] border-[#C26A2B] text-[#431407]' : 'bg-orange-950/80 border-orange-700/60 text-orange-200')
                              : isCompleted
                              ? (isLight ? 'bg-[#C7DEC9] border-[#2E7D4F] text-[#052E16]' : 'bg-emerald-950/80 border-emerald-700/60 text-emerald-200')
                              : 'bg-[var(--color-brand-800)] border-[var(--color-brand-700)] text-[var(--color-brand-light)] group-hover:border-[var(--color-brand-accent)]/50'

                            return (
                              <div
                                key={appt.id}
                                data-appt-card="true"
                                className={`text-[10px] truncate px-1.5 py-0.5 rounded border font-medium flex items-center gap-1 ${chipBg} ${isRedListed ? '!border-red-500 ring-1 ring-red-500/60' : ''}`}
                              >
                                <span className={`${isBlockout ? (isLight ? 'text-slate-600' : 'text-zinc-400') : 'text-[var(--color-brand-accent)]'} font-bold text-[9px] flex-shrink-0`}>
                                  {formatTime(appt.start_time).replace(':00', '')}
                                </span>
                                {isRedListed && (
                                  <span className="bg-red-600 text-white text-[8px] font-extrabold px-1 rounded flex-shrink-0">
                                    🚩 RED LIST • OWES {redListedOwedBy}
                                  </span>
                                )}
                                <span className="truncate">
                                  {isBlockout ? (appt.notes || 'Blocked') : isBlocked ? 'Blocked' : appt.clients?.name || 'Walk-In'}
                                </span>
                              </div>
                            )
                          })}
                          {dayAppts.length > 3 && (
                            <div className="text-[10px] text-[var(--color-brand-accent)] font-bold pl-1 leading-none">
                              +{dayAppts.length - 3} more
                            </div>
                          )}
                        </div>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </main>

        {/* MODALS */}
        {renderModals()}
      </div>
    )
  }

  // PROTECTED DASHBOARD RENDER
  return (
    <div className="min-h-screen bg-[var(--color-brand-900)] text-[var(--color-brand-light)] p-4 md:p-8 font-sans relative">
      <div className="max-w-4xl mx-auto">
        <header className="flex flex-col gap-4 mb-8 border-b border-[var(--color-brand-700)] pb-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-full bg-[var(--color-brand-800)] border border-[#D4AF37]/60 shadow-[0_0_10px_rgba(212,175,55,0.2)] flex-shrink-0">
                <Shield className="text-[var(--color-brand-gold)] w-6 h-6" />
              </div>
              <div>
                <h1 className="text-2xl font-bold">Barber Portal</h1>
                <p className="text-xs sm:text-sm text-[var(--color-brand-muted)] flex items-center gap-1.5 mt-0.5">
                  <span>Active Chair:</span>
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold border border-[#D4AF37]/60 bg-[#D4AF37]/10 text-[var(--color-brand-gold)]">
                    {barbers.find(b => b.id === selectedBarberId)?.name || 'Shop Staff'}
                  </span>
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              {(() => {
                const activeBarberUnseenCount = unseenBookings.filter(b => b.barber_id === selectedBarberId).length
                return (
                  <button
                    type="button"
                    onClick={() => setShowAlertsModal(true)}
                    title="New Booking Alerts"
                    aria-label="New Booking Alerts"
                    className="relative flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs sm:text-sm font-bold border border-[var(--color-brand-periwinkle)]/60 bg-[var(--color-brand-periwinkle)]/15 text-[var(--color-brand-periwinkle)] hover:bg-[var(--color-brand-periwinkle)] hover:text-white transition-all cursor-pointer"
                  >
                    <Bell className="w-4 h-4" />
                    <span className="hidden sm:inline">Alerts</span>
                    {activeBarberUnseenCount > 0 && (
                      <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[10px] font-extrabold flex items-center justify-center leading-none">
                        {activeBarberUnseenCount}
                      </span>
                    )}
                  </button>
                )
              })()}

              <button
                type="button"
                onClick={toggleTheme}
                title={isLight ? 'Switch to Dark Mode' : 'Switch to Light Mode (Matt Mode)'}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs sm:text-sm font-bold border border-[var(--color-brand-periwinkle)]/60 bg-[var(--color-brand-periwinkle)]/15 text-[var(--color-brand-periwinkle)] hover:bg-[var(--color-brand-periwinkle)] hover:text-white transition-all cursor-pointer"
                aria-label="Toggle Light/Dark Theme"
              >
                {isLight ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
                <span className="hidden sm:inline">{isLight ? 'Dark' : 'Light'}</span>
              </button>

              <Link
                to="/"
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs sm:text-sm font-bold border border-[var(--color-brand-periwinkle)]/60 bg-[var(--color-brand-periwinkle)]/15 text-[var(--color-brand-periwinkle)] hover:bg-[var(--color-brand-periwinkle)] hover:text-white transition-all"
              >
                <ExternalLink className="w-4 h-4" />
                <span>View Live Shop</span>
              </Link>

              <button
                onClick={handleLogout}
                className="flex items-center gap-2 bg-[var(--color-brand-800)] border border-[var(--color-brand-700)] hover:border-[var(--color-brand-periwinkle)] px-3.5 py-2 rounded-lg text-xs sm:text-sm font-medium transition-colors cursor-pointer"
              >
                <LogOut className="w-4 h-4" /> Sign Out
              </button>
            </div>
          </div>

          {/* Persistent Active Barber Pill Switcher (Michael • Matt • Flor) */}
          {barbers.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-brand-muted)] mr-1">
                Active Barber:
              </span>
              <div className="inline-flex flex-wrap items-center gap-1.5 bg-[var(--color-brand-800)] p-1 rounded-full border border-[#D4AF37]/40">
                {barbers.map(barber => {
                  const isActiveBarber = barber.id === selectedBarberId
                  const barberUnseenCount = unseenBookings.filter(b => b.barber_id === barber.id).length
                  return (
                    <button
                      key={barber.id}
                      type="button"
                      onClick={() => selectActiveBarber(barber.id)}
                      className={`px-3.5 py-1.5 rounded-full text-xs font-bold transition-all cursor-pointer inline-flex items-center gap-1.5 ${
                        isActiveBarber
                          ? 'bg-[var(--color-brand-accent)] text-white shadow-sm ring-1 ring-[#D4AF37]/70'
                          : 'text-[var(--color-brand-muted)] hover:text-[var(--color-brand-light)] hover:bg-[var(--color-brand-900)]/60'
                      }`}
                    >
                      <span>{barber.name}</span>
                      {barberUnseenCount > 0 && (
                        <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-extrabold bg-red-600 text-white leading-none">
                          {barberUnseenCount}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </header>

        {statusBanner && (
          <div className="mb-6 bg-[var(--color-brand-800)] border border-emerald-500/60 rounded-xl p-3.5 flex items-center justify-between gap-3 shadow-md">
            <div className="flex items-center gap-2.5 text-xs sm:text-sm text-[var(--color-brand-light)] font-semibold">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
              <span>{statusBanner.message}</span>
            </div>
            <button
              type="button"
              onClick={() => setStatusBanner(null)}
              className="text-[var(--color-brand-muted)] hover:text-[var(--color-brand-light)] cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* --- MAIN MODULE NAVIGATION --- */}
        {activeModule === 'home' && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            <button onClick={() => setActiveModule('calendar')} className="card-violet-gold p-6 rounded-xl transition-all text-left group cursor-pointer">
              <div className="w-10 h-10 rounded-full bg-[var(--color-brand-900)] border border-[#D4AF37]/60 shadow-[0_0_10px_rgba(212,175,55,0.2)] flex items-center justify-center mb-3">
                <Calendar className="w-5 h-5 text-[var(--color-brand-gold)]" />
              </div>
              <h3 className="text-lg font-bold mb-1 group-hover:text-[var(--color-brand-accent)]">Live Calendar</h3>
              <p className="text-xs text-[var(--color-brand-muted)]">Manage daily lineup</p>
            </button>
            <button onClick={() => setActiveModule('walkin')} className="card-violet-gold p-6 rounded-xl transition-all text-left group cursor-pointer">
              <div className="w-10 h-10 rounded-full bg-[var(--color-brand-900)] border border-[#D4AF37]/60 shadow-[0_0_10px_rgba(212,175,55,0.2)] flex items-center justify-center mb-3">
                <Zap className="w-5 h-5 text-orange-500" />
              </div>
              <h3 className="text-lg font-bold mb-1 group-hover:text-orange-500">Express Walk-In</h3>
              <p className="text-xs text-[var(--color-brand-muted)]">1-Tap shop lockdown</p>
            </button>
            <button onClick={() => setActiveModule('clients')} className="card-violet-gold p-6 rounded-xl transition-all text-left group cursor-pointer">
              <div className="w-10 h-10 rounded-full bg-[var(--color-brand-900)] border border-[#D4AF37]/60 shadow-[0_0_10px_rgba(212,175,55,0.2)] flex items-center justify-center mb-3">
                <Users className="w-5 h-5 text-[var(--color-brand-gold)]" />
              </div>
              <h3 className="text-lg font-bold mb-1 group-hover:text-[var(--color-brand-accent)]">Clients</h3>
              <p className="text-xs text-[var(--color-brand-muted)]">Cut notes & history</p>
            </button>
            <button onClick={() => setActiveModule('services')} className="card-violet-gold p-6 rounded-xl transition-all text-left group cursor-pointer">
              <div className="w-10 h-10 rounded-full bg-[var(--color-brand-900)] border border-[#D4AF37]/60 shadow-[0_0_10px_rgba(212,175,55,0.2)] flex items-center justify-center mb-3">
                <Settings className="w-5 h-5 text-[var(--color-brand-gold)]" />
              </div>
              <h3 className="text-lg font-bold mb-1 group-hover:text-[var(--color-brand-accent)]">My Services</h3>
              <p className="text-xs text-[var(--color-brand-muted)]">Prices & durations</p>
            </button>
          </div>
        )}

        {/* --- 2. EXPRESS WALK-IN UI --- */}
        {activeModule === 'walkin' && (
          <div className="bg-[var(--color-brand-800)] border border-orange-500/30 rounded-2xl p-6 shadow-[0_0_40px_rgba(249,115,22,0.1)] animate-in fade-in max-w-2xl mx-auto">
            <div className="flex items-center gap-3 mb-8">
              <button onClick={() => setActiveModule('home')} className="p-2 rounded-full bg-[var(--color-brand-periwinkle)]/15 border border-[var(--color-brand-periwinkle)]/50 text-[var(--color-brand-periwinkle)] hover:bg-[var(--color-brand-periwinkle)] hover:text-white transition-all cursor-pointer">
                <ArrowLeft className="w-5 h-5" />
              </button>
              <div>
                <h2 className="text-xl font-bold flex items-center gap-2 text-orange-500"><Zap className="w-5 h-5" /> Express Walk-In</h2>
                <p className="text-sm text-[var(--color-brand-muted)]">Select a service, tap an open time, and instantly lock the chair.</p>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-4 mb-8">
              <select value={walkInBarberId} onChange={(e) => setWalkInBarberId(e.target.value)} className="w-full sm:w-1/3 bg-[var(--color-brand-900)] text-[var(--color-brand-light)] border border-[var(--color-brand-700)] rounded-xl p-4 outline-none appearance-none cursor-pointer font-bold">
                <option value="any">All Available Barbers</option>
                {barbers.map(barber => <option key={barber.id} value={barber.id}>{barber.name}</option>)}
              </select>

              <input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} className={`w-full sm:w-1/3 bg-[var(--color-brand-900)] text-[var(--color-brand-light)] border border-[var(--color-brand-700)] rounded-xl p-4 outline-none ${isLight ? '[color-scheme:light]' : '[color-scheme:dark]'} cursor-pointer font-bold`} />

              <select value={walkInService?.id || ''} onChange={(e) => setWalkInService(adminServices.find(s => s.id === e.target.value))} className="w-full sm:w-1/3 bg-[var(--color-brand-900)] border border-orange-500/50 rounded-xl p-4 outline-none appearance-none cursor-pointer font-bold text-orange-500">
                <option value="" disabled>Select Service...</option>
                {adminServices.map(s => <option key={s.id} value={s.id}>{s.name} ({s.duration_minutes}m)</option>)}
              </select>
            </div>

            {walkInService && (
              <div className="animate-in slide-in-from-bottom-4 duration-300">
                <label className="block text-xs font-bold text-orange-500 uppercase tracking-wider mb-3">Available Slots (Tap to Instantly Block)</label>
                {walkInSlots.length === 0 ? (
                   <div className="text-center bg-[var(--color-brand-900)] p-8 rounded-xl border border-[var(--color-brand-700)]">No availability found for this service today.</div>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {walkInSlots.map(slot => (
                      <button
                        key={`${slot.time}-${slot.barberId}`}
                        disabled={isExpressBooking}
                        onClick={() => handleExpressWalkIn(slot.time, slot.barberId)}
                        className="bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] p-3 rounded-xl hover:bg-orange-600 hover:border-orange-500 hover:text-white transition-all cursor-pointer disabled:opacity-50 flex flex-col items-center justify-center gap-1 shadow-sm"
                      >
                        <span className="text-lg font-bold">{formatTime(slot.time)}</span>
                        {walkInBarberId === 'any' && (
                          <span className="text-xs font-semibold opacity-70 uppercase tracking-wider">{slot.barberName}</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* --- 3. MY SERVICES UI --- */}
        {activeModule === 'services' && (
          <div className="bg-[var(--color-brand-800)] border border-[var(--color-brand-700)] rounded-2xl p-4 md:p-6 shadow-xl animate-in fade-in">
            <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4 mb-6">
              <div className="flex items-center gap-3">
                <button onClick={() => setActiveModule('home')} className="p-2 rounded-full bg-[var(--color-brand-periwinkle)]/15 border border-[var(--color-brand-periwinkle)]/50 text-[var(--color-brand-periwinkle)] hover:bg-[var(--color-brand-periwinkle)] hover:text-white transition-all cursor-pointer">
                  <ArrowLeft className="w-5 h-5" />
                </button>
                <div>
                  <h2 className="text-xl font-bold">My Services</h2>
                  <p className="text-sm text-[var(--color-brand-muted)]">Manage your personal service menu.</p>
                </div>
              </div>
              <select value={selectedBarberId} onChange={(e) => selectActiveBarber(e.target.value)} className="bg-[var(--color-brand-900)] text-[var(--color-brand-light)] border border-[var(--color-brand-700)] rounded-lg p-3 outline-none cursor-pointer font-semibold appearance-none">
                {barbers.map(barber => <option key={barber.id} value={barber.id}>{barber.name}'s Menu</option>)}
              </select>
            </div>

            {isOwner && (
              <div className="mb-8 p-4 border border-[var(--color-brand-accent)] bg-[var(--color-brand-accent)]/10 rounded-xl">
                <h3 className="text-sm font-bold text-[var(--color-brand-accent)] mb-3">Shop Owner Controls: Master Menu</h3>
                <form onSubmit={handleAddMasterService} className="flex flex-col sm:flex-row gap-3">
                  <input type="text" required placeholder="Inject a new global service (e.g. Mullet Fade)..." value={newMasterName} onChange={(e) => setNewMasterName(e.target.value)} className="flex-grow bg-[var(--color-brand-900)] text-[var(--color-brand-light)] border border-[var(--color-brand-700)] rounded-lg p-3 outline-none focus:border-[var(--color-brand-accent)]" />
                  <button type="submit" className="bg-[var(--color-brand-accent)] text-white font-bold p-3 rounded-lg hover:brightness-110 transition-all cursor-pointer whitespace-nowrap">Add to Global List</button>
                </form>
              </div>
            )}

            <form onSubmit={handleAddService} className="bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] p-4 rounded-xl mb-8 flex flex-col md:flex-row gap-4 items-end">
              <div className="w-full md:w-2/5">
                <label className="block text-xs font-bold text-[var(--color-brand-muted)] uppercase tracking-wider mb-2">Select Official Service</label>
                <select required value={newServiceName} onChange={(e) => setNewServiceName(e.target.value)} className="w-full bg-[var(--color-brand-800)] text-[var(--color-brand-light)] border border-[var(--color-brand-700)] rounded-lg p-3 outline-none focus:border-[var(--color-brand-accent)] appearance-none cursor-pointer">
                  <option value="" disabled>Select Service...</option>
                  {masterServices.map(name => <option key={name} value={name}>{name}</option>)}
                </select>
              </div>
              <div className="w-full md:w-1/5">
                <label className="block text-xs font-bold text-[var(--color-brand-muted)] uppercase tracking-wider mb-2">Mins</label>
                <select value={newServiceDuration} onChange={(e) => setNewServiceDuration(e.target.value)} className="w-full bg-[var(--color-brand-800)] text-[var(--color-brand-light)] border border-[var(--color-brand-700)] rounded-lg p-3 outline-none focus:border-[var(--color-brand-accent)] appearance-none cursor-pointer">
                  {[15, 30, 45, 60, 75, 90, 105, 120].map(mins => <option key={mins} value={mins}>{mins}</option>)}
                </select>
              </div>
              <div className="w-full md:w-1/5">
                <label className="block text-xs font-bold text-[var(--color-brand-muted)] uppercase tracking-wider mb-2">Price ($)</label>
                <input type="number" required placeholder="40" value={newServicePrice} onChange={(e) => setNewServicePrice(e.target.value)} className="w-full bg-[var(--color-brand-800)] text-[var(--color-brand-light)] border border-[var(--color-brand-700)] rounded-lg p-3 outline-none focus:border-[var(--color-brand-accent)]" />
              </div>
              <div className="w-full md:w-1/5">
                <button type="submit" disabled={isSubmittingService || !newServiceName} className="w-full bg-[var(--color-brand-accent)] text-white font-bold p-3 rounded-lg hover:brightness-110 transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50">
                  <Plus className="w-5 h-5" /> Add
                </button>
              </div>
            </form>

            <div className="space-y-3">
              {myServices.filter(s => s.is_active !== false).length === 0 ? (
                 <div className="text-center py-8 text-[var(--color-brand-muted)] border border-dashed border-[var(--color-brand-700)] rounded-xl">No services found. Add your first service above.</div>
              ) : (
                myServices.filter(s => s.is_active !== false).map(service => (
                  <div key={service.id} className="card-violet-gold p-4 rounded-xl transition-all">

                    {editingServiceId === service.id ? (
                      <div className="flex flex-col sm:flex-row items-center gap-3">
                        <select value={editForm.name} onChange={(e) => setEditForm({...editForm, name: e.target.value})} className="w-full sm:w-1/2 bg-[var(--color-brand-800)] border border-[var(--color-brand-700)] p-2 rounded outline-none cursor-pointer appearance-none">
                          {masterServices.map(name => <option key={name} value={name}>{name}</option>)}
                        </select>
                        <select value={editForm.duration} onChange={(e) => setEditForm({...editForm, duration: e.target.value})} className="w-full sm:w-1/4 bg-[var(--color-brand-800)] border border-[var(--color-brand-700)] p-2 rounded outline-none cursor-pointer appearance-none">
                          {[15, 30, 45, 60, 75, 90, 105, 120].map(mins => <option key={mins} value={mins}>{mins}m</option>)}
                        </select>
                        <input type="number" value={editForm.price} onChange={(e) => setEditForm({...editForm, price: e.target.value})} className="w-full sm:w-1/4 bg-[var(--color-brand-800)] border border-[var(--color-brand-700)] p-2 rounded outline-none" />
                        <div className="flex gap-2 w-full sm:w-auto">
                          <button onClick={() => handleSaveEdit(service.id)} className="bg-[var(--color-brand-accent)] text-white p-2 rounded hover:brightness-110 flex-1 sm:flex-none cursor-pointer"><Save className="w-5 h-5 mx-auto" /></button>
                          <button onClick={() => setEditingServiceId(null)} className="bg-[var(--color-brand-700)] text-white p-2 rounded hover:bg-[var(--color-brand-muted)] flex-1 sm:flex-none cursor-pointer"><X className="w-5 h-5 mx-auto" /></button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-4">
                          <div className="p-3 rounded-full border bg-[var(--color-brand-900)] border-[#D4AF37]/60 text-[var(--color-brand-gold)]">
                            <Scissors className="w-5 h-5" />
                          </div>
                          <div>
                            <h3 className="font-bold text-lg">{service.name}</h3>
                            <p className="text-sm text-[var(--color-brand-muted)]">{service.duration_minutes} mins • ${service.price}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setEditForm({ name: service.name, duration: service.duration_minutes.toString(), price: service.price.toString() })
                              setEditingServiceId(service.id)
                            }}
                            className="p-3 bg-[var(--color-brand-800)] rounded-lg hover:text-[var(--color-brand-accent)] transition-colors cursor-pointer"
                          >
                            <Edit className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (confirmDeleteServiceId === service.id) {
                                handleDeleteService(service.id)
                              } else {
                                setConfirmDeleteServiceId(service.id)
                              }
                            }}
                            className={`p-3 rounded-lg flex items-center gap-2 text-sm font-bold border transition-all cursor-pointer ${
                              confirmDeleteServiceId === service.id
                                ? 'bg-red-600 text-white border-red-500 shadow-md'
                                : 'bg-[var(--color-brand-800)] border-[var(--color-brand-700)] hover:bg-red-900/20 hover:border-red-500/60 hover:text-red-400'
                            }`}
                          >
                            <Trash2 className="w-4 h-4" />
                            <span>{confirmDeleteServiceId === service.id ? 'Confirm?' : 'Delete'}</span>
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* --- 4. CLIENT DIRECTORY CRM & VAGARO CSV IMPORTER --- */}
        {activeModule === 'clients' && (() => {
          const q = clientSearch.trim().toLowerCase()
          const qDigits = cleanPhone(clientSearch)
          const redListedCount = clientsList.filter(c => Boolean(c.is_red_listed)).length

          const filteredClients = clientsList.filter((client) => {
            if (showRedListedOnly && !client.is_red_listed) return false
            if (!q) return true
            const nameMatch = (client.name || '').toLowerCase().includes(q)
            const rawPhone = cleanPhone(client.phone || '')
            const fmtPhone = formatPhoneNumber(client.phone || '').toLowerCase()
            const phoneMatch = fmtPhone.includes(q) || (qDigits.length > 0 && rawPhone.includes(qDigits))
            const notesMatch = (client.notes || '').toLowerCase().includes(q)
            return nameMatch || phoneMatch || notesMatch
          })

          const displayedClients = filteredClients.slice(0, visibleClientCount)

          return (
            <div className="bg-[var(--color-brand-800)] border border-[var(--color-brand-700)] rounded-2xl p-4 sm:p-6 shadow-xl animate-in fade-in space-y-6">
              {/* Hidden CSV File Input */}
              <input
                ref={csvFileInputRef}
                type="file"
                accept=".csv"
                onChange={handleVagaroCSVUpload}
                className="hidden"
              />

              {/* Top Header & Actions */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setActiveModule('home')}
                    className="p-2 rounded-full bg-[var(--color-brand-periwinkle)]/15 border border-[var(--color-brand-periwinkle)]/50 text-[var(--color-brand-periwinkle)] hover:bg-[var(--color-brand-periwinkle)] hover:text-white transition-all cursor-pointer"
                  >
                    <ArrowLeft className="w-5 h-5" />
                  </button>
                  <div>
                    <div className="flex items-center gap-2.5">
                      <h2 className="text-xl font-bold">Client Directory</h2>
                      <span className="text-xs font-bold bg-[var(--color-brand-900)] border border-[#D4AF37]/60 text-[var(--color-brand-gold)] px-2.5 py-0.5 rounded-full">
                        {clientsList.length}
                      </span>
                    </div>
                    <p className="text-sm text-[var(--color-brand-muted)]">
                      Persistent cut notes, appointment history & Vagaro CRM sync
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2.5">
                  <button
                    type="button"
                    disabled={isImportingCSV}
                    onClick={() => csvFileInputRef.current?.click()}
                    className="flex-1 sm:flex-none flex items-center justify-center gap-2 bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] hover:border-[var(--color-brand-accent)] text-[var(--color-brand-light)] px-4 py-2.5 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer disabled:opacity-50"
                  >
                    <Upload className="w-4 h-4 text-[var(--color-brand-accent)]" />
                    <span>{isImportingCSV ? 'Importing CSV...' : 'Import Vagaro CSV'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleExportBackupCSV}
                    disabled={clientsList.length === 0}
                    className="flex-1 sm:flex-none flex items-center justify-center gap-2 bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] hover:border-[var(--color-brand-gold)] text-[var(--color-brand-light)] px-4 py-2.5 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer disabled:opacity-50"
                  >
                    <Download className="w-4 h-4 text-[var(--color-brand-gold)]" />
                    <span>Export Backup CSV</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setShowAddClientModal(true)}
                    className="flex-1 sm:flex-none flex items-center justify-center gap-1.5 bg-[var(--color-brand-accent)] text-white px-4 py-2.5 rounded-xl text-xs sm:text-sm font-bold hover:brightness-110 transition-all cursor-pointer shadow-md"
                  >
                    <Plus className="w-4 h-4" />
                    <span>+ Add Client</span>
                  </button>
                </div>
              </div>

              {/* CSV Import Status Banner */}
              {csvImportResult && (
                <div className="bg-[var(--color-brand-900)] border border-[var(--color-brand-accent)]/60 rounded-xl p-3.5 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5 text-xs sm:text-sm text-[var(--color-brand-light)] font-semibold">
                    <CheckCircle2 className="w-4 h-4 text-[var(--color-brand-accent)] flex-shrink-0" />
                    <span>{csvImportResult}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setCsvImportResult(null)}
                    className="text-[var(--color-brand-muted)] hover:text-[var(--color-brand-light)] cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )}

              {/* Real-Time Search Bar + Red Listed Filter Toggle */}
              <div className="flex flex-col sm:flex-row gap-2.5">
                <div className="relative flex-1">
                  <Search className="w-4 h-4 text-[var(--color-brand-muted)] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    placeholder="Search clients by name, phone number, or cut notes..."
                    value={clientSearch}
                    onChange={(e) => {
                      setClientSearch(e.target.value)
                      setVisibleClientCount(100)
                    }}
                    className="w-full bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] focus:border-[var(--color-brand-accent)] rounded-xl py-3 pl-10 pr-10 text-sm text-[var(--color-brand-light)] outline-none transition-colors"
                  />
                  {clientSearch && (
                    <button
                      type="button"
                      onClick={() => setClientSearch('')}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--color-brand-muted)] hover:text-[var(--color-brand-light)] cursor-pointer"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => {
                    setShowRedListedOnly(prev => !prev)
                    setVisibleClientCount(100)
                  }}
                  className={`px-4 py-3 rounded-xl border text-xs sm:text-sm font-bold whitespace-nowrap transition-all cursor-pointer flex items-center justify-center gap-2 ${
                    showRedListedOnly
                      ? 'bg-red-600 border-red-500 text-white shadow-md'
                      : 'bg-[var(--color-brand-900)] border-red-500/40 text-red-400 hover:border-red-500 hover:bg-red-950/30'
                  }`}
                >
                  <span>🚩 Red Listed ({redListedCount})</span>
                </button>
              </div>

              {/* Client List */}
              {loadingClients && clientsList.length === 0 ? (
                <div className="text-center py-12 text-[var(--color-brand-muted)] animate-pulse bg-[var(--color-brand-900)] rounded-xl border border-[var(--color-brand-700)]">
                  Loading client directory...
                </div>
              ) : filteredClients.length === 0 ? (
                <div className="text-center py-12 text-[var(--color-brand-muted)] bg-[var(--color-brand-900)] rounded-xl border border-dashed border-[var(--color-brand-700)] p-6">
                  <Users className="w-8 h-8 text-[var(--color-brand-muted)] mx-auto mb-2 opacity-60" />
                  <p className="font-bold text-[var(--color-brand-light)] text-sm">
                    {showRedListedOnly ? 'No red-listed clients found' : clientSearch ? 'No matching clients found' : 'No clients in directory yet'}
                  </p>
                  <p className="text-xs mt-1">
                    {showRedListedOnly
                      ? 'Clear the Red Listed filter to view all clients.'
                      : clientSearch
                      ? 'Try searching a different name, phone digit, or note keyword.'
                      : 'Import your Vagaro CSV or tap "+ Add Client" to add your first client.'}
                  </p>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {displayedClients.map((client) => {
                    const clientAppts = allAppointmentsByClient[client.id] || []
                    const apptCount = clientAppts.length
                    const isRedListed = Boolean(client.is_red_listed)
                    const owedBarberLabel = (client.red_listed_by || 'BARBER').toUpperCase()

                    return (
                      <button
                        key={client.id}
                        type="button"
                        onClick={() => handleOpenClientProfile(client)}
                        className={`w-full card-violet-gold rounded-xl p-4 text-left transition-all cursor-pointer group flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                          isRedListed ? '!border-red-500 ring-1 ring-red-500/60' : ''
                        }`}
                      >
                        <div className="flex items-start gap-3.5 min-w-0 flex-1">
                          <div className={`w-10 h-10 rounded-full bg-[var(--color-brand-900)] border flex items-center justify-center font-bold text-sm flex-shrink-0 mt-0.5 transition-colors ${
                            isRedListed
                              ? 'border-red-500 text-red-400 shadow-[0_0_8px_rgba(239,68,68,0.3)]'
                              : 'border-[#D4AF37]/60 shadow-[0_0_8px_rgba(212,175,55,0.2)] text-[var(--color-brand-gold)]'
                          }`}>
                            {(client.name || 'C').charAt(0).toUpperCase()}
                          </div>

                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                              <h3 className="font-bold text-base text-[var(--color-brand-light)] group-hover:text-[var(--color-brand-accent)] transition-colors truncate">
                                {client.name}
                              </h3>
                              <span className="text-xs font-mono text-[var(--color-brand-muted)] bg-[var(--color-brand-900)]/60 px-2 py-0.5 rounded border border-[var(--color-brand-700)]">
                                {formatPhoneNumber(client.phone)}
                              </span>
                              {isRedListed && (
                                <span className="text-[11px] font-extrabold bg-red-600 text-white px-2 py-0.5 rounded shadow-sm">
                                  🚩 RED LIST • OWES {owedBarberLabel}
                                </span>
                              )}
                              {(client.no_show_count || 0) > 0 && (
                                <span className="text-[11px] font-bold bg-red-950/70 border border-red-500/50 text-red-300 px-2 py-0.5 rounded">
                                  No-Shows: {client.no_show_count}
                                </span>
                              )}
                            </div>

                            {client.notes ? (
                              <p className="text-xs text-[var(--color-brand-muted)] mt-1.5 line-clamp-2 flex items-start gap-1.5">
                                <FileText className="w-3.5 h-3.5 text-[var(--color-brand-gold)] flex-shrink-0 mt-0.5" />
                                <span className="truncate">{client.notes}</span>
                              </p>
                            ) : (
                              <p className="text-xs text-[var(--color-brand-muted)]/60 italic mt-1">
                                No persistent cut notes yet — tap to add notes
                              </p>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center justify-between sm:justify-end gap-3 border-t sm:border-t-0 border-[var(--color-brand-700)]/60 pt-2.5 sm:pt-0 flex-shrink-0">
                          <span className="text-xs font-bold px-2.5 py-1 rounded-lg bg-[var(--color-brand-900)]/70 border border-[#D4AF37]/50 text-[var(--color-brand-gold)]">
                            {apptCount} {apptCount === 1 ? 'Appt' : 'Appts'}
                          </span>
                          <span className="text-xs font-bold text-[var(--color-brand-periwinkle)] group-hover:underline transition-colors">
                            Profile →
                          </span>
                        </div>
                      </button>
                    )
                  })}

                  {filteredClients.length > visibleClientCount && (
                    <div className="pt-2 text-center">
                      <button
                        type="button"
                        onClick={() => setVisibleClientCount((prev) => prev + 100)}
                        className="px-5 py-2.5 bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] hover:border-[var(--color-brand-accent)] rounded-xl text-xs font-bold text-[var(--color-brand-light)] cursor-pointer transition-colors"
                      >
                        Show More Clients ({filteredClients.length - visibleClientCount} remaining)
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })()}

      </div>

      {renderModals()}
    </div>
  )
}