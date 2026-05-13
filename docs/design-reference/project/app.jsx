// app.jsx — router, state, tweaks panel

const { useState: useStateApp } = React

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/ {
  screen: 'home',
  role: 'player',
  roomFull: false,
  showTweaks: true,
} /*EDITMODE-END*/

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS)
  const screen = t.screen
  const setScreen = (s) => setTweak('screen', s)

  const [draft, setDraft] = useStateApp({
    username: 'priya_was_here',
    maxPlayers: 6,
    roundsToWin: 7,
    timer: '60s',
    packs: ['core', 'office', 'desi'],
    rules: ['rebooting'],
  })

  const go = (s) => setScreen(s)

  let scene = null
  if (screen === 'home') scene = <HomeScreen go={go} />
  if (screen === 'create') scene = <CreateScreen go={go} draft={draft} setDraft={setDraft} />
  if (screen === 'join')
    scene = <JoinScreen go={go} draft={draft} setDraft={setDraft} roomFull={t.roomFull} />
  if (screen === 'lobby')
    scene = <LobbyScreen go={go} draft={draft} isHost={true} roomFull={t.roomFull} />
  if (screen === 'lobby-spectator')
    scene = (
      <LobbyScreen go={go} draft={draft} isHost={false} asSpectator={true} roomFull={t.roomFull} />
    )
  if (screen === 'game')
    scene = <GameScreen go={go} draft={draft} role={t.role} setRole={(r) => setTweak('role', r)} />
  if (screen === 'stats') scene = <StatsScreen go={go} />
  if (!scene) scene = <HomeScreen go={go} />

  return (
    <div className="app" data-screen-label={screen}>
      {scene}

      <TweaksPanel>
        <TweakSection label="Demo navigation" />
        <TweakSelect
          label="Screen"
          value={screen}
          options={[
            { value: 'home', label: '1 · Home' },
            { value: 'create', label: '2 · Create game' },
            { value: 'join', label: 'Join (alt)' },
            { value: 'lobby', label: '3 · Lobby (host)' },
            { value: 'lobby-spectator', label: '3b · Lobby (spectator)' },
            { value: 'game', label: '4 · Game session' },
            { value: 'stats', label: '5 · Stats' },
          ]}
          onChange={(v) => setTweak('screen', v)}
        />
        <TweakRadio
          label="Your role"
          value={t.role}
          options={['player', 'judge']}
          onChange={(v) => setTweak('role', v)}
        />
        <TweakToggle
          label="Room full (force spectator)"
          value={t.roomFull}
          onChange={(v) => setTweak('roomFull', v)}
        />

        <TweakSection label="Game flow" />
        <TweakButton
          label="Reset flow"
          onClick={() => {
            setTweak('screen', 'home')
            setTweak('role', 'player')
          }}
        >
          Back to home
        </TweakButton>
      </TweaksPanel>
    </div>
  )
}

const root = ReactDOM.createRoot(document.getElementById('root'))
root.render(<App />)
