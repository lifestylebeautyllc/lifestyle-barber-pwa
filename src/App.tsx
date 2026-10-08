import { BrowserRouter as Router, Routes, Route, Link } from 'react-router-dom'
import { Shield } from 'lucide-react'
import BookingWizard from './pages/client/BookingWizard'
import BarberCalendar from './pages/client/BarberCalendar'
import AdminDashboard from './pages/admin/AdminDashboard'

// Aesthetic Layer: Floating Gold & Silver Flake Background
const ParticleBackground = () => {
  // Generate 40 random particles
  const particles = Array.from({ length: 40 }).map((_, i) => ({
    id: i,
    left: `${Math.random() * 100}vw`,
    animationDuration: `${Math.random() * 15 + 10}s`,
    animationDelay: `-${Math.random() * 15}s`,
    size: `${Math.random() * 3 + 1}px`,
    isGold: Math.random() > 0.5 // 50/50 split between gold and silver
  }))

  return (
    <div className="fixed inset-0 pointer-events-none z-50 overflow-hidden mix-blend-screen opacity-50">
      <style>{`
        @keyframes floatDrift {
          0% { transform: translateY(100vh) translateX(0px); opacity: 0; }
          20% { opacity: 0.8; }
          80% { opacity: 0.8; }
          100% { transform: translateY(-10vh) translateX(30px); opacity: 0; }
        }
      `}</style>
      {particles.map(p => (
        <div
          key={p.id}
          className="absolute rounded-full"
          style={{
            left: p.left,
            width: p.size,
            height: p.size,
            backgroundColor: p.isGold ? '#D4AF37' : '#E5E7EB',
            boxShadow: p.isGold ? '0 0 6px #D4AF37' : '0 0 6px #E5E7EB',
            animation: `floatDrift ${p.animationDuration} linear infinite`,
            animationDelay: p.animationDelay
          }}
        />
      ))}
    </div>
  )
}

export default function App() {
  return (
    <Router>
      <ParticleBackground />
      <Routes>
        {/* Public Client Booking Flow */}
        <Route path="/" element={<BookingWizard />} />
        <Route path="/book/:barberId" element={<BarberCalendar />} />

        {/* Protected Barber Admin View */}
        <Route path="/admin/*" element={<AdminDashboard />} />
      </Routes>
    </Router>
  )
}