import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Calendar as CalendarIcon, Clock, Scissors, User, Phone, CheckCircle2, CalendarPlus, Zap, FileText, Sun, Moon, ChevronLeft, ChevronRight, Plus, X } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { getAvailableSlots, getDayOfWeekFromDateString, getBarberDaySchedule, timeToMinutes, minutesToTime, DAYS_OF_WEEK } from '../../lib/slotEngine'

interface Service {
    id: string
    name: string
    duration_minutes: number
    price: number
}

type SlotObj = { time: string, barberId: string, barberName: string, serviceId?: string, durationMinutes?: number }

function getLocalTodayStr() {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function addDaysToDateStr(dateStr: string, days: number): string {
    const [y, m, d] = dateStr.split('-').map(Number)
    const dt = new Date(y, m - 1, d + days)
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}

function formatFriendlyDate(dateStr: string, timeStr: string) {
    const [year, month, day] = dateStr.split('-')
    const d = new Date(Number(year), Number(month) - 1, Number(day))
    const monthName = d.toLocaleString('en-US', { month: 'short' })
    const [hours, mins] = timeStr.split(':').map(Number)
    const ampm = hours >= 12 ? 'pm' : 'am'
    const h = hours % 12 || 12
    return `${monthName}. ${Number(day)}, ${year} at ${h}:${mins.toString().padStart(2, '0')}${ampm}`
}

function formatTime(timeStr: string) {
    if (!timeStr) return ''
    const [hours, mins] = timeStr.split(':').map(Number)
    const ampm = hours >= 12 ? 'PM' : 'AM'
    const h = hours % 12 || 12
    return `${h}:${mins.toString().padStart(2, '0')} ${ampm}`
}

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

export default function BarberCalendar() {
    const { barberId } = useParams()
    const navigate = useNavigate()
    const isWalkIn = barberId === 'walk-in'

    const [barberName, setBarberName] = useState('Loading...')
    const [services, setServices] = useState<Service[]>([])

    const [selectedServices, setSelectedServices] = useState<Service[]>([])
    const [isAddingMoreServices, setIsAddingMoreServices] = useState(false)
    const [selectedDate, setSelectedDate] = useState(() => getLocalTodayStr())

    const totalDurationMinutes = selectedServices.reduce((sum, s) => sum + s.duration_minutes, 0)
    const totalPrice = selectedServices.reduce((sum, s) => sum + Number(s.price || 0), 0)
    const combinedServiceNames = selectedServices.map(s => s.name).join(' + ')

    const [slots, setSlots] = useState<SlotObj[]>([])
    const [loadingSlots, setLoadingSlots] = useState(false)
    const [selectedSlot, setSelectedSlot] = useState<SlotObj | null>(null)
    const [selectedTimeGroup, setSelectedTimeGroup] = useState<string | null>(null)
    const autoScanPendingRef = useRef(false)
    const skipNextLoadRef = useRef<string | null>(null)

    const [isLight, setIsLight] = useState(() => {
        if (typeof document === 'undefined') return false
        return document.documentElement.classList.contains('light') || localStorage.getItem('lifestyle_theme') === 'light'
    })

    useEffect(() => {
        const syncTheme = () => {
            setIsLight(document.documentElement.classList.contains('light') || localStorage.getItem('lifestyle_theme') === 'light')
        }
        window.addEventListener('lifestyle-theme-change', syncTheme)
        window.addEventListener('storage', syncTheme)
        return () => {
            window.removeEventListener('lifestyle-theme-change', syncTheme)
            window.removeEventListener('storage', syncTheme)
        }
    }, [])

    const toggleTheme = () => {
        const nextLight = !document.documentElement.classList.contains('light')
        document.documentElement.classList.toggle('light', nextLight)
        localStorage.setItem('lifestyle_theme', nextLight ? 'light' : 'dark')
        window.dispatchEvent(new Event('lifestyle-theme-change'))
        setIsLight(nextLight)
    }

    // Group available slots by formatted time string (e.g., "10:00 AM")
    const groupedSlots = slots.reduce<Record<string, SlotObj[]>>((acc, slot) => {
        const formatted = formatTime(slot.time)
        if (!acc[formatted]) acc[formatted] = []
        acc[formatted].push(slot)
        return acc
    }, {})

    const uniqueTimes = Object.keys(groupedSlots)

    const handleSlotSelect = (slot: SlotObj) => {
        setSelectedSlot(slot)
    }

    const [clientName, setClientName] = useState('')
    const [clientPhone, setClientPhone] = useState('')
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [bookingComplete, setBookingComplete] = useState(false)
    const [notes, setNotes] = useState('')
    const [botTrap, setBotTrap] = useState('')

    // 1. Fetch Data: Handles Specific Barber OR Shop-Wide Walk-In
    useEffect(() => {
        async function fetchData() {
            if (!barberId) return

            if (isWalkIn) {
                setBarberName('Next Available Barber')
                const { data: allServices } = await supabase.from('services').select('*').eq('is_active', true)
                if (allServices) {
                    // Deduplicate services by name so the lobby iPad doesn't show 3 identical "Haircut" options
                    const unique = Array.from(new Map(allServices.map(item => [item.name, item])).values())
                    setServices(unique)
                }
            } else {
                const [barberRes, servicesRes] = await Promise.all([
                    supabase.from('barbers').select('name').eq('id', barberId).single(),
                    supabase.from('services').select('*').eq('barber_id', barberId).eq('is_active', true)
                ])
                if (barberRes.data) setBarberName(barberRes.data.name)
                if (servicesRes.data) setServices(servicesRes.data)
            }
        }
        fetchData()
    }, [barberId, isWalkIn])

    // Clear selectedTimeGroup and selectedSlot whenever selectedServices changes
    useEffect(() => {
        setSelectedTimeGroup(null)
        setSelectedSlot(null)
    }, [selectedServices])

    // 2. Load Slots: Calculates Math for One Barber OR Scans Entire Shop (+ 14-day auto-scan on service select)
    useEffect(() => {
        let cancelled = false

        async function fetchSlotsForDate(targetDate: string, chosenServices: Service[]): Promise<SlotObj[]> {
            if (!barberId || chosenServices.length === 0) return []
            const stackedDuration = chosenServices.reduce((sum, s) => sum + s.duration_minutes, 0)

            if (isWalkIn) {
                const { data: allBarbers } = await supabase.from('barbers').select('*').eq('is_active', true)
                const barberResults = await Promise.all(
                    (allBarbers || []).map(async (b) => {
                        const { data: barberServices } = await supabase
                            .from('services')
                            .select('id, name, duration_minutes')
                            .eq('barber_id', b.id)
                            .eq('is_active', true)
                        if (!barberServices || barberServices.length === 0) return []

                        // Verify this barber offers every service name in chosenServices
                        const offersAll = chosenServices.every(sel =>
                            barberServices.some(bs => bs.name === sel.name)
                        )
                        if (!offersAll) return []

                        const barberTotalDuration = chosenServices.reduce((sum, sel) => {
                            const matched = barberServices.find(bs => bs.name === sel.name)
                            return sum + (matched ? matched.duration_minutes : sel.duration_minutes)
                        }, 0)
                        const firstMatchedService = barberServices.find(bs => bs.name === chosenServices[0].name)
                        if (!firstMatchedService) return []

                        const times = await getAvailableSlots(b.id, targetDate, barberTotalDuration)
                        return times.map(t => ({
                            time: t,
                            barberId: b.id,
                            barberName: b.name,
                            serviceId: firstMatchedService.id,
                            durationMinutes: barberTotalDuration
                        }))
                    })
                )
                const combinedSlots = barberResults.flat()
                combinedSlots.sort((a, b) => a.time.localeCompare(b.time))
                return combinedSlots
            } else {
                const times = await getAvailableSlots(barberId, targetDate, stackedDuration)
                return times.map(t => ({
                    time: t,
                    barberId: barberId,
                    barberName: barberName,
                    serviceId: chosenServices[0].id,
                    durationMinutes: stackedDuration
                }))
            }
        }

        async function loadSlots() {
            if (!barberId || !selectedDate || selectedServices.length === 0 || isAddingMoreServices) return

            if (skipNextLoadRef.current === selectedDate) {
                skipNextLoadRef.current = null
                return
            }

            setLoadingSlots(true)
            const todayStr = getLocalTodayStr()
            const initialSlots = await fetchSlotsForDate(selectedDate, selectedServices)
            if (cancelled) return

            if (initialSlots.length === 0 && autoScanPendingRef.current && selectedDate === todayStr) {
                autoScanPendingRef.current = false
                for (let offset = 1; offset <= 14; offset++) {
                    const candidateDate = addDaysToDateStr(todayStr, offset)
                    const nextSlots = await fetchSlotsForDate(candidateDate, selectedServices)
                    if (cancelled) return
                    if (nextSlots.length > 0) {
                        skipNextLoadRef.current = candidateDate
                        setSlots(nextSlots)
                        setSelectedDate(candidateDate)
                        setLoadingSlots(false)
                        return
                    }
                }
            } else {
                autoScanPendingRef.current = false
            }

            setSlots(initialSlots)
            setLoadingSlots(false)
        }

        loadSlots()
        return () => {
            cancelled = true
        }
    }, [barberId, selectedDate, selectedServices, isAddingMoreServices, isWalkIn, barberName])

    const handleBack = () => {
        if (selectedSlot) {
            setSelectedSlot(null)
        } else if (selectedTimeGroup) {
            setSelectedTimeGroup(null)
        } else if (selectedServices.length > 0 && !isAddingMoreServices) {
            setIsAddingMoreServices(true)
            setSelectedTimeGroup(null)
        } else {
            navigate(-1)
        }
    }

    const handleBooking = async (e: React.FormEvent) => {
        e.preventDefault()

        // Silently block spam bots filling the hidden honeypot field
        if (botTrap.trim() !== '') {
            return
        }

        if (!clientName || !clientPhone || !selectedSlot || selectedServices.length === 0) return

        const liveName = clientName.trim()
        const livePhone = cleanPhone(clientPhone)
        const trimmedNotes = notes.trim()

        if (livePhone.length !== 10) {
            alert('Please enter a valid 10-digit phone number.')
            return
        }

        setIsSubmitting(true)

        try {
            const [hours, minutes] = selectedSlot.time.split(':').map(Number)
            const serviceDuration = selectedSlot.durationMinutes || totalDurationMinutes
            const totalMinutes = hours * 60 + minutes + serviceDuration
            const endHours = Math.floor(totalMinutes / 60)
            const endMins = totalMinutes % 60
            const startTimeStr = `${selectedSlot.time}:00`
            const endTimeStr = `${endHours.toString().padStart(2, '0')}:${endMins.toString().padStart(2, '0')}:00`

            // Enforce Barber Working Hours Availability
            const { data: barberData } = await supabase
                .from('barbers')
                .select('working_hours')
                .eq('id', selectedSlot.barberId)
                .maybeSingle()

            const dayOfWeek = getDayOfWeekFromDateString(selectedDate)
            const daySchedule = getBarberDaySchedule(barberData?.working_hours, dayOfWeek)

            const { data: override } = await supabase
                .from('schedule_overrides')
                .select('*')
                .eq('barber_id', selectedSlot.barberId)
                .eq('override_date', selectedDate)
                .maybeSingle()

            if (override?.is_off) {
                alert("This barber is marked OFF on this date.")
                setIsSubmitting(false)
                return
            }

            const shiftStart = override?.start_time ? timeToMinutes(override.start_time) : daySchedule ? timeToMinutes(daySchedule.start_time) : null
            const shiftEnd = override?.end_time ? timeToMinutes(override.end_time) : daySchedule ? timeToMinutes(daySchedule.end_time) : null
            const isShiftWorking = override ? !override.is_off : daySchedule ? daySchedule.isWorking : true

            if (!isShiftWorking) {
                alert(`This barber is not scheduled to work on ${DAYS_OF_WEEK[dayOfWeek].name}s.`)
                setIsSubmitting(false)
                return
            }

            if (shiftStart !== null && shiftEnd !== null) {
                const proposedStart = hours * 60 + minutes
                const proposedEnd = totalMinutes
                if (proposedStart < shiftStart || proposedEnd > shiftEnd) {
                    alert(`Requested time is outside barber's working hours (${minutesToTime(shiftStart)} - ${minutesToTime(shiftEnd)}).`)
                    setIsSubmitting(false)
                    return
                }
            }

            const finalNotes = selectedServices.length > 1
                ? (trimmedNotes
                    ? `[Services: ${combinedServiceNames} ($${totalPrice})] ${trimmedNotes}`
                    : `[Services: ${combinedServiceNames} ($${totalPrice})]`)
                : (trimmedNotes || null)

            // Secure SECURITY DEFINER RPC: handles rate-limiting, overlap guard, client upsert (preserving notes), and appointment insert
            const { data: appointmentId, error: rpcErr } = await supabase.rpc('book_client_appointment', {
                p_name: liveName,
                p_phone: livePhone,
                p_barber_id: selectedSlot.barberId,
                p_service_id: selectedSlot.serviceId || selectedServices[0].id,
                p_appointment_date: selectedDate,
                p_start_time: startTimeStr,
                p_end_time: endTimeStr,
                p_notes: finalNotes,
                p_is_walk_in: isWalkIn
            })
            if (rpcErr) throw rpcErr
            if (!appointmentId) throw new Error('Appointment ID was not returned by the database.')

            try {
                console.log("Dispatching live SMS confirmation...")
                const friendlyDate = new Date(selectedDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
                await supabase.functions.invoke('twilio-sms', {
                    body: {
                        to: clientPhone,
                        message: `LifeStyle Barber: Your appointment for ${combinedServiceNames} with ${selectedSlot.barberName} is confirmed for ${friendlyDate} at ${formatTime(selectedSlot.time)}. Reply CANCEL to cancel. Reply STOP to unsubscribe.`
                    }
                })
            } catch (smsErr) {
                console.error("SMS Dispatch Failed:", smsErr)
            }

            setClientName('')
            setClientPhone('')
            setNotes('')
            setBotTrap('')
            setBookingComplete(true)
        } catch (error: any) {
            console.error("Booking failed:", error)
            alert(`Error securing your appointment. Please try again.${error?.message ? `\n\n(${error.message})` : ''}`)
        } finally {
            setIsSubmitting(false)
        }
    }

    const handleAddToCalendar = () => {
        if (!selectedDate || !selectedSlot || selectedServices.length === 0) return
        const [hours, minutes] = selectedSlot.time.split(':').map(Number)
        const totalMins = hours * 60 + minutes + (selectedSlot.durationMinutes || totalDurationMinutes)
        const endH = Math.floor(totalMins / 60)
        const endM = totalMins % 60

        const formatDateForICS = (dateString: string, h: number, m: number) => {
            const cleanDate = dateString.replace(/-/g, '')
            const cleanTime = `${h.toString().padStart(2, '0')}${m.toString().padStart(2, '0')}00`
            return `${cleanDate}T${cleanTime}`
        }

        const icsContent = [
            'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT',
            `DTSTART:${formatDateForICS(selectedDate, hours, minutes)}`,
            `DTEND:${formatDateForICS(selectedDate, endH, endM)}`,
            `SUMMARY:${combinedServiceNames} with ${selectedSlot.barberName}`,
            `DESCRIPTION:${combinedServiceNames} at LifeStyle Barber`,
            'END:VEVENT', 'END:VCALENDAR'
        ].join('\n')

        const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' })
        const link = document.createElement('a')
        link.href = window.URL.createObjectURL(blob)
        link.setAttribute('download', `lifestyle-barber-${selectedDate}.ics`)
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
    }

    const isServiceSelectionStep = selectedServices.length === 0 || isAddingMoreServices
    const currentStep = isServiceSelectionStep ? 1 : !selectedSlot ? 2 : 3
    const todayStr = getLocalTodayStr()

    if (bookingComplete) {
        return (
            <div className="min-h-screen bg-[var(--color-brand-900)] text-[var(--color-brand-light)] font-sans flex flex-col items-center justify-center p-6 text-center relative">
                <button
                    type="button"
                    onClick={toggleTheme}
                    aria-label={isLight ? 'Switch to Dark Mode' : 'Switch to Light Mode'}
                    title={isLight ? 'Switch to Dark Mode' : 'Switch to Light Mode'}
                    className="absolute top-6 right-6 p-2.5 rounded-full bg-[var(--color-brand-periwinkle)]/15 border border-[var(--color-brand-periwinkle)]/60 text-[var(--color-brand-periwinkle)] hover:bg-[var(--color-brand-periwinkle)] hover:text-white transition-all cursor-pointer shadow-sm"
                >
                    {isLight ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
                </button>
                <CheckCircle2 className="w-20 h-20 text-[var(--color-brand-gold)] mb-6 animate-in zoom-in duration-500" />
                <h1 className="text-3xl font-bold mb-2">You're Booked!</h1>
                <p className="text-[var(--color-brand-muted)] mb-8 text-lg">
                    We will see you on <br />
                    <span className="text-[var(--color-brand-light)] font-bold">
                        {formatFriendlyDate(selectedDate, selectedSlot!.time)}
                    </span>
                    <br /><span className="text-sm mt-2 block opacity-80">with {selectedSlot!.barberName}</span>
                </p>
                <div className="w-full max-w-xs flex flex-col gap-4">
                    <button onClick={handleAddToCalendar} className="w-full bg-[var(--color-brand-accent)] text-white flex items-center justify-center gap-2 px-8 py-4 rounded-xl hover:brightness-110 transition-all font-bold shadow-[0_0_20px_rgba(168,85,247,0.3)] cursor-pointer">
                        <CalendarPlus className="w-5 h-5" /> Add to Calendar
                    </button>
                    <button onClick={() => {
                        setSelectedSlot(null)
                        setClientName('')
                        setClientPhone('')
                        setNotes('')
                        setBotTrap('')
                        setSelectedServices([])
                        setIsAddingMoreServices(false)
                        setBookingComplete(false)
                        navigate('/')
                    }} className="w-full bg-[var(--color-brand-periwinkle)]/15 border border-[var(--color-brand-periwinkle)]/60 text-[var(--color-brand-periwinkle)] px-8 py-4 rounded-xl hover:bg-[var(--color-brand-periwinkle)] hover:text-white transition-all font-semibold cursor-pointer">
                        Return to Home
                    </button>
                </div>
            </div>
        )
    }

    return (
        <div className="min-h-screen bg-[var(--color-brand-900)] text-[var(--color-brand-light)] font-sans flex flex-col p-6 max-w-md mx-auto">
            <header className="flex items-center justify-between gap-3 mb-8 pt-4">
                <div className="flex items-center gap-3.5 min-w-0">
                    <button
                        onClick={handleBack}
                        aria-label={isServiceSelectionStep ? 'Back to Barbers' : !selectedSlot ? (selectedTimeGroup ? 'Back to Times' : 'Back to Services') : 'Back to Times'}
                        className="p-3 bg-[var(--color-brand-periwinkle)]/15 border border-[var(--color-brand-periwinkle)]/60 text-[var(--color-brand-periwinkle)] rounded-full hover:bg-[var(--color-brand-periwinkle)] hover:text-white transition-all cursor-pointer flex-shrink-0 shadow-sm"
                    >
                        <ArrowLeft className="w-5 h-5" />
                    </button>
                    <div className="min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                            <span className="text-[10px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-[var(--color-brand-periwinkle)]/15 border border-[var(--color-brand-periwinkle)]/60 text-[var(--color-brand-periwinkle)]">
                                Step {currentStep} of 3
                            </span>
                        </div>
                        <h1 className="text-2xl font-bold tracking-tight truncate">
                            {selectedSlot ? "Your Details" : (selectedServices.length > 0 && !isAddingMoreServices) ? (selectedTimeGroup ? "Select Barber" : "Select Time") : "Select Service"}
                        </h1>
                        <p className="text-[var(--color-brand-muted)] text-sm flex items-center gap-1 truncate">
                            {isWalkIn && !selectedSlot ? <><Zap className="w-3 h-3 text-[var(--color-brand-gold)] flex-shrink-0"/> Kiosk Mode</> : `Booking with ${selectedSlot ? selectedSlot.barberName : barberName}`}
                        </p>
                    </div>
                </div>

                <button
                    type="button"
                    onClick={toggleTheme}
                    aria-label={isLight ? 'Switch to Dark Mode' : 'Switch to Light Mode'}
                    title={isLight ? 'Switch to Dark Mode' : 'Switch to Light Mode'}
                    className="p-2.5 rounded-full bg-[var(--color-brand-periwinkle)]/15 border border-[var(--color-brand-periwinkle)]/60 text-[var(--color-brand-periwinkle)] hover:bg-[var(--color-brand-periwinkle)] hover:text-white transition-all cursor-pointer flex-shrink-0 shadow-sm"
                >
                    {isLight ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
                </button>
            </header>

            {isServiceSelectionStep ? (
                <div className="space-y-4 animate-in fade-in slide-in-from-right-4">
                    {selectedServices.length > 0 && (
                        <div className="card-violet-gold backdrop-blur-md p-5 rounded-2xl space-y-3.5 border border-[#D4AF37]/60 shadow-lg">
                            <div className="flex items-center justify-between">
                                <span className="text-xs font-bold uppercase tracking-wider text-[var(--color-brand-gold)] flex items-center gap-1.5">
                                    <Scissors className="w-3.5 h-3.5" /> Your Service Lineup
                                </span>
                                <span className="text-xs font-bold text-[var(--color-brand-muted)]">
                                    {selectedServices.length} {selectedServices.length === 1 ? 'Service' : 'Services'} • {totalDurationMinutes} mins • ${totalPrice}
                                </span>
                            </div>

                            <div className="space-y-2">
                                {selectedServices.map((svc, idx) => (
                                    <div
                                        key={`${svc.id}-${idx}`}
                                        className="flex items-center justify-between gap-2 bg-[var(--color-brand-900)]/60 border border-[var(--color-brand-700)]/70 px-3.5 py-2.5 rounded-xl"
                                    >
                                        <div className="min-w-0">
                                            <p className="text-sm font-bold text-[var(--color-brand-light)] truncate">{svc.name}</p>
                                            <p className="text-xs text-[var(--color-brand-muted)]">
                                                {svc.duration_minutes} mins • <span className="text-[var(--color-brand-gold)] font-semibold">${svc.price}</span>
                                            </p>
                                        </div>
                                        <button
                                            type="button"
                                            aria-label={`Remove ${svc.name}`}
                                            onClick={() => {
                                                setSelectedServices(prev => {
                                                    const next = prev.filter((_, i) => i !== idx)
                                                    if (next.length === 0) setIsAddingMoreServices(false)
                                                    return next
                                                })
                                            }}
                                            className="p-1.5 rounded-lg text-[var(--color-brand-muted)] hover:text-red-400 hover:bg-red-500/15 transition-colors cursor-pointer flex-shrink-0"
                                        >
                                            <X className="w-4 h-4" />
                                        </button>
                                    </div>
                                ))}
                            </div>

                            <button
                                type="button"
                                onClick={() => {
                                    autoScanPendingRef.current = true
                                    setSelectedDate(getLocalTodayStr())
                                    setIsAddingMoreServices(false)
                                    setSelectedTimeGroup(null)
                                }}
                                className="w-full bg-[var(--color-brand-accent)] text-white font-bold py-3.5 px-4 rounded-xl hover:brightness-110 transition-all shadow-[0_0_16px_rgba(168,85,247,0.3)] cursor-pointer flex items-center justify-center gap-2 text-sm sm:text-base"
                            >
                                Continue to Select Time →
                            </button>

                            <p className="text-[11px] text-center text-[var(--color-brand-muted)]">
                                Or tap another service below to stack onto this booking:
                            </p>
                        </div>
                    )}

                    {services.map(service => (
                        <button
                            key={service.id}
                            onClick={() => {
                                setSelectedServices(prev => [...prev, service])
                                setIsAddingMoreServices(true)
                                setSelectedTimeGroup(null)
                            }}
                            className="w-full card-violet-gold transition-all p-6 rounded-2xl flex items-center justify-between group cursor-pointer backdrop-blur-md"
                        >
                            <div className="text-left">
                                <h2 className="text-lg font-bold">{service.name}</h2>
                                <p className="text-sm text-[var(--color-brand-muted)]">{service.duration_minutes} Minutes</p>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="text-lg font-bold text-[var(--color-brand-gold)] bg-[var(--color-brand-900)]/60 border border-[#D4AF37]/50 px-3 py-1 rounded-xl">
                                    ${service.price}
                                </div>
                            </div>
                        </button>
                    ))}
                </div>
            ) : !selectedSlot ? (
                <div className="animate-in fade-in slide-in-from-right-4 duration-300">
                    <div className="card-violet-gold backdrop-blur-md p-4 rounded-2xl mb-6 space-y-3">
                        <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                                <p className="text-xs text-[var(--color-brand-muted)] uppercase tracking-wider font-bold mb-1">
                                    {selectedServices.length > 1 ? `Selected Services (${selectedServices.length})` : 'Selected Service'}
                                </p>
                                <p className="font-bold text-sm sm:text-base leading-snug">{combinedServiceNames}</p>
                                <p className="text-xs text-[var(--color-brand-gold)] font-semibold mt-0.5">
                                    {totalDurationMinutes}m • ${totalPrice}
                                </p>
                            </div>
                            <div className="p-2 rounded-full bg-[var(--color-brand-900)]/70 border border-[#D4AF37]/60 flex-shrink-0">
                                <Scissors className="w-4 h-4 text-[var(--color-brand-gold)]" />
                            </div>
                        </div>
                        <div className="flex items-center gap-2 pt-1 border-t border-[var(--color-brand-700)]/50">
                            <button
                                type="button"
                                onClick={() => setIsAddingMoreServices(true)}
                                className="flex-1 flex items-center justify-center gap-1.5 text-xs font-bold text-[var(--color-brand-periwinkle)] hover:text-white px-3 py-2 rounded-xl bg-[var(--color-brand-periwinkle)]/15 border border-[var(--color-brand-periwinkle)]/60 hover:bg-[var(--color-brand-periwinkle)] transition-all cursor-pointer"
                            >
                                <Plus className="w-3.5 h-3.5" /> Add Another Service
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    setSelectedServices([])
                                    setIsAddingMoreServices(false)
                                    setSelectedTimeGroup(null)
                                    setSlots([])
                                }}
                                className="text-xs font-bold text-[var(--color-brand-muted)] hover:text-[var(--color-brand-light)] px-3 py-2 rounded-xl bg-[var(--color-brand-900)]/50 border border-[var(--color-brand-700)] transition-all cursor-pointer"
                            >
                                Clear
                            </button>
                        </div>
                    </div>

                    <div className="card-violet-gold backdrop-blur-md p-4 rounded-2xl mb-8">
                        <label className="flex items-center gap-2 text-[var(--color-brand-muted)] text-sm font-semibold mb-3 uppercase tracking-wider">
                            <CalendarIcon className="w-4 h-4 text-[var(--color-brand-periwinkle)]" /> Choose Date
                        </label>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                aria-label="Previous day"
                                disabled={selectedDate <= todayStr}
                                onClick={() => {
                                    const prev = addDaysToDateStr(selectedDate, -1)
                                    if (prev >= todayStr) {
                                        setSelectedDate(prev)
                                        setSelectedTimeGroup(null)
                                    }
                                }}
                                className="p-3 rounded-xl bg-[var(--color-brand-periwinkle)]/15 border border-[var(--color-brand-periwinkle)]/60 text-[var(--color-brand-periwinkle)] hover:bg-[var(--color-brand-periwinkle)] hover:text-white transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed flex-shrink-0"
                            >
                                <ChevronLeft className="w-4 h-4" />
                            </button>
                            <input
                                type="date"
                                value={selectedDate}
                                min={todayStr}
                                onChange={(e) => {
                                    setSelectedDate(e.target.value)
                                    setSelectedTimeGroup(null)
                                }}
                                className={`flex-1 min-w-0 bg-[var(--color-brand-900)]/70 text-[var(--color-brand-light)] border border-[var(--color-brand-700)] rounded-xl p-3 outline-none focus:border-[var(--color-brand-periwinkle)] transition-colors cursor-pointer ${
                                    isLight ? '[color-scheme:light]' : '[color-scheme:dark]'
                                }`}
                            />
                            <button
                                type="button"
                                aria-label="Next day"
                                onClick={() => {
                                    setSelectedDate(addDaysToDateStr(selectedDate, 1))
                                    setSelectedTimeGroup(null)
                                }}
                                className="p-3 rounded-xl bg-[var(--color-brand-periwinkle)]/15 border border-[var(--color-brand-periwinkle)]/60 text-[var(--color-brand-periwinkle)] hover:bg-[var(--color-brand-periwinkle)] hover:text-white transition-all cursor-pointer flex-shrink-0"
                            >
                                <ChevronRight className="w-4 h-4" />
                            </button>
                        </div>
                    </div>

                    <div>
                        {loadingSlots ? (
                            <div className="text-center text-[var(--color-brand-muted)] animate-pulse py-8">Scanning schedules...</div>
                        ) : slots.length === 0 ? (
                            <div className="text-center card-violet-gold backdrop-blur-md rounded-2xl p-8">
                                <p className="text-[var(--color-brand-muted)] mb-2">No availability on this date.</p>
                            </div>
                        ) : !selectedTimeGroup ? (
                            <div className="animate-in fade-in duration-200">
                                <h2 className="text-lg font-bold mb-4 flex items-center gap-2">
                                    <Clock className="w-5 h-5 text-[var(--color-brand-accent)]" /> Available Times
                                </h2>

                                <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                                    {uniqueTimes.map(timeStr => (
                                        <button
                                            key={timeStr}
                                            type="button"
                                            onClick={() => setSelectedTimeGroup(timeStr)}
                                            className="bg-[var(--color-brand-800)]/95 backdrop-blur-sm border border-[var(--color-brand-700)] border-t-[#D4AF37]/60 text-[var(--color-brand-light)] font-bold p-3.5 rounded-xl hover:bg-[var(--color-brand-accent)] hover:border-[#D4AF37] hover:text-white hover:shadow-[0_0_12px_rgba(212,175,55,0.28)] transition-all shadow-sm cursor-pointer flex flex-col items-center justify-center active:scale-95 group"
                                        >
                                            <span className="text-base sm:text-lg tracking-tight font-bold">{timeStr}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        ) : (
                            <div className="animate-in fade-in slide-in-from-right-4 duration-200 space-y-4">
                                <div className="flex items-center justify-between gap-2 mb-3">
                                    <div>
                                        <h2 className="text-lg font-bold flex items-center gap-2">
                                            <Clock className="w-5 h-5 text-[var(--color-brand-accent)]" /> Available at {selectedTimeGroup}
                                        </h2>
                                        <p className="text-xs text-[var(--color-brand-muted)]">
                                            Choose your barber for this slot
                                        </p>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => setSelectedTimeGroup(null)}
                                        className="text-xs font-bold text-[var(--color-brand-periwinkle)] hover:text-white flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[var(--color-brand-periwinkle)]/15 border border-[var(--color-brand-periwinkle)]/60 hover:bg-[var(--color-brand-periwinkle)] transition-all cursor-pointer shadow-sm flex-shrink-0"
                                    >
                                        <ArrowLeft className="w-3.5 h-3.5" /> Back to Times
                                    </button>
                                </div>

                                <div className="space-y-3">
                                    {(groupedSlots[selectedTimeGroup] || []).map((slot, index) => (
                                        <button
                                            key={`${index}-${slot.barberId}`}
                                            type="button"
                                            onClick={() => handleSlotSelect(slot)}
                                            className="w-full card-violet-gold backdrop-blur-md p-4 rounded-2xl flex items-center justify-between group cursor-pointer transition-all active:scale-[0.99]"
                                        >
                                            <div className="flex items-center gap-3.5 text-left">
                                                <div className="bg-[var(--color-brand-900)] p-3 rounded-full border border-[#D4AF37]/60 shadow-[0_0_10px_rgba(212,175,55,0.2)] transition-colors">
                                                    <Scissors className="w-5 h-5 text-[var(--color-brand-gold)]" />
                                                </div>
                                                <div>
                                                    <h3 className="font-bold text-base text-[var(--color-brand-light)] group-hover:text-[var(--color-brand-accent)] transition-colors">
                                                        {slot.barberName}
                                                    </h3>
                                                    <p className="text-xs text-[var(--color-brand-muted)] font-medium">
                                                        {combinedServiceNames} • {slot.durationMinutes || totalDurationMinutes}m
                                                    </p>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <span className="text-xs font-bold text-[var(--color-brand-accent)] bg-[var(--color-brand-accent)]/10 px-3 py-1.5 rounded-lg border border-[var(--color-brand-accent)]/30 group-hover:bg-[var(--color-brand-accent)] group-hover:text-white transition-colors">
                                                    Select
                                                </span>
                                                <span className="text-[var(--color-brand-periwinkle)] group-hover:translate-x-0.5 transition-transform text-sm">
                                                    ❯
                                                </span>
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            ) : (
                <form onSubmit={handleBooking} className="animate-in fade-in slide-in-from-right-4 duration-300">
                    {/* Hidden anti-spam honeypot field */}
                    <div className="hidden" aria-hidden="true">
                        <input
                            type="text"
                            name="website"
                            tabIndex={-1}
                            autoComplete="off"
                            value={botTrap}
                            onChange={(e) => setBotTrap(e.target.value)}
                        />
                    </div>

                    <div className="card-violet-gold backdrop-blur-md p-4 rounded-2xl mb-8 space-y-3">
                        <div className="flex items-center justify-between gap-2">
                            <p className="text-xs text-[var(--color-brand-gold)] uppercase tracking-wider font-bold">Appointment Summary</p>
                            <button
                                type="button"
                                onClick={() => setSelectedSlot(null)}
                                className="text-xs font-bold text-[var(--color-brand-periwinkle)] hover:text-white px-2.5 py-1 rounded-lg bg-[var(--color-brand-periwinkle)]/15 border border-[var(--color-brand-periwinkle)]/60 hover:bg-[var(--color-brand-periwinkle)] transition-all cursor-pointer"
                            >
                                Back to Times
                            </button>
                        </div>

                        <div className="space-y-1.5 pt-1">
                            {selectedServices.map((svc, idx) => (
                                <div key={`${svc.id}-${idx}`} className="flex items-center justify-between text-sm">
                                    <span className="font-bold text-[var(--color-brand-light)]">{svc.name}</span>
                                    <span className="text-xs text-[var(--color-brand-muted)]">
                                        {svc.duration_minutes} mins • <span className="text-[var(--color-brand-gold)] font-semibold">${svc.price}</span>
                                    </span>
                                </div>
                            ))}
                        </div>

                        <div className="flex items-center justify-between pt-2 border-t border-[var(--color-brand-700)]/60 text-xs sm:text-sm font-bold">
                            <span className="text-[var(--color-brand-muted)]">Combined Total</span>
                            <span className="text-[var(--color-brand-gold)]">{totalDurationMinutes} mins • ${totalPrice}</span>
                        </div>

                        <p className="text-sm text-[var(--color-brand-muted)] pt-1">{formatFriendlyDate(selectedDate, selectedSlot.time)}</p>
                    </div>

                    <div className="space-y-4 mb-8">
                        <div className="relative">
                            <User className="w-5 h-5 text-[var(--color-brand-muted)] absolute left-4 top-1/2 -translate-y-1/2" />
                            <input required type="text" placeholder="First & Last Name" value={clientName} onChange={(e) => setClientName(e.target.value)} className="w-full bg-[var(--color-brand-800)]/90 text-[var(--color-brand-light)] border border-[var(--color-brand-700)] rounded-xl p-4 pl-12 outline-none focus:border-[var(--color-brand-accent)] transition-colors backdrop-blur-md" />
                        </div>
                        <div className="relative">
                            <Phone className="w-5 h-5 text-[var(--color-brand-muted)] absolute left-4 top-1/2 -translate-y-1/2" />
                            <input required type="tel" placeholder="Phone Number" value={clientPhone} onChange={(e) => setClientPhone(e.target.value)} className="w-full bg-[var(--color-brand-800)]/90 text-[var(--color-brand-light)] border border-[var(--color-brand-700)] rounded-xl p-4 pl-12 outline-none focus:border-[var(--color-brand-accent)] transition-colors backdrop-blur-md" />
                        </div>
                        <div className="relative">
                            <FileText className="w-5 h-5 text-[var(--color-brand-muted)] absolute left-4 top-4" />
                            <textarea placeholder="Notes for Barber (Optional)" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className="w-full bg-[var(--color-brand-800)]/90 text-[var(--color-brand-light)] border border-[var(--color-brand-700)] rounded-xl p-4 pl-12 outline-none focus:border-[var(--color-brand-accent)] transition-colors backdrop-blur-md resize-none"></textarea>
                        </div>
                    </div>

                    <button type="submit" disabled={isSubmitting} className="w-full bg-[var(--color-brand-accent)] text-white font-bold text-lg p-4 rounded-xl hover:brightness-110 transition-all shadow-[0_0_20px_rgba(168,85,247,0.3)] cursor-pointer disabled:opacity-50">
                        {isSubmitting ? "Securing Slot..." : "Confirm Booking"}
                    </button>
                </form>
            )}
        </div>
    )
}