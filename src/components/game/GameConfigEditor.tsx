import { CheckCard } from '~/components/ui/CheckCard'
import { isBasePack } from '~/lib/packs'
import type { GameConfig, ModalRuleId, OrthogonalRuleId, Pack, RuleId } from '~/lib/types'

// Presentational config editor shared by the create screen and the
// in-lobby host editor (#3) so the two can never drift apart. Pure:
// renders `value`, calls `onChange` with the next config — the parent
// owns persistence (draft state on create, PATCH /config in the lobby).

const TIMERS: GameConfig['timer'][] = ['30s', '60s', '90s', 'Off']

// Modal rules are mutually exclusive (≤ 1 active); "None" = none selected.
const MODAL_RULES: { id: ModalRuleId; name: string; desc: string }[] = [
  { id: 'godmode', name: 'God Is Dead', desc: 'No Czar — everyone votes each round.' },
  {
    id: 'survival',
    name: 'Survival of the Fittest',
    desc: 'Players take turns eliminating cards until one is left.',
  },
  {
    id: 'serious_business',
    name: 'Serious Business',
    desc: 'Czar ranks the top 3 (3 / 2 / 1 points).',
  },
]

const ORTHO_RULES: { id: OrthogonalRuleId; name: string; desc: string }[] = [
  { id: 'rebooting', name: 'Rebooting the Universe', desc: 'Spend 1 point to redraw your hand.' },
  { id: 'packing_heat', name: 'Packing Heat', desc: 'Pick-2 prompts deal an extra card.' },
  { id: 'rando', name: 'Rando Cardrissian', desc: 'An AI player auto-submits every round.' },
  {
    id: 'never_have_i_ever',
    name: 'Never Have I Ever',
    desc: 'Discard with a confession — 3 per game.',
  },
  {
    id: 'happy_ending',
    name: 'Happy Ending',
    desc: "Host can force a 'Make a Haiku' final round.",
  },
]

const MODAL_IDS = MODAL_RULES.map((r) => r.id) as readonly RuleId[]

type Props = {
  value: GameConfig
  onChange: (next: GameConfig) => void
  packs: Pack[]
}

export function GameConfigEditor({ value, onChange, packs }: Props) {
  const baseId = packs.find(isBasePack)?.id
  const activeModal = (value.rules.find((r) => MODAL_IDS.includes(r)) as ModalRuleId) ?? null
  const cardCount = packs
    .filter((p) => value.packs.includes(p.id))
    .reduce((n, p) => n + p.cardCount, 0)

  function togglePack(id: string) {
    if (id === baseId) return // Core pack is locked in
    onChange({
      ...value,
      packs: value.packs.includes(id) ? value.packs.filter((p) => p !== id) : [...value.packs, id],
    })
  }

  function selectModal(id: ModalRuleId | null) {
    const withoutModal = value.rules.filter((r) => !MODAL_IDS.includes(r))
    onChange({ ...value, rules: id ? [...withoutModal, id] : withoutModal })
  }

  function toggleOrtho(id: OrthogonalRuleId) {
    onChange({
      ...value,
      rules: value.rules.includes(id) ? value.rules.filter((r) => r !== id) : [...value.rules, id],
    })
  }

  return (
    <>
      <div className="sheet">
        <div className="sheet-hd">
          <div>
            <div className="sheet-title">Game options</div>
            <div className="sheet-sub">You can change these before the game starts.</div>
          </div>
        </div>
        <div className="opt-grid">
          <div className="opt-row">
            <div>
              <div className="opt-name">Max players</div>
              <div className="opt-desc">The lobby will hold this many before locking.</div>
            </div>
            <div className="stepper">
              <button
                className="stepper-btn"
                disabled={value.maxPlayers <= 3}
                onClick={() => onChange({ ...value, maxPlayers: value.maxPlayers - 1 })}
              >
                −
              </button>
              <div className="stepper-val">{value.maxPlayers}</div>
              <button
                className="stepper-btn"
                disabled={value.maxPlayers >= 10}
                onClick={() => onChange({ ...value, maxPlayers: value.maxPlayers + 1 })}
              >
                +
              </button>
            </div>
          </div>
          <hr className="hr" />
          <div className="opt-row">
            <div>
              <div className="opt-name">Rounds to win</div>
              <div className="opt-desc">First player to this many points wins.</div>
            </div>
            <div className="stepper">
              <button
                className="stepper-btn"
                disabled={value.roundsToWin <= 3}
                onClick={() => onChange({ ...value, roundsToWin: value.roundsToWin - 1 })}
              >
                −
              </button>
              <div className="stepper-val">{value.roundsToWin}</div>
              <button
                className="stepper-btn"
                disabled={value.roundsToWin >= 20}
                onClick={() => onChange({ ...value, roundsToWin: value.roundsToWin + 1 })}
              >
                +
              </button>
            </div>
          </div>
          <hr className="hr" />
          <div className="opt-row">
            <div>
              <div className="opt-name">Round timer</div>
              <div className="opt-desc">How long players have to play their card.</div>
            </div>
            <div className="seg" role="radiogroup" aria-label="Round timer">
              {TIMERS.map((t) => (
                <button
                  key={t}
                  role="radio"
                  aria-checked={value.timer === t}
                  className={`seg-btn ${value.timer === t ? 'active' : ''}`}
                  onClick={() => onChange({ ...value, timer: t })}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="sheet">
        <div className="sheet-hd">
          <div>
            <div className="sheet-title">Card packs</div>
            <div className="sheet-sub">Mix and match. The dealer pulls from every active pack.</div>
          </div>
          <div className="pill">
            <span className="dot" />
            {cardCount.toLocaleString()} cards
          </div>
        </div>
        <div className="pack-grid">
          {packs.map((p) => {
            const locked = p.id === baseId
            return (
              <CheckCard
                key={p.id}
                on={value.packs.includes(p.id)}
                disabled={locked}
                onClick={() => togglePack(p.id)}
                title={p.name}
                meta={`${p.cardCount.toLocaleString()}${locked ? ' · LOCKED IN' : ''}`}
              />
            )
          })}
        </div>
      </div>

      <div className="sheet">
        <div className="sheet-hd">
          <div>
            <div className="sheet-title">House rules</div>
            <div className="sheet-sub">
              Optional. Toggle on the ones your group has actually agreed to.
            </div>
          </div>
        </div>
        <div className="sheet-sub" style={{ marginBottom: 8 }}>
          Game mode — pick at most one
        </div>
        <div className="rule-grid">
          <CheckCard
            on={activeModal === null}
            onClick={() => selectModal(null)}
            title="None"
            description="Classic — the Czar picks the funniest card."
          />
          {MODAL_RULES.map((r) => (
            <CheckCard
              key={r.id}
              on={activeModal === r.id}
              onClick={() => selectModal(activeModal === r.id ? null : r.id)}
              title={r.name}
              description={r.desc}
            />
          ))}
        </div>
        <div className="sheet-sub" style={{ margin: '14px 0 8px' }}>
          Extras — stack freely
        </div>
        <div className="rule-grid">
          {ORTHO_RULES.map((r) => (
            <CheckCard
              key={r.id}
              on={value.rules.includes(r.id)}
              onClick={() => toggleOrtho(r.id)}
              title={r.name}
              description={r.desc}
            />
          ))}
        </div>
      </div>
    </>
  )
}
