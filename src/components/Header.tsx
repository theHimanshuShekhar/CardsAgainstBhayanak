import { Link } from '@tanstack/react-router'

export default function Header() {
  return (
    <header className="sticky top-0 z-50 backdrop-blur-md border-b border-white/5 bg-[#0d0319]/90">
      <div className="mx-auto max-w-[900px] px-4 h-12 flex items-center">
        <Link
          to="/"
          className="font-black text-base tracking-tight no-underline bg-gradient-to-r from-orange-500 via-pink-500 to-purple-500 bg-clip-text text-transparent"
        >
          CardsAgainstBhayanak
        </Link>
      </div>
    </header>
  )
}
