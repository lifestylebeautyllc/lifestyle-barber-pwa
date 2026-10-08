import { useState, useEffect } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { Scissors, Calendar, Shield, Clock } from 'lucide-react'
import { supabase } from '../../lib/supabase'

interface Barber {
  id: string
  name: string
  role: string
}

export default function BookingWizard() {
  const navigate = useNavigate()
  const [barbers, setBarbers] = useState<Barber[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetchBarbers() {
      const { data } = await supabase.from('barbers').select('*').eq('is_active', true)
      if (data) setBarbers(data)
      setLoading(false)
    }
    fetchBarbers()
  }, [])

  return (
    <div className="min-h-screen bg-[var(--color-brand-900)] text-[var(--color-brand-light)] p-6 font-sans flex flex-col max-w-md mx-auto">
      <header className="flex flex-col items-center gap-3 mb-10 text-center pt-8">
        <div className="relative w-48 h-48 mb-2">
          <img
            src="/logo.png"
            alt="LifeStyle Barber"
            className="w-full h-full object-contain relative z-10"
            style={{
              mixBlendMode: 'screen',
              maskImage: 'radial-gradient(circle at center, black 40%, transparent 70%)',
              WebkitMaskImage: 'radial-gradient(circle at center, black 40%, transparent 70%)'
            }}
          />
        </div>
        <h1 className="text-3xl font-bold tracking-tight relative z-10">Booking Portal</h1>
        <p className="text-[var(--color-brand-muted)] text-sm relative z-10">Select an option to begin</p>
      </header>

      <div className="space-y-4 flex-grow relative z-10">

        {/* The Upgraded Kiosk Walk-In Button */}
        <button
          onClick={() => navigate('/book/walk-in')}
          className="w-full bg-[var(--color-brand-accent)] text-white p-6 rounded-2xl shadow-[0_0_20px_rgba(168,85,247,0.4)] flex items-center justify-between group cursor-pointer hover:brightness-110 transition-all mb-8"
        >
          <div className="text-left flex items-center gap-4">
            <div className="bg-white/20 p-3 rounded-full">
              <Clock className="w-6 h-6 text-white" />
            </div>
            <div>
              <h2 className="text-xl font-bold">Walk-In / Next Available</h2>
              <p className="text-sm text-white/80">Tap to see who is open right now</p>
            </div>
          </div>
          <div className="text-white opacity-50 group-hover:opacity-100 group-hover:translate-x-1 transition-all">
            ❯
          </div>
        </button>

        <div className="flex items-center gap-4 my-6">
          <div className="flex-grow h-px bg-[var(--color-brand-700)]"></div>
          <span className="text-xs text-[var(--color-brand-muted)] font-bold uppercase tracking-widest">Or Select Barber</span>
          <div className="flex-grow h-px bg-[var(--color-brand-700)]"></div>
        </div>

        {loading ? (
          <div className="text-center text-[var(--color-brand-muted)] animate-pulse">Loading roster...</div>
        ) : (
          barbers.map(barber => (
            <button
              key={barber.id}
              onClick={() => navigate(`/book/${barber.id}`)}
              className="w-full bg-[var(--color-brand-800)]/80 backdrop-blur-md border border-[var(--color-brand-700)] hover:border-[var(--color-brand-accent)] transition-all p-5 rounded-2xl flex items-center justify-between group cursor-pointer"
            >
              <div className="flex items-center gap-4">
                <div className="bg-[var(--color-brand-900)] p-3 rounded-full border border-[var(--color-brand-700)] group-hover:border-[var(--color-brand-accent)] transition-colors">
                  <Scissors className="w-5 h-5 text-[var(--color-brand-accent)]" />
                </div>
                <div className="text-left">
                  <h2 className="text-lg font-bold">{barber.name}</h2>
                  <p className="text-xs text-[var(--color-brand-muted)] uppercase tracking-wider font-semibold">{barber.role.replace('-', ' ')}</p>
                </div>
              </div>
              <Calendar className="w-5 h-5 text-[var(--color-brand-700)] group-hover:text-[var(--color-brand-accent)] transition-colors" />
            </button>
          ))
        )}
      </div>

      <footer className="mt-12 pb-6 text-center relative z-10">
        <Link to="/admin" className="text-xs text-[var(--color-brand-700)] hover:text-[var(--color-brand-accent)] transition-colors flex items-center justify-center gap-2">
          <Shield className="w-3 h-3" />
          Barber Login
        </Link>
      </footer>
    </div>
  )
}