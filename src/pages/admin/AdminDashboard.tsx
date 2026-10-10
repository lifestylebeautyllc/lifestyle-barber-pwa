import { useState, useEffect } from 'react'
import { Shield, LogOut, Calendar, Users, Settings, ArrowLeft, Phone, User, Plus, X, Lock, Zap, Scissors, Power, PowerOff, Edit, Save, SlidersHorizontal, ChevronLeft, ChevronRight, MessageSquare, UserX, Trash2, FileText } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { getAvailableSlots } from '../../lib/slotEngine'

// --- HELPER FUNCTIONS ---
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
const CALENDAR_START_HOUR = 9
const CALENDAR_END_HOUR = 20
const PIXELS_PER_MINUTE = 2

const PIXELS_PER_HOUR = 60 * PIXELS_PER_MINUTE

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
  const pixelsPerHour = PIXELS_PER_HOUR
  return Math.max(0, ((hours - CALENDAR_START_HOUR) * pixelsPerHour) + ((minutes / 60) * pixelsPerHour))
}

const timeLabels: string[] = []
for (let i = CALENDAR_START_HOUR; i <= CALENDAR_END_HOUR; i++) {
  timeLabels.push(`${i > 12 ? i - 12 : i}:00 ${i >= 12 ? 'PM' : 'AM'}`)
}

type WalkInSlot = { time: string, barberId: string, barberName: string }

export default function AdminDashboard() {
  const [session, setSession] = useState<any>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(true)
  const [authError, setAuthError] = useState('')

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

  const [calendarView, setCalendarView] = useState<'month' | 'week' | 'day'>('day')
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

  // --- MODALS STATE ---
  const [showBookModal, setShowBookModal] = useState(false)
  const [bookService, setBookService] = useState<any>(null)
  const [bookDate, setBookDate] = useState(selectedDate)
  const [bookTime, setBookTime] = useState('')
  const [bookSlots, setBookSlots] = useState<string[]>([])
  const [clientName, setClientName] = useState('')
  const [clientPhone, setClientPhone] = useState('')
  const [isBooking, setIsBooking] = useState(false)

  const [showManageDayModal, setShowManageDayModal] = useState(false)
  const [isDayOff, setIsDayOff] = useState(false)
  const [overrideStart, setOverrideStart] = useState('09:00')
  const [overrideEnd, setOverrideEnd] = useState('17:00')
  const [blockStart, setBlockStart] = useState('')
  const [blockEnd, setBlockEnd] = useState('')
  const [isSavingOverride, setIsSavingOverride] = useState(false)

  // Appointment Details Modal
  const [showApptModal, setShowApptModal] = useState(false)
  const [selectedAppt, setSelectedAppt] = useState<any>(null)
  const [clientNotes, setClientNotes] = useState('')
  const [isUpdatingAppt, setIsUpdatingAppt] = useState(false)

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

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => { setSession(session); setLoading(false) })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => { setSession(session) })
    return () => subscription.unsubscribe()
  }, [])

  useEffect(() => {
    async function fetchRoster() {
      if (!session) return
      const { data } = await supabase.from('barbers').select('*').eq('is_active', true)
      if (data && data.length > 0) {
        setBarbers(data)
        const currentBarber = data.find(b => b.user_email === session.user.email)
        setLoggedInBarber(currentBarber)
        setSelectedBarberId(currentBarber ? currentBarber.id : data[0].id)
      }
    }
    fetchRoster()
  }, [session])

  useEffect(() => { if (session) supabase.from('master_services').select('name').order('name').then(({data}) => { if(data) setMasterServices(data.map(s => s.name)) }) }, [session])

  useEffect(() => {
    if (selectedBarberId) supabase.from('services').select('*').eq('barber_id', selectedBarberId).eq('is_active', true).then(({ data }) => { if (data) setAdminServices(data) })
  }, [selectedBarberId])

  // --- DATA FETCHERS ---
  useEffect(() => {
    async function fetchLineup() {
      if (!selectedBarberId || activeModule !== 'calendar' || calendarView !== 'day') return
      setLoadingAppts(true)
      const { data, error } = await supabase.from('appointments')
        .select(`id, start_time, end_time, status, notes, clients ( id, name, phone, notes )`)
        .eq('appointment_date', selectedDate)
        .eq('barber_id', selectedBarberId)
        .neq('status', 'cancelled')
        .order('start_time', { ascending: true })
      if (!error && data) setAppointments(data)
      setLoadingAppts(false)
    }
    fetchLineup()
  }, [selectedBarberId, selectedDate, calendarView, activeModule, refreshTrigger])

  useEffect(() => {
    async function fetchMonthData() {
      if (!selectedBarberId || activeModule !== 'calendar' || calendarView !== 'month') return
      const year = viewMonthDate.getFullYear()
      const month = viewMonthDate.getMonth()
      const startOfMonth = `${year}-${String(month + 1).padStart(2, '0')}-01`
      const endOfMonth = new Date(year, month + 1, 0).toISOString().split('T')[0]

      const [apptRes, overrideRes] = await Promise.all([
        supabase.from('appointments').select('id, appointment_date, status').eq('barber_id', selectedBarberId).gte('appointment_date', startOfMonth).lte('appointment_date', endOfMonth).neq('status', 'cancelled'),
        supabase.from('schedule_overrides').select('override_date, is_off').eq('barber_id', selectedBarberId).gte('override_date', startOfMonth).lte('override_date', endOfMonth)
      ])
      setMonthAppointments(apptRes.data || [])
      setMonthOverrides(overrideRes.data || [])
    }
    fetchMonthData()
  }, [selectedBarberId, viewMonthDate, activeModule, calendarView, refreshTrigger])

  useEffect(() => {
    async function fetchWeekData() {
      if (!selectedBarberId || activeModule !== 'calendar' || calendarView !== 'week') return
      const startOfWeek = `${viewWeekStartDate.getFullYear()}-${String(viewWeekStartDate.getMonth() + 1).padStart(2, '0')}-${String(viewWeekStartDate.getDate()).padStart(2, '0')}`
      const endOfWeekDate = new Date(viewWeekStartDate)
      endOfWeekDate.setDate(endOfWeekDate.getDate() + 6)
      const endOfWeek = `${endOfWeekDate.getFullYear()}-${String(endOfWeekDate.getMonth() + 1).padStart(2, '0')}-${String(endOfWeekDate.getDate()).padStart(2, '0')}`

      const [apptRes, overrideRes] = await Promise.all([
        supabase.from('appointments').select('id, appointment_date, start_time, end_time, status, notes, clients ( id, name, phone, notes )').eq('barber_id', selectedBarberId).gte('appointment_date', startOfWeek).lte('appointment_date', endOfWeek).neq('status', 'cancelled').order('start_time', { ascending: true }),
        supabase.from('schedule_overrides').select('override_date, is_off').eq('barber_id', selectedBarberId).gte('override_date', startOfWeek).lte('override_date', endOfWeek)
      ])
      setWeekAppointments(apptRes.data || [])
      setWeekOverrides(overrideRes.data || [])
    }
    fetchWeekData()
  }, [selectedBarberId, viewWeekStartDate, activeModule, calendarView, refreshTrigger])

  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
  const dayNamesShort = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

  useEffect(() => {
    const parts = selectedDate.split('-').map(Number)
    const d = new Date(parts[0], parts[1] - 1, parts[2])
    const diff = d.getDate() - d.getDay()
    setViewWeekStartDate(new Date(d.setDate(diff)))
  }, [selectedDate])

  const handlePrevMonth = () => setViewMonthDate(prev => new Date(prev.getFullYear(), prev.getMonth() - 1, 1))
  const handleNextMonth = () => setViewMonthDate(prev => new Date(prev.getFullYear(), prev.getMonth() + 1, 1))
  const handlePrevWeek = () => setViewWeekStartDate(prev => { const d = new Date(prev); d.setDate(d.getDate() - 7); return d })
  const handleNextWeek = () => setViewWeekStartDate(prev => { const d = new Date(prev); d.setDate(d.getDate() + 7); return d })

  const handleDayClick = (dateStr: string) => {
    setSelectedDate(dateStr); setBookDate(dateStr); setCalendarView('day')
  }

  const fetchMyServices = async () => {
    if (!selectedBarberId) return
    const { data } = await supabase.from('services').select('*').eq('barber_id', selectedBarberId).order('is_active', { ascending: false }).order('name', { ascending: true })
    setMyServices(data || [])
  }
  useEffect(() => { if (session && activeModule === 'services' && selectedBarberId) fetchMyServices() }, [session, activeModule, selectedBarberId])

  useEffect(() => {
    if (showBookModal && selectedBarberId && bookService && bookDate) {
      getAvailableSlots(selectedBarberId, bookDate, bookService.duration_minutes).then(setBookSlots)
    } else { setBookSlots([]) }
    // NOTE: bookTime is intentionally NOT reset here so click-to-book pre-fill survives modal open.
  }, [showBookModal, selectedBarberId, bookService, bookDate])

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

  // --- SUBMIT HANDLERS ---
  const handleAdminBooking = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!clientName || !clientPhone || !bookTime || !bookService) return
    setIsBooking(true)
    try {
      // --- DURATION-BASED COLLISION MATH (runs before any client writes) ---
      const duration = Number(bookService.duration_minutes) || 0
      const proposedStartTime = toMinutes(bookTime)
      const proposedEndTime = proposedStartTime + duration
      const endTimeStr = `${Math.floor(proposedEndTime / 60).toString().padStart(2, '0')}:${(proposedEndTime % 60).toString().padStart(2, '0')}:00`

      const { data: conflicts, error: conflictErr } = await supabase
        .from('appointments')
        .select('clients ( name ), start_time, end_time')
        .eq('barber_id', selectedBarberId)
        .eq('appointment_date', bookDate)
        .neq('status', 'cancelled')
      if (conflictErr) throw conflictErr

      if (conflicts) {
        // 1. Proposed start lands inside an existing appointment
        const startsInside = conflicts.find((c: any) => {
          const cStart = toMinutes(c.start_time)
          const cEnd = toMinutes(c.end_time)
          return proposedStartTime >= cStart && proposedStartTime < cEnd
        })
        if (startsInside) {
          const conflictName = (startsInside as any).clients?.name || 'Walk-In'
          alert(`Hold up — ${conflictName} is already locked in at this time. Clear or shift that slot first before blocking it out.`)
          return
        }

        // 2. Proposed duration block bleeds into a later appointment's start time
        const bleedsIntoNext = conflicts.some((c: any) => {
          const cStart = toMinutes(c.start_time)
          return proposedStartTime < cStart && proposedEndTime > cStart
        })
        if (bleedsIntoNext) {
          alert('Not enough time! This blocks runs into an existing appointment.')
          return
        }
      }

      // --- STEP A: Write the LIVE form state into `clients` and get its real id back ---
      // `clients.phone` is UNIQUE, so a plain insert would 409 for a returning client.
      // Upsert on phone inserts new clients and overwrites the name on existing ones — never a stale name.
      const liveName = clientName.trim()
      const livePhone = clientPhone.trim()
      const { data: clientData, error: clientErr } = await supabase
        .from('clients')
        .upsert({ name: liveName, phone: livePhone }, { onConflict: 'phone' })
        .select('id, name')
        .single()
      if (clientErr) throw clientErr
      if (!clientData?.id) throw new Error('Client record was not returned by the database.')
      if (clientData.name !== liveName) throw new Error(`Client name did not save (database still has "${clientData.name}").`)

      // --- STEP B: Use the freshly returned client id — nothing cached, nothing hardcoded ---
      // Only real `appointments` columns. Client name/phone live on `clients` (linked via client_id).
      // end_time + appointment_date are NOT NULL in the schema and must be sent.
      const { error: apptErr } = await supabase.from('appointments').insert({
        barber_id: selectedBarberId,
        client_id: clientData.id,
        service_id: bookService.id,
        appointment_date: bookDate,
        start_time: `${bookTime}:00`,
        end_time: endTimeStr,
        status: 'booked'
      })
      if (apptErr) throw apptErr

      // Dispatch Twilio SMS Notifications
      try {
        const assignedBarber = barbers.find(b => b.id === selectedBarberId)
        const barberName = assignedBarber?.name || loggedInBarber?.name || 'LifeStyle Barber'
        const friendlyDate = new Date(bookDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

        // 1. Notify Client
        await supabase.functions.invoke('twilio-sms', {
          body: {
            to: clientPhone,
            message: `LifeStyle Barber: Your appointment with ${barberName} for ${bookService.name} is confirmed for ${friendlyDate} at ${formatTime(bookTime)}. Reply CANCEL to cancel. Reply STOP to unsubscribe.`
          }
        })

        // 2. Notify Barber (if phone available)
        const barberPhone = assignedBarber?.phone || loggedInBarber?.phone
        if (barberPhone && barberPhone !== clientPhone) {
          await supabase.functions.invoke('twilio-sms', {
            body: {
              to: barberPhone,
              message: `LifeStyle Barber: New booking with ${clientName} (${clientPhone}) for ${bookService.name} on ${friendlyDate} at ${formatTime(bookTime)}.`
            }
          })
        }
      } catch (smsErr) {
        console.error("SMS Dispatch Failed:", smsErr)
      }

      setShowBookModal(false); setBookService(null); setBookTime(''); setClientName(''); setClientPhone(''); setRefreshTrigger(prev => prev + 1)
    } catch (error: any) { console.error(error); alert(`Failed to book appointment: ${error?.message || 'Unknown error'}`) }
    finally { setIsBooking(false) }
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

      await supabase.from('appointments').insert({ barber_id: targetBarberId, client_id: clientId, appointment_date: selectedDate, start_time: `${time}:00`, end_time: endTimeStr, status: 'walk-in' })
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
      await supabase.from('appointments').insert({ barber_id: selectedBarberId, client_id: clientId, appointment_date: selectedDate, start_time: `${blockStart}:00`, end_time: `${blockEnd}:00`, status: 'blocked' })
      setShowManageDayModal(false); setBlockStart(''); setBlockEnd(''); setRefreshTrigger(prev => prev + 1)
    } catch (err) { console.error(err); alert("Failed to block time.") }
    finally { setIsSavingOverride(false) }
  }

  // --- APPOINTMENT DETAILS & CUT NOTES LOGIC ---
  const handleOpenAppt = (appt: any) => {
    setSelectedAppt(appt)
    setClientNotes(appt.clients?.notes || '')
    setShowApptModal(true)
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
      setShowApptModal(false)
      setSelectedAppt(null)
      setRefreshTrigger(prev => prev + 1)
    } catch (err) { console.error(err); alert("Failed to mark no-show.") }
    finally { setIsUpdatingAppt(false) }
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
  const handleToggleService = async (serviceId: string, currentStatus: boolean) => {
    try { await supabase.from('services').update({ is_active: !currentStatus }).eq('id', serviceId); fetchMyServices() } catch (err) { console.error(err) }
  }
  const handleSaveEdit = async (serviceId: string) => {
    try { await supabase.from('services').update({ name: editForm.name, duration_minutes: parseInt(editForm.duration), price: parseFloat(editForm.price) }).eq('id', serviceId); setEditingServiceId(null); fetchMyServices() } catch (err) { console.error(err) }
  }

  // --- AUTH LOGIC ---
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault(); setLoading(true); setAuthError('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setAuthError(error.message)
    setLoading(false)
  }
  const handleLogout = async () => { await supabase.auth.signOut() }

  if (loading) return <div className="min-h-screen bg-[var(--color-brand-900)] flex items-center justify-center animate-pulse text-[var(--color-brand-muted)]">Checking credentials...</div>

  // --- LOGIN SCREEN ---
  if (!session) {
    return (
      <div className="min-h-screen bg-[var(--color-brand-900)] text-[var(--color-brand-light)] font-sans flex flex-col items-center justify-center p-6">
        <div className="w-full max-w-md bg-[var(--color-brand-800)] border border-[var(--color-brand-700)] p-8 rounded-2xl shadow-2xl">
          <div className="flex flex-col items-center text-center mb-8">
            <div className="bg-[var(--color-brand-900)] p-4 rounded-full border border-[var(--color-brand-700)] mb-4"><Shield className="w-8 h-8 text-[var(--color-brand-accent)]" /></div>
            <h1 className="text-2xl font-bold tracking-tight">Barber Login</h1>
          </div>
          {authError && <div className="bg-red-900/20 border border-red-500/50 text-red-200 text-sm p-3 rounded-xl mb-6 text-center">{authError}</div>}
          <form onSubmit={handleLogin} className="space-y-4">
            <input type="email" required placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] rounded-xl p-3 outline-none focus:border-[var(--color-brand-accent)] text-white" />
            <input type="password" required placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] rounded-xl p-3 outline-none focus:border-[var(--color-brand-accent)] text-white" />
            <button type="submit" disabled={loading} className="w-full bg-[var(--color-brand-accent)] text-white font-bold p-3 rounded-xl mt-4 cursor-pointer hover:brightness-110 transition-all">Sign In</button>
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

  // REUSABLE TIME-RAIL RENDER ENGINE
  const renderTimeGrid = (gridDate: string, gridAppts: any[], isOff: boolean | undefined) => {
    return (
      <div className="relative flex-1 border-r border-[var(--color-brand-700)] min-w-[120px]" style={{ height: `${(CALENDAR_END_HOUR - CALENDAR_START_HOUR) * 60 * PIXELS_PER_MINUTE}px` }}>

        {/* Grid Lines */}
        {Array.from({ length: CALENDAR_END_HOUR - CALENDAR_START_HOUR + 1 }).map((_, i) => (
          <div key={`grid-${i}`} className="absolute left-0 w-full h-0 m-0 p-0 box-border border-t border-[var(--color-brand-700)]/40 pointer-events-none" style={{ top: `${i * PIXELS_PER_HOUR}px` }} />
        ))}

        {/* Empty Tap-to-Book Slots */}
        {Array.from({ length: (CALENDAR_END_HOUR - CALENDAR_START_HOUR) * 4 }).map((_, i) => {
          const totalMins = CALENDAR_START_HOUR * 60 + (i * 15)
          const timeStr = `${Math.floor(totalMins / 60).toString().padStart(2,'0')}:${(totalMins % 60).toString().padStart(2,'0')}`
          return (
            <button key={`slot-${i}`} onClick={() => { setBookDate(gridDate); setBookTime(timeStr); setShowBookModal(true); }} className={`absolute w-full m-0 box-border border-b border-[var(--color-brand-700)]/20 hover:bg-[var(--color-brand-accent)]/20 transition-colors z-10 ${isOff ? 'pointer-events-none opacity-0' : 'cursor-pointer'}`} style={{ top: `${(i * 15) * PIXELS_PER_MINUTE}px`, height: `${15 * PIXELS_PER_MINUTE}px` }} />
          )
        })}

        {isOff && <div className="absolute inset-0 bg-[repeating-linear-gradient(45deg,transparent,transparent_10px,var(--color-brand-900)_10px,var(--color-brand-900)_20px)] opacity-50 z-10 pointer-events-none" />}

        {/* Dynamic Appointment Blocks */}
        {!isOff && gridAppts.map(appt => {
          const top = timeToPixels(appt.start_time)
          const durationMins = Math.max(15, toMinutes(appt.end_time) - toMinutes(appt.start_time))
          const height = durationMins * PIXELS_PER_MINUTE

          return (
            <button
              key={appt.id}
              onClick={() => handleOpenAppt(appt)}
              className={`absolute left-1 right-1 m-0 box-border rounded-md p-2 overflow-hidden border shadow-md flex flex-col text-left z-20 cursor-pointer hover:brightness-110 transition-all ${
                appt.status === 'blocked' ? 'bg-orange-900/80 border-orange-500 text-orange-200' :
                appt.status === 'completed' ? 'bg-green-900/80 border-green-500 text-green-200' :
                'bg-[var(--color-brand-800)] border-[var(--color-brand-accent)] text-[var(--color-brand-light)]'
              }`}
              style={{ top: `${top}px`, height: `${height}px` }}
            >
              <div className={`text-xs font-bold ${appt.status === 'blocked' ? 'text-orange-400' : appt.status === 'completed' ? 'text-green-400' : 'text-[var(--color-brand-accent)]'}`}>
                {appt.status === 'blocked' && <Lock className="w-3 h-3 inline mr-1 -mt-0.5" />}
                {formatTime(appt.start_time)}
              </div>
              <div className="text-xs truncate font-medium flex items-center gap-1">
                <span className="truncate">{appt.status === 'booked' || appt.status === 'completed' ? appt.clients?.name : appt.status.toUpperCase()}</span>
                {appt.notes && <FileText className="w-3 h-3 flex-shrink-0 opacity-70" />}
              </div>
            </button>
          )
        })}
      </div>
    )
  }

  // PROTECTED DASHBOARD RENDER
  return (
    <div className="min-h-screen bg-[var(--color-brand-900)] text-[var(--color-brand-light)] p-4 md:p-8 font-sans relative">
      <div className="max-w-4xl mx-auto">
        <header className="flex items-center justify-between mb-8 border-b border-[var(--color-brand-700)] pb-6">
          <div className="flex items-center gap-3">
            <Shield className="text-[var(--color-brand-accent)] w-8 h-8" />
            <div>
              <h1 className="text-2xl font-bold">Barber Portal</h1>
              <p className="text-sm text-[var(--color-brand-muted)]">{session.user.email}</p>
            </div>
          </div>
          <button onClick={handleLogout} className="flex items-center gap-2 bg-[var(--color-brand-800)] border border-[var(--color-brand-700)] hover:border-[var(--color-brand-accent)] px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer">
            <LogOut className="w-4 h-4" /> Sign Out
          </button>
        </header>

        {/* --- MAIN MODULE NAVIGATION --- */}
        {activeModule === 'home' && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            <button onClick={() => setActiveModule('calendar')} className="bg-[var(--color-brand-800)] p-6 rounded-xl border border-[var(--color-brand-700)] hover:border-[var(--color-brand-accent)] transition-colors text-left group cursor-pointer">
              <Calendar className="w-6 h-6 text-[var(--color-brand-accent)] mb-3" />
              <h3 className="text-lg font-bold mb-1 group-hover:text-[var(--color-brand-accent)]">Live Calendar</h3>
              <p className="text-xs text-[var(--color-brand-muted)]">Manage daily lineup</p>
            </button>
            <button onClick={() => setActiveModule('walkin')} className="bg-[var(--color-brand-800)] p-6 rounded-xl border border-[var(--color-brand-700)] hover:border-orange-500 transition-colors text-left group cursor-pointer">
              <Zap className="w-6 h-6 text-orange-500 mb-3" />
              <h3 className="text-lg font-bold mb-1 group-hover:text-orange-500">Express Walk-In</h3>
              <p className="text-xs text-[var(--color-brand-muted)]">1-Tap shop lockdown</p>
            </button>
            <button onClick={() => setActiveModule('clients')} className="bg-[var(--color-brand-800)] p-6 rounded-xl border border-[var(--color-brand-700)] hover:border-[var(--color-brand-accent)] transition-colors text-left group cursor-pointer">
              <Users className="w-6 h-6 text-[var(--color-brand-accent)] mb-3" />
              <h3 className="text-lg font-bold mb-1 group-hover:text-[var(--color-brand-accent)]">Clients</h3>
              <p className="text-xs text-[var(--color-brand-muted)]">Cut notes & history</p>
            </button>
            <button onClick={() => setActiveModule('services')} className="bg-[var(--color-brand-800)] p-6 rounded-xl border border-[var(--color-brand-700)] hover:border-[var(--color-brand-accent)] transition-colors text-left group cursor-pointer">
              <Settings className="w-6 h-6 text-[var(--color-brand-accent)] mb-3" />
              <h3 className="text-lg font-bold mb-1 group-hover:text-[var(--color-brand-accent)]">My Services</h3>
              <p className="text-xs text-[var(--color-brand-muted)]">Prices & durations</p>
            </button>
          </div>
        )}

        {/* --- 1. LIVE CALENDAR MODULE --- */}
        {activeModule === 'calendar' && (
          <div className="bg-[var(--color-brand-800)] border border-[var(--color-brand-700)] rounded-2xl p-4 md:p-6 shadow-xl animate-in fade-in slide-in-from-bottom-4 duration-300">

            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
              <div className="flex items-center gap-3">
                <button onClick={() => setActiveModule('home')} className="p-2 bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] rounded-full hover:border-[var(--color-brand-accent)] hover:text-[var(--color-brand-accent)] transition-colors cursor-pointer flex-shrink-0">
                  <ArrowLeft className="w-5 h-5" />
                </button>
                <select value={selectedBarberId} onChange={(e) => setSelectedBarberId(e.target.value)} className="bg-[var(--color-brand-900)] text-[var(--color-brand-light)] border border-[var(--color-brand-700)] rounded-lg p-2 outline-none focus:border-[var(--color-brand-accent)] transition-colors cursor-pointer font-bold appearance-none">
                  {barbers.map(barber => <option key={barber.id} value={barber.id}>{barber.name}'s Schedule</option>)}
                </select>
              </div>
              <div className="bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] p-1 rounded-lg flex self-start sm:self-auto">
                <button onClick={() => setCalendarView('month')} className={`px-4 py-2 rounded-md text-sm font-bold transition-all cursor-pointer ${calendarView === 'month' ? 'bg-[var(--color-brand-800)] text-[var(--color-brand-light)] shadow' : 'text-[var(--color-brand-muted)] hover:text-white'}`}>Month</button>
                <button onClick={() => setCalendarView('week')} className={`px-4 py-2 rounded-md text-sm font-bold transition-all cursor-pointer ${calendarView === 'week' ? 'bg-[var(--color-brand-800)] text-[var(--color-brand-light)] shadow' : 'text-[var(--color-brand-muted)] hover:text-white'}`}>Week</button>
                <button onClick={() => setCalendarView('day')} className={`px-4 py-2 rounded-md text-sm font-bold transition-all cursor-pointer ${calendarView === 'day' ? 'bg-[var(--color-brand-800)] text-[var(--color-brand-light)] shadow' : 'text-[var(--color-brand-muted)] hover:text-white'}`}>Day</button>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-3 mb-6 bg-[var(--color-brand-900)] p-4 rounded-xl border border-[var(--color-brand-700)]">
              <input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} className="flex-grow sm:flex-grow-0 bg-[var(--color-brand-800)] text-[var(--color-brand-light)] border border-[var(--color-brand-700)] rounded-lg p-3 outline-none focus:border-[var(--color-brand-accent)] transition-colors [color-scheme:dark] font-bold cursor-pointer" />
              <div className="flex gap-2 w-full sm:w-auto ml-auto">
                <button onClick={() => setShowManageDayModal(true)} className="flex-1 sm:flex-none flex items-center justify-center gap-2 bg-[var(--color-brand-800)] border border-[var(--color-brand-700)] text-[var(--color-brand-light)] px-4 py-3 rounded-lg font-bold hover:border-[var(--color-brand-accent)] cursor-pointer transition-colors">
                  <SlidersHorizontal className="w-5 h-5" /> Manage
                </button>
                <button onClick={() => { setBookDate(selectedDate); setBookTime(''); setShowBookModal(true); }} className="flex-1 sm:flex-none flex items-center justify-center gap-2 bg-[var(--color-brand-accent)] text-white px-4 py-3 rounded-lg font-bold hover:brightness-110 cursor-pointer">
                  <Plus className="w-5 h-5" /> Book
                </button>
              </div>
            </div>

            {/* MONTH VIEW */}
            {calendarView === 'month' && (
              <div className="animate-in fade-in duration-300">
                <div className="flex items-center justify-between mb-4 px-2">
                  <h3 className="text-xl font-bold text-[var(--color-brand-light)]">
                    {monthNames[viewMonthDate.getMonth()]} {viewMonthDate.getFullYear()}
                  </h3>
                  <div className="flex gap-2">
                    <button onClick={handlePrevMonth} className="p-2 bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] rounded hover:border-[var(--color-brand-accent)] transition-colors cursor-pointer">
                      <ChevronLeft className="w-5 h-5" />
                    </button>
                    <button onClick={handleNextMonth} className="p-2 bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] rounded hover:border-[var(--color-brand-accent)] transition-colors cursor-pointer">
                      <ChevronRight className="w-5 h-5" />
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-7 gap-1 sm:gap-2">
                  {dayNamesShort.map(day => (
                    <div key={day} className="text-center text-xs font-bold text-[var(--color-brand-muted)] uppercase tracking-wider py-2">
                      {day}
                    </div>
                  ))}

                  {monthMatrix.map((date, index) => {
                    if (!date) return <div key={`empty-${index}`} className="h-16 sm:h-24 bg-[var(--color-brand-900)]/30 border border-[var(--color-brand-700)]/50 rounded-lg"></div>

                    const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
                    const isToday = dateStr === new Date().toISOString().split('T')[0]
                    const dayAppts = monthAppointments.filter(a => a.appointment_date === dateStr)
                    const dayOverride = monthOverrides.find(o => o.override_date === dateStr)
                    const isOff = dayOverride?.is_off

                    return (
                      <button
                        key={index}
                        onClick={() => handleDayClick(dateStr)}
                        className={`relative h-16 sm:h-24 p-2 flex flex-col items-start border rounded-lg cursor-pointer transition-colors ${
                          isToday ? 'border-[var(--color-brand-accent)] bg-[var(--color-brand-accent)]/10' : 'border-[var(--color-brand-700)] bg-[var(--color-brand-900)] hover:border-[var(--color-brand-accent)]'
                        } ${isOff ? 'opacity-50 overflow-hidden' : ''}`}
                      >
                        <span className={`text-sm font-bold ${isToday ? 'text-[var(--color-brand-accent)]' : 'text-[var(--color-brand-light)]'}`}>
                          {date.getDate()}
                        </span>

                        {isOff && <div className="absolute inset-0 flex items-center justify-center"><div className="w-full h-px bg-red-500/50 transform -rotate-45"></div></div>}

                        {!isOff && dayAppts.length > 0 && (
                          <div className="mt-auto flex flex-wrap gap-1">
                            {dayAppts.slice(0, 3).map((_, i) => <div key={i} className="w-2 h-2 rounded-full bg-[var(--color-brand-accent)] shadow-[0_0_5px_rgba(168,85,247,0.8)]"></div>)}
                            {dayAppts.length > 3 && <span className="text-[10px] text-[var(--color-brand-muted)] font-bold leading-none">+{dayAppts.length - 3}</span>}
                          </div>
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {/* WEEK VIEW (Time-Rail Matrix) */}
            {calendarView === 'week' && (
              <div className="animate-in fade-in duration-300 flex flex-col h-[600px] border border-[var(--color-brand-700)] rounded-xl overflow-hidden bg-[var(--color-brand-900)] mt-6">

                {/* Week Header (Restored to fix isSameMonth warning) */}
                <div className="flex items-center justify-between p-4 border-b border-[var(--color-brand-700)] bg-[var(--color-brand-800)]">
                  <h3 className="text-sm sm:text-xl font-bold text-[var(--color-brand-light)]">
                    {monthNames[viewWeekStartDate.getMonth()]} {viewWeekStartDate.getDate()} - {isSameMonth ? '' : monthNames[weekEndDate.getMonth()]} {weekEndDate.getDate()}, {viewWeekStartDate.getFullYear()}
                  </h3>
                </div>

                <div className="flex bg-[var(--color-brand-800)] border-b border-[var(--color-brand-700)]">
                  <div className="w-16 flex-shrink-0 border-r border-[var(--color-brand-700)] flex flex-col items-center justify-center p-1">
                    <button onClick={handlePrevWeek} className="p-1 hover:text-[var(--color-brand-accent)] cursor-pointer"><ChevronLeft className="w-4 h-4" /></button>
                    <button onClick={handleNextWeek} className="p-1 hover:text-[var(--color-brand-accent)] cursor-pointer"><ChevronRight className="w-4 h-4" /></button>
                  </div>
                  <div className="flex-1 flex overflow-x-hidden">
                    {Array.from({ length: 7 }).map((_, i) => {
                      const d = new Date(viewWeekStartDate); d.setDate(d.getDate() + i)
                      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
                      const isToday = dateStr === new Date().toISOString().split('T')[0]
                      return (
                        <button key={dateStr} onClick={() => handleDayClick(dateStr)} className={`flex-1 min-w-[120px] text-center p-2 border-r border-[var(--color-brand-700)] cursor-pointer transition-colors ${isToday ? 'bg-[var(--color-brand-accent)]/20 border-b-2 border-b-[var(--color-brand-accent)]' : 'hover:bg-[var(--color-brand-accent)]/10'}`}>
                          <div className={`text-[10px] uppercase font-bold tracking-wider ${isToday ? 'text-[var(--color-brand-accent)]' : 'text-[var(--color-brand-muted)]'}`}>{dayNamesShort[d.getDay()]}</div>
                          <div className={`text-lg font-bold ${isToday ? 'text-[var(--color-brand-accent)]' : ''}`}>{d.getDate()}</div>
                        </button>
                      )
                    })}
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto overflow-x-auto relative">
                  <div className="flex min-w-[max-content] md:min-w-full">
                    <div className="w-16 flex-shrink-0 bg-[var(--color-brand-800)] border-r border-[var(--color-brand-700)] sticky left-0 z-30 pt-4 pb-4">
                      <div className="relative" style={{ height: `${(CALENDAR_END_HOUR - CALENDAR_START_HOUR) * PIXELS_PER_HOUR}px` }}>
                        {timeLabels.map((label, i) => <div key={i} className="absolute right-0 pr-2 text-right text-[10px] leading-none text-[var(--color-brand-muted)] font-bold -translate-y-1/2 whitespace-nowrap" style={{ top: `${i * PIXELS_PER_HOUR}px` }}>{label}</div>)}
                      </div>
                    </div>
                    {Array.from({ length: 7 }).map((_, i) => {
                      const d = new Date(viewWeekStartDate); d.setDate(d.getDate() + i)
                      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
                      const dayAppts = weekAppointments.filter(a => a.appointment_date === dateStr)
                      const isOff = weekOverrides.find(o => o.override_date === dateStr)?.is_off
                      return <div key={dateStr} className="flex-1 pt-4 pb-4">{renderTimeGrid(dateStr, dayAppts, isOff)}</div>
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* DAY VIEW (Time-Rail Matrix) */}
            {calendarView === 'day' && (
              <div className="animate-in fade-in slide-in-from-right-4 duration-300 flex flex-col h-[600px] border border-[var(--color-brand-700)] rounded-xl overflow-hidden bg-[var(--color-brand-900)] mt-6">
                <div className="flex bg-[var(--color-brand-800)] border-b border-[var(--color-brand-700)] items-center p-4">
                   <div className="text-xl font-bold">{new Date(selectedDate).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })}</div>
                </div>
                <div className="flex-1 overflow-y-auto relative">
                  <div className="flex">
                    <div className="w-16 flex-shrink-0 bg-[var(--color-brand-800)] border-r border-[var(--color-brand-700)] sticky left-0 z-30 pt-4 pb-4">
                      <div className="relative" style={{ height: `${(CALENDAR_END_HOUR - CALENDAR_START_HOUR) * PIXELS_PER_HOUR}px` }}>
                        {timeLabels.map((label, i) => <div key={i} className="absolute right-0 pr-2 text-right text-[10px] leading-none text-[var(--color-brand-muted)] font-bold -translate-y-1/2 whitespace-nowrap" style={{ top: `${i * PIXELS_PER_HOUR}px` }}>{label}</div>)}
                      </div>
                    </div>
                    <div className="flex-1 pt-4 pb-4">
                      {loadingAppts ? <div className="p-8 text-[var(--color-brand-muted)] animate-pulse">Fetching...</div> : renderTimeGrid(selectedDate, appointments, isDayOff)}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* --- 2. EXPRESS WALK-IN UI --- */}
        {activeModule === 'walkin' && (
          <div className="bg-[var(--color-brand-800)] border border-orange-500/30 rounded-2xl p-6 shadow-[0_0_40px_rgba(249,115,22,0.1)] animate-in fade-in max-w-2xl mx-auto">
            <div className="flex items-center gap-3 mb-8">
              <button onClick={() => setActiveModule('home')} className="p-2 bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] rounded-full hover:border-orange-500 cursor-pointer">
                <ArrowLeft className="w-5 h-5" />
              </button>
              <div>
                <h2 className="text-xl font-bold flex items-center gap-2 text-orange-500"><Zap className="w-5 h-5" /> Express Walk-In</h2>
                <p className="text-sm text-[var(--color-brand-muted)]">Select a service, tap an open time, and instantly lock the chair.</p>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-4 mb-8">
              <select value={walkInBarberId} onChange={(e) => setWalkInBarberId(e.target.value)} className="w-full sm:w-1/3 bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] rounded-xl p-4 outline-none appearance-none cursor-pointer font-bold">
                <option value="any">All Available Barbers</option>
                {barbers.map(barber => <option key={barber.id} value={barber.id}>{barber.name}</option>)}
              </select>

              <input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} className="w-full sm:w-1/3 bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] rounded-xl p-4 outline-none [color-scheme:dark] cursor-pointer font-bold" />

              <select value={walkInService?.id || ''} onChange={(e) => setWalkInService(adminServices.find(s => s.id === e.target.value))} className="w-full sm:w-1/3 bg-[var(--color-brand-900)] border border-orange-500/50 rounded-xl p-4 outline-none appearance-none cursor-pointer font-bold text-orange-400">
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
                <button onClick={() => setActiveModule('home')} className="p-2 bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] rounded-full hover:border-[var(--color-brand-accent)] cursor-pointer">
                  <ArrowLeft className="w-5 h-5" />
                </button>
                <div>
                  <h2 className="text-xl font-bold">My Services</h2>
                  <p className="text-sm text-[var(--color-brand-muted)]">Manage your personal service menu.</p>
                </div>
              </div>
              <select value={selectedBarberId} onChange={(e) => setSelectedBarberId(e.target.value)} className="bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] rounded-lg p-3 outline-none cursor-pointer font-semibold appearance-none">
                {barbers.map(barber => <option key={barber.id} value={barber.id}>{barber.name}'s Menu</option>)}
              </select>
            </div>

            {isOwner && (
              <div className="mb-8 p-4 border border-[var(--color-brand-accent)] bg-[var(--color-brand-accent)]/10 rounded-xl">
                <h3 className="text-sm font-bold text-[var(--color-brand-accent)] mb-3">Shop Owner Controls: Master Menu</h3>
                <form onSubmit={handleAddMasterService} className="flex flex-col sm:flex-row gap-3">
                  <input type="text" required placeholder="Inject a new global service (e.g. Mullet Fade)..." value={newMasterName} onChange={(e) => setNewMasterName(e.target.value)} className="flex-grow bg-[var(--color-brand-900)] text-white border border-[var(--color-brand-700)] rounded-lg p-3 outline-none focus:border-[var(--color-brand-accent)]" />
                  <button type="submit" className="bg-[var(--color-brand-accent)] text-white font-bold p-3 rounded-lg hover:brightness-110 transition-all cursor-pointer whitespace-nowrap">Add to Global List</button>
                </form>
              </div>
            )}

            <form onSubmit={handleAddService} className="bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] p-4 rounded-xl mb-8 flex flex-col md:flex-row gap-4 items-end">
              <div className="w-full md:w-2/5">
                <label className="block text-xs font-bold text-[var(--color-brand-muted)] uppercase tracking-wider mb-2">Select Official Service</label>
                <select required value={newServiceName} onChange={(e) => setNewServiceName(e.target.value)} className="w-full bg-[var(--color-brand-800)] text-white border border-[var(--color-brand-700)] rounded-lg p-3 outline-none focus:border-[var(--color-brand-accent)] appearance-none cursor-pointer">
                  <option value="" disabled>Select Service...</option>
                  {masterServices.map(name => <option key={name} value={name}>{name}</option>)}
                </select>
              </div>
              <div className="w-full md:w-1/5">
                <label className="block text-xs font-bold text-[var(--color-brand-muted)] uppercase tracking-wider mb-2">Mins</label>
                <select value={newServiceDuration} onChange={(e) => setNewServiceDuration(e.target.value)} className="w-full bg-[var(--color-brand-800)] text-white border border-[var(--color-brand-700)] rounded-lg p-3 outline-none focus:border-[var(--color-brand-accent)] appearance-none cursor-pointer">
                  {[15, 30, 45, 60, 75, 90, 105, 120].map(mins => <option key={mins} value={mins}>{mins}</option>)}
                </select>
              </div>
              <div className="w-full md:w-1/5">
                <label className="block text-xs font-bold text-[var(--color-brand-muted)] uppercase tracking-wider mb-2">Price ($)</label>
                <input type="number" required placeholder="40" value={newServicePrice} onChange={(e) => setNewServicePrice(e.target.value)} className="w-full bg-[var(--color-brand-800)] text-white border border-[var(--color-brand-700)] rounded-lg p-3 outline-none focus:border-[var(--color-brand-accent)]" />
              </div>
              <div className="w-full md:w-1/5">
                <button type="submit" disabled={isSubmittingService || !newServiceName} className="w-full bg-[var(--color-brand-accent)] text-white font-bold p-3 rounded-lg hover:brightness-110 transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50">
                  <Plus className="w-5 h-5" /> Add
                </button>
              </div>
            </form>

            <div className="space-y-3">
              {myServices.length === 0 ? (
                 <div className="text-center py-8 text-[var(--color-brand-muted)] border border-dashed border-[var(--color-brand-700)] rounded-xl">No services found. Add your first service above.</div>
              ) : (
                myServices.map(service => (
                  <div key={service.id} className={`bg-[var(--color-brand-900)] border p-4 rounded-xl transition-colors ${service.is_active ? 'border-[var(--color-brand-700)]' : 'border-red-900/50 opacity-50'}`}>

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
                          <div className={`p-3 rounded-full ${service.is_active ? 'bg-[var(--color-brand-800)] text-[var(--color-brand-accent)]' : 'bg-red-900/20 text-red-500'}`}>
                            <Scissors className="w-5 h-5" />
                          </div>
                          <div>
                            <h3 className="font-bold text-lg">{service.name}</h3>
                            <p className="text-sm text-[var(--color-brand-muted)]">{service.duration_minutes} mins • ${service.price}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => {
                              setEditForm({ name: service.name, duration: service.duration_minutes.toString(), price: service.price.toString() })
                              setEditingServiceId(service.id)
                            }}
                            className="p-3 bg-[var(--color-brand-800)] rounded-lg hover:text-[var(--color-brand-accent)] transition-colors cursor-pointer"
                          >
                            <Edit className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleToggleService(service.id, service.is_active)}
                            className={`p-3 rounded-lg flex items-center gap-2 text-sm font-bold transition-all cursor-pointer ${service.is_active ? 'bg-[var(--color-brand-800)] hover:bg-red-900/20 hover:text-red-400' : 'bg-green-900/20 text-green-400 hover:bg-green-900/40'}`}
                          >
                            {service.is_active ? <><PowerOff className="w-4 h-4"/> Disable</> : <><Power className="w-4 h-4"/> Enable</>}
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

        {/* --- 4. CLIENTS UI (Placeholder for Phase 7) --- */}
        {activeModule === 'clients' && (
          <div className="bg-[var(--color-brand-800)] border border-[var(--color-brand-700)] rounded-2xl p-8 text-center animate-in fade-in">
            <button onClick={() => setActiveModule('home')} className="mb-4 text-[var(--color-brand-muted)] hover:text-[var(--color-brand-light)] flex items-center justify-center gap-2 mx-auto transition-colors cursor-pointer">
              <ArrowLeft className="w-4 h-4" /> Back to Dashboard
            </button>
            <p className="text-lg font-bold">Client Directory</p>
            <p className="text-sm text-[var(--color-brand-muted)] mt-2">Module Under Construction for Phase 7 (Vagaro CSV Cutover)</p>
          </div>
        )}

      </div>

      {/* --- MODALS --- */}

      {/* APPOINTMENT DETAILS & CUT NOTES MODAL */}
      {showApptModal && selectedAppt && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-in fade-in duration-200">
           <div className="bg-[var(--color-brand-800)] w-full max-w-md rounded-2xl flex flex-col border border-[var(--color-brand-700)] shadow-2xl overflow-hidden">
              <div className="flex items-center justify-between p-6 border-b border-[var(--color-brand-700)]">
                <div>
                  <h2 className="text-xl font-bold">{selectedAppt.clients?.name || 'Walk-In'}</h2>
                  <p className="text-sm text-[var(--color-brand-accent)]">{formatTime(selectedAppt.start_time)} - {formatTime(selectedAppt.end_time)}</p>
                </div>
                <button onClick={() => setShowApptModal(false)} className="text-[var(--color-brand-muted)] hover:text-white cursor-pointer"><X className="w-6 h-6" /></button>
              </div>

              <div className="p-6 space-y-6">
                 {/* Contact Buttons */}
                 {selectedAppt.clients?.phone && selectedAppt.clients.phone !== '0000000000' && (
                   <div className="flex gap-3">
                     <a href={`tel:${selectedAppt.clients.phone}`} className="flex-1 bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] text-center py-3 rounded-xl font-bold hover:border-[var(--color-brand-accent)] transition-colors flex items-center justify-center gap-2 cursor-pointer">
                       <Phone className="w-4 h-4" /> Call
                     </a>
                     <a href={`sms:${selectedAppt.clients.phone}`} className="flex-1 bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] text-center py-3 rounded-xl font-bold hover:border-[var(--color-brand-accent)] transition-colors flex items-center justify-center gap-2 cursor-pointer">
                       <MessageSquare className="w-4 h-4" /> Text
                     </a>
                   </div>
                 )}

                 {/* Appointment Booking Notes */}
                 <div className="space-y-2">
                   <label className="block text-xs font-bold text-[var(--color-brand-muted)] uppercase tracking-wider">Client Notes</label>
                   {selectedAppt.notes ? (
                     <div className="bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] text-white text-sm rounded-xl p-3">
                       {selectedAppt.notes}
                     </div>
                   ) : (
                     <div className="bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] text-[var(--color-brand-muted)] text-sm rounded-xl p-3 italic">
                       No special notes provided.
                     </div>
                   )}
                 </div>

                 {/* Cut Notes */}
                 <div className="space-y-2">
                   <label className="block text-xs font-bold text-[var(--color-brand-muted)] uppercase tracking-wider">Client Cut Notes</label>
                   <textarea
                     value={clientNotes}
                     onChange={(e) => setClientNotes(e.target.value)}
                     placeholder="e.g. #2 high fade, finger length on top..."
                     className="w-full bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] text-white rounded-xl p-3 h-28 outline-none focus:border-[var(--color-brand-accent)] resize-none"
                   />
                   <button
                     onClick={handleSaveNotes}
                     disabled={isUpdatingAppt || clientNotes === (selectedAppt.clients?.notes || '')}
                     className="w-full bg-[var(--color-brand-700)] hover:bg-[var(--color-brand-600)] text-white font-bold py-3 rounded-lg transition-colors disabled:opacity-50 cursor-pointer"
                   >
                     Save Notes
                   </button>
                 </div>

                 <hr className="border-[var(--color-brand-700)]" />

                 {/* Status Toggles */}
                 <div className="space-y-2">
                   <label className="block text-xs font-bold text-[var(--color-brand-muted)] uppercase tracking-wider mb-3">Update Status</label>
                   <div className="grid grid-cols-2 gap-2">
                     <button onClick={handleNoShow} disabled={isUpdatingAppt} className="flex flex-col items-center justify-center gap-1 py-4 rounded-xl border border-[var(--color-brand-700)] hover:bg-red-900/20 hover:border-red-500 hover:text-red-400 transition-colors cursor-pointer">
                       <UserX className="w-5 h-5" />
                       <span className="text-xs font-bold">No-Show</span>
                     </button>
                     <button onClick={handleDeleteAppt} disabled={isUpdatingAppt} className="flex flex-col items-center justify-center gap-1 py-4 rounded-xl border border-[var(--color-brand-700)] hover:bg-red-900/30 hover:border-red-600 hover:text-red-400 transition-colors cursor-pointer disabled:opacity-50">
                       <Trash2 className="w-5 h-5" />
                       <span className="text-xs font-bold">Delete</span>
                     </button>
                   </div>
                 </div>

              </div>
           </div>
        </div>
      )}

      {/* ADMIN BOOKING MODAL */}
      {showBookModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-in fade-in duration-200">
           <div className="bg-[var(--color-brand-800)] w-full max-w-md rounded-2xl flex flex-col border border-[var(--color-brand-700)] shadow-2xl">
              <div className="flex items-center justify-between p-6 border-b border-[var(--color-brand-700)]">
                <h2 className="text-xl font-bold">Manual Book</h2>
                <button onClick={() => { setShowBookModal(false); setBookTime(''); }} className="text-[var(--color-brand-muted)] hover:text-white cursor-pointer"><X className="w-6 h-6" /></button>
              </div>
              <form onSubmit={handleAdminBooking} className="p-6 space-y-4">
                 <select required value={bookService?.id || ''} onChange={(e) => setBookService(adminServices.find(s => s.id === e.target.value))} className="w-full bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] rounded-xl p-3 outline-none appearance-none cursor-pointer text-white">
                    <option value="" disabled>Select service...</option>
                    {adminServices.map(s => <option key={s.id} value={s.id}>{s.name} ({s.duration_minutes}m)</option>)}
                 </select>
                 <div className="grid grid-cols-2 gap-4">
                    <input type="date" required value={bookDate} onChange={(e) => setBookDate(e.target.value)} className="w-full bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] rounded-xl p-3 outline-none [color-scheme:dark] cursor-pointer text-white" />
                    <select required value={bookTime} onChange={(e) => setBookTime(e.target.value)} className="w-full bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] rounded-xl p-3 outline-none appearance-none cursor-pointer disabled:opacity-50 text-white">
                      <option value="" disabled>{!bookService ? 'Select service first' : bookSlots.length === 0 ? 'No slots' : 'Select time...'}</option>
                      {bookTime && !bookSlots.includes(bookTime) && <option value={bookTime}>{formatTime(bookTime)}</option>}
                      {bookSlots.map(time => <option key={time} value={time}>{formatTime(time)}</option>)}
                    </select>
                 </div>
                 <div className="space-y-3 pt-4 border-t border-[var(--color-brand-700)]">
                    <div className="relative">
                      <User className="w-4 h-4 text-[var(--color-brand-muted)] absolute left-3 top-1/2 -translate-y-1/2" />
                      <input type="text" required placeholder="Client Name" value={clientName} onChange={(e) => setClientName(e.target.value)} className="w-full bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] rounded-xl p-3 pl-10 text-white outline-none focus:border-[var(--color-brand-accent)]" />
                    </div>
                    <div className="relative">
                      <Phone className="w-4 h-4 text-[var(--color-brand-muted)] absolute left-3 top-1/2 -translate-y-1/2" />
                      <input type="tel" required placeholder="Phone Number" value={clientPhone} onChange={(e) => setClientPhone(e.target.value)} className="w-full bg-[var(--color-brand-900)] border border-[var(--color-brand-700)] rounded-xl p-3 pl-10 text-white outline-none focus:border-[var(--color-brand-accent)]" />
                    </div>
                 </div>
                 <button type="submit" disabled={isBooking || !bookTime || !bookService || !clientName || !clientPhone} className="w-full bg-[var(--color-brand-accent)] text-white font-bold p-3 rounded-xl mt-4 cursor-pointer disabled:opacity-50 hover:not-disabled:brightness-110">Confirm Appointment</button>
              </form>
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
                <button onClick={() => setShowManageDayModal(false)} className="text-[var(--color-brand-muted)] hover:text-white cursor-pointer"><X className="w-6 h-6" /></button>
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
                    <div className="bg-red-900/20 border border-red-900/50 p-4 rounded-xl text-red-400 text-sm font-semibold">
                      You are marked OFF for this entire day. Clients cannot book you.
                    </div>
                  ) : (
                    <div className="bg-[var(--color-brand-900)] p-4 rounded-xl border border-[var(--color-brand-700)] space-y-3">
                      <p className="text-xs text-[var(--color-brand-muted)] uppercase tracking-wider font-bold">Custom Working Hours</p>
                      <div className="flex items-center gap-3">
                        <input type="time" value={overrideStart} onChange={(e) => setOverrideStart(e.target.value)} className="w-full bg-[var(--color-brand-800)] text-white border border-[var(--color-brand-700)] rounded-lg p-2 outline-none [color-scheme:dark] cursor-pointer" />
                        <span className="text-[var(--color-brand-muted)]">to</span>
                        <input type="time" value={overrideEnd} onChange={(e) => setOverrideEnd(e.target.value)} className="w-full bg-[var(--color-brand-800)] text-white border border-[var(--color-brand-700)] rounded-lg p-2 outline-none [color-scheme:dark] cursor-pointer" />
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
                    <input type="time" required value={blockStart} onChange={(e) => setBlockStart(e.target.value)} className="w-full bg-[var(--color-brand-900)] text-white border border-[var(--color-brand-700)] rounded-lg p-3 outline-none [color-scheme:dark] cursor-pointer" />
                    <span className="text-[var(--color-brand-muted)]">to</span>
                    <input type="time" required value={blockEnd} onChange={(e) => setBlockEnd(e.target.value)} className="w-full bg-[var(--color-brand-900)] text-white border border-[var(--color-brand-700)] rounded-lg p-3 outline-none [color-scheme:dark] cursor-pointer" />
                  </div>
                  <button type="submit" disabled={isSavingOverride || !blockStart || !blockEnd} className="w-full bg-orange-600/20 text-orange-500 border border-orange-500/50 font-bold p-3 rounded-xl hover:bg-orange-600/40 transition-all cursor-pointer disabled:opacity-50">
                    Inject Block
                  </button>
                </form>

              </div>
           </div>
        </div>
      )}
    </div>
  )
}