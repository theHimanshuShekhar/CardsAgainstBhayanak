import { createContext, useContext, useState } from 'react'
import type { Dispatch, ReactNode, SetStateAction } from 'react'
import type { GameDraft } from '~/lib/types'

const DEFAULT_DRAFT: GameDraft = {
  username: '',
  maxPlayers: 6,
  roundsToWin: 7,
  timer: '60s',
  packs: [],
  rules: [],
}

type GameContextValue = {
  draft: GameDraft
  setDraft: Dispatch<SetStateAction<GameDraft>>
}

const GameContext = createContext<GameContextValue | null>(null)

export function GameProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState<GameDraft>(DEFAULT_DRAFT)
  return <GameContext value={{ draft, setDraft }}>{children}</GameContext>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useGameContext(): GameContextValue {
  const ctx = useContext(GameContext)
  if (!ctx) throw new Error('useGameContext must be used within GameProvider')
  return ctx
}
