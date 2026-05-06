import { Link } from '@tanstack/react-router'

export default function Header() {
  return (
    <header style={{
      position: 'sticky',
      top: 0,
      zIndex: 50,
      background: 'rgba(13, 3, 26, 0.88)',
      backdropFilter: 'blur(12px)',
      WebkitBackdropFilter: 'blur(12px)',
      borderBottom: '1px solid rgba(100, 116, 139, 0.15)',
    }}>
      <div style={{
        maxWidth: 900,
        margin: '0 auto',
        padding: '0 16px',
        height: 48,
        display: 'flex',
        alignItems: 'center',
      }}>
        <Link
          to="/"
          style={{
            textDecoration: 'none',
            fontWeight: 900,
            fontSize: 16,
            letterSpacing: '-0.01em',
            background: 'linear-gradient(90deg, #f97316, #ec4899, #a855f7)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
          }}
        >
          CardsAgainstBhayanak
        </Link>
      </div>
    </header>
  )
}
