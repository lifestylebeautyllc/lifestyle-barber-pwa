import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Calendar as CalendarIcon, Clock, Scissors, User, Phone, CheckCircle2, CalendarPlus, Zap, FileText } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { getAvailableSlots, getDayOfWeekFromDateString, getBarberDaySchedule, timeToMinutes, minutesToTime, DAYS_OF_WEEK } from '../../lib/slotEngine'

interface Service {
    id: string
    name: string
    duration_minutes: number
    price: number
}

type SlotObj = { time: string, barberId: string, barberName: string }

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

export default function BarberCalendar() {
    const { barberId } = useParams()
    const navigate = useNavigate()
    const isWalkIn = barberId === 'walk-in'

    const [barberName, setBarberName] = useState('Loading...')
    const [services, setServices] = useState<Service[]>([])

    const [selectedService, setSelectedService] = useState<Service | null>(null)
    const [selectedDate, setSelectedDate] = useState(() => {
        const d = new Date()
        d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
        return d.toISOString().split('T')[0]
    })

    const [slots, setSlots] = useState<SlotObj[]>([])
    const [loadingSlots, setLoadingSlots] = useState(false)
    const [selectedSlot, setSelectedSlot] = useState<SlotObj | null>(null)
    const [selectedTimeGroup, setSelectedTimeGroup] = useState<string | null>(null)

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

    // 2. Load Slots: Calculates Math for One Barber OR Scans Entire Shop
    useEffect(() => {
        async function loadSlots() {
            if (!barberId || !selectedDate || !selectedService) return
            setLoadingSlots(true)

            if (isWalkIn) {
                const { data: allBarbers } = await supabase.from('barbers').select('*').eq('is_active', true)
                let combinedSlots: SlotObj[] = []

                for (const b of allBarbers || []) {
                    const { data: bService } = await supabase.from('services').select('duration_minutes').eq('barber_id', b.id).eq('name', selectedService.name).maybeSingle()
                    if (bService) {
                        const times = await getAvailableSlots(b.id, selectedDate, bService.duration_minutes)
                        combinedSlots.push(...times.map(t => ({ time: t, barberId: b.id, barberName: b.name })))
                    }
                }
                combinedSlots.sort((a, b) => a.time.localeCompare(b.time))
                setSlots(combinedSlots)
            } else {
                const times = await getAvailableSlots(barberId, selectedDate, selectedService.duration_minutes)
                setSlots(times.map(t => ({ time: t, barberId: barberId, barberName: barberName })))
            }
            setLoadingSlots(false)
        }
        loadSlots()
    }, [barberId, selectedDate, selectedService, isWalkIn, barberName])

    const handleBack = () => {
        if (selectedSlot) {
            setSelectedSlot(null)
        } else if (selectedTimeGroup) {
            setSelectedTimeGroup(null)
        } else if (selectedService) {
            setSelectedService(null)
            setSelectedTimeGroup(null)
            setSlots([])
        } else {
            navigate(-1)
        }
    }

    const handleBooking = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!clientName || !clientPhone || !selectedSlot) return
        setIsSubmitting(true)

        try {
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

            const [hours, minutes] = selectedSlot.time.split(':').map(Number)
            const totalMinutes = hours * 60 + minutes + selectedService!.duration_minutes
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

            // --- STEP B: Use the freshly returned client id — nothing cached, nothing hardcoded ---
            const { error: apptErr } = await supabase.from('appointments').insert({
                barber_id: selectedSlot.barberId,
                client_id: clientData.id,
                appointment_date: selectedDate,
                start_time: startTimeStr,
                end_time: endTimeStr,
                status: isWalkIn ? 'walk-in' : 'booked', // Automatically tag iPad lobby bookings as Walk-Ins
                notes: notes.trim() || null
            })
            if (apptErr) throw apptErr

            try {
                console.log("Dispatching live SMS confirmation...")
                const friendlyDate = new Date(selectedDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
                await supabase.functions.invoke('twilio-sms', {
                    body: {
                        to: clientPhone,
                        message: `LifeStyle Barber: Your haircut with ${selectedSlot.barberName} is confirmed for ${friendlyDate} at ${formatTime(selectedSlot.time)}. Reply CANCEL to cancel. Reply STOP to unsubscribe.`
                    }
                })
            } catch (smsErr) {
                console.error("SMS Dispatch Failed:", smsErr)
            }

            setClientName('')
            setClientPhone('')
            setNotes('')
            setBookingComplete(true)
        } catch (error: any) {
            console.error("Booking failed:", error)
            alert(`Error securing your appointment. Please try again.${error?.message ? `\n\n(${error.message})` : ''}`)
        } finally {
            setIsSubmitting(false)
        }
    }

    const handleAddToCalendar = () => {
        if (!selectedDate || !selectedSlot || !selectedService) return
        const [hours, minutes] = selectedSlot.time.split(':').map(Number)
        const totalMins = hours * 60 + minutes + selectedService.duration_minutes
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
            `SUMMARY:Haircut with ${selectedSlot.barberName}`,
            `DESCRIPTION:${selectedService.name} at LifeStyle Barber`,
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

    if (bookingComplete) {
        return (
            <div className="min-h-screen text-[var(--color-brand-light)] font-sans flex flex-col items-center justify-center p-6 text-center">
                <CheckCircle2 className="w-20 h-20 text-[var(--color-brand-accent)] mb-6 animate-in zoom-in duration-500" />
                <h1 className="text-3xl font-bold mb-2">You're Booked!</h1>
                <p className="text-[var(--color-brand-muted)] mb-8 text-lg">
                    We will see you on <br />
                    <span className="text-[var(--color-brand-light)] font-bold">
                        {formatFriendlyDate(selectedDate, selectedSlot!.time)}
                    </span>
                    <br /><span className="text-sm mt-2 block opacity-70">with {selectedSlot!.barberName}</span>
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
                        setSelectedService(null)
                        setBookingComplete(false)
                        navigate('/')
                    }} className="w-full bg-[var(--color-brand-800)] border border-[var(--color-brand-700)] text-[var(--color-brand-light)] px-8 py-4 rounded-xl hover:border-[var(--color-brand-accent)] transition-all font-semibold cursor-pointer">
                        Return to Home
                    </button>
                </div>
            </div>
        )
    }

    return (
        <div className="min-h-screen text-[var(--color-brand-light)] font-sans flex flex-col p-6 max-w-md mx-auto">
            <header className="flex items-center gap-4 mb-8 pt-4">
                <button onClick={handleBack} className="p-3 bg-[var(--color-brand-800)] border border-[var(--color-brand-700)] rounded-full hover:border-[var(--color-brand-accent)] transition-all cursor-pointer">
                    <ArrowLeft className="w-5 h-5" />
                </button>
                <div>
                    <h1 className="text-2xl font-bold tracking-tight">
                        {!selectedService ? "Select Service" : !selectedSlot ? (selectedTimeGroup ? "Select Barber" : "Select Time") : "Your Details"}
                    </h1>
                    <p className="text-[var(--color-brand-muted)] text-sm flex items-center gap-1">
                        {isWalkIn && !selectedSlot ? <><Zap className="w-3 h-3 text-[var(--color-brand-accent)]"/> Kiosk Mode</> : `Booking with ${selectedSlot ? selectedSlot.barberName : barberName}`}
                    </p>
                </div>
            </header>

            {!selectedService ? (
                <div className="space-y-4 animate-in fade-in slide-in-from-right-4">
                    {services.map(service => (
                        <button key={service.id} onClick={() => { setSelectedService(service); setSelectedTimeGroup(null); }} className="w-full bg-[var(--color-brand-800)] border border-[var(--color-brand-700)] hover:border-[var(--color-brand-accent)] transition-all p-6 rounded-2xl shadow-lg flex items-center justify-between group cursor-pointer backdrop-blur-md">
                            <div className="text-left">
                                <h2 className="text-lg font-bold">{service.name}</h2>
                                <p className="text-sm text-[var(--color-brand-muted)]">{service.duration_minutes} Minutes</p>
                            </div>
                            <div className="text-lg font-bold text-[var(--color-brand-accent)]">${service.price}</div>
                        </button>
                    ))}
                </div>
            ) : !selectedSlot ? (
                <div className="animate-in fade-in slide-in-from-right-4 duration-300">
                    <div className="bg-[var(--color-brand-800)]/80 backdrop-blur-md border border-[var(--color-brand-accent)] p-4 rounded-2xl mb-6 shadow-lg flex items-center justify-between">
                        <div>
                            <p className="text-xs text-[var(--color-brand-muted)] uppercase tracking-wider font-bold mb-1">Selected Service</p>
                            <p className="font-bold">{selectedService.name} ({selectedService.duration_minutes}m)</p>
                        </div>
                        <Scissors className="w-5 h-5 text-[var(--color-brand-accent)] opacity-50" />
                    </div>

                    <div className="bg-[var(--color-brand-800)]/80 backdrop-blur-md border border-[var(--color-brand-700)] p-4 rounded-2xl mb-8 shadow-lg">
                        <label className="flex items-center gap-2 text-[var(--color-brand-muted)] text-sm font-semibold mb-3 uppercase tracking-wider">
                            <CalendarIcon className="w-4 h-4 text-[var(--color-brand-accent)]" /> Choose Date
                        </label>
                        <input type="date" value={selectedDate} min={new Date().toISOString().split('T')[0]} onChange={(e) => { setSelectedDate(e.target.value); setSelectedTimeGroup(null); }} className="w-full bg-transparent text-[var(--color-brand-light)] border border-[var(--color-brand-700)] rounded-xl p-3 outline-none focus:border-[var(--color-brand-accent)] transition-colors [color-scheme:dark] cursor-pointer" />
                    </div>

                    <div>
                        {loadingSlots ? (
                            <div className="text-center text-[var(--color-brand-muted)] animate-pulse py-8">Scanning schedules...</div>
                        ) : slots.length === 0 ? (
                            <div className="text-center bg-[var(--color-brand-800)]/80 backdrop-blur-md border border-[var(--color-brand-700)] rounded-2xl p-8 shadow-md">
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
                                            className="bg-[var(--color-brand-800)]/90 backdrop-blur-sm border border-[var(--color-brand-700)] text-[var(--color-brand-light)] font-bold p-3.5 rounded-xl hover:bg-[var(--color-brand-accent)] hover:border-[var(--color-brand-accent)] hover:text-white transition-all shadow-sm cursor-pointer flex flex-col items-center justify-center active:scale-95 group"
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
                                        className="text-xs font-bold text-[var(--color-brand-accent)] hover:text-white flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[var(--color-brand-800)] border border-[var(--color-brand-700)] hover:border-[var(--color-brand-accent)] transition-all cursor-pointer shadow-sm flex-shrink-0"
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
                                            className="w-full bg-[var(--color-brand-800)]/90 backdrop-blur-md border border-[var(--color-brand-700)] hover:border-[var(--color-brand-accent)] p-4 rounded-2xl flex items-center justify-between group cursor-pointer transition-all shadow-md hover:brightness-110 active:scale-[0.99]"
                                        >
                                            <div className="flex items-center gap-3.5 text-left">
                                                <div className="bg-[var(--color-brand-900)] p-3 rounded-full border border-[var(--color-brand-700)] group-hover:border-[var(--color-brand-accent)] transition-colors">
                                                    <Scissors className="w-5 h-5 text-[var(--color-brand-accent)]" />
                                                </div>
                                                <div>
                                                    <h3 className="font-bold text-base text-white group-hover:text-[var(--color-brand-accent)] transition-colors">
                                                        {slot.barberName}
                                                    </h3>
                                                    <p className="text-xs text-[var(--color-brand-muted)] font-medium">
                                                        {selectedService.name} • {selectedService.duration_minutes}m
                                                    </p>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <span className="text-xs font-bold text-[var(--color-brand-accent)] bg-[var(--color-brand-accent)]/10 px-3 py-1.5 rounded-lg border border-[var(--color-brand-accent)]/30 group-hover:bg-[var(--color-brand-accent)] group-hover:text-white transition-colors">
                                                    Select
                                                </span>
                                                <span className="text-[var(--color-brand-muted)] group-hover:translate-x-0.5 transition-transform text-sm">
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
                    <div className="bg-[var(--color-brand-800)]/80 backdrop-blur-md border border-[var(--color-brand-accent)] p-4 rounded-2xl mb-8 shadow-lg space-y-2">
                        <p className="text-xs text-[var(--color-brand-muted)] uppercase tracking-wider font-bold">Appointment Summary</p>
                        <p className="font-bold text-lg">{selectedService.name}</p>
                        <p className="text-[var(--color-brand-muted)]">{formatFriendlyDate(selectedDate, selectedSlot.time)}</p>
                    </div>

                    <div className="space-y-4 mb-8">
                        <div className="relative">
                            <User className="w-5 h-5 text-[var(--color-brand-muted)] absolute left-4 top-1/2 -translate-y-1/2" />
                            <input required type="text" placeholder="First & Last Name" value={clientName} onChange={(e) => setClientName(e.target.value)} className="w-full bg-[var(--color-brand-800)]/80 text-[var(--color-brand-light)] border border-[var(--color-brand-700)] rounded-xl p-4 pl-12 outline-none focus:border-[var(--color-brand-accent)] transition-colors backdrop-blur-md" />
                        </div>
                        <div className="relative">
                            <Phone className="w-5 h-5 text-[var(--color-brand-muted)] absolute left-4 top-1/2 -translate-y-1/2" />
                            <input required type="tel" placeholder="Phone Number" value={clientPhone} onChange={(e) => setClientPhone(e.target.value)} className="w-full bg-[var(--color-brand-800)]/80 text-[var(--color-brand-light)] border border-[var(--color-brand-700)] rounded-xl p-4 pl-12 outline-none focus:border-[var(--color-brand-accent)] transition-colors backdrop-blur-md" />
                        </div>
                        <div className="relative">
                            <FileText className="w-5 h-5 text-[var(--color-brand-muted)] absolute left-4 top-4" />
                            <textarea placeholder="Notes for Barber (Optional)" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className="w-full bg-[var(--color-brand-800)]/80 text-[var(--color-brand-light)] border border-[var(--color-brand-700)] rounded-xl p-4 pl-12 outline-none focus:border-[var(--color-brand-accent)] transition-colors backdrop-blur-md resize-none"></textarea>
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