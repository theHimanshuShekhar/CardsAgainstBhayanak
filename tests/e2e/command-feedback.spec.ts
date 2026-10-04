import { test, expect } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import {
  createGame,
  createGameWithRule,
  joinGame,
  getCzar,
  waitForPhase,
  type PlayerHandle,
} from '../helpers'

// Faults are injected at the browser's external WebSocket boundary; all
// accepted/rejected frames still run against the real HTTP/WS server.
type Faults = {
  socket: WebSocket
  mode: 'pass' | 'hold' | 'reject' | 'throw'
  held?: string
  delayAck: boolean
  beforeRound: boolean
  synchronized: boolean
  acknowledgements: string[]
  sendHeld: () => void
}

async function wire(page: Page, beforeRound = false) {
  await page.evaluate((beforeRound) => {
    const NativeSocket = window.WebSocket
    const faults = {
      mode: 'pass',
      delayAck: false,
      beforeRound,
      acknowledgements: [],
    } as unknown as Faults
    ;(window as unknown as { faults: Faults }).faults = faults
    window.WebSocket = class extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        faults.socket = this
        faults.synchronized = false
        this.addEventListener('message', (event) => {
          const message = JSON.parse(String(event.data))
          if (faults.beforeRound && message.type === 'state_snapshot') {
            faults.beforeRound = false
            event.stopImmediatePropagation()
            // Reproduce rejoin before the first round row exists. The
            // real snapshot supplies the subsequent round-start frame.
            this.dispatchEvent(
              new MessageEvent('message', {
                data: JSON.stringify({
                  type: 'lobby_snapshot',
                  gameStatus: 'active',
                  config: message.state.config,
                  players: [],
                }),
              }),
            )
            this.dispatchEvent(
              new MessageEvent('message', {
                data: JSON.stringify({
                  type: 'round_started',
                  round: message.state.round,
                  prompt: message.state.prompt,
                  czarId: message.state.czarId,
                  submitted: message.state.submitted,
                  expected: message.state.expected,
                  roundTimerExpiresAt: message.state.roundTimerExpiresAt,
                }),
              }),
            )
          }
          if (message.type === 'state_snapshot' && !event.cancelBubble) faults.synchronized = true
          if (
            faults.delayAck &&
            (message.type === 'command_accepted' || (message.type === 'error' && message.commandId))
          ) {
            faults.acknowledgements.push(String(event.data))
            event.stopImmediatePropagation()
          }
        })
      }
      send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        const command = JSON.parse(String(data))
        if (['play', 'vote', 'pick'].includes(command.type)) {
          if (faults.mode === 'throw') throw new Error('transport unavailable')
          if (faults.mode === 'hold') {
            faults.held = String(data)
            return
          }
          if (faults.mode === 'reject') {
            return super.send(
              JSON.stringify({
                ...command,
                ...(command.type === 'play'
                  ? { cardIds: ['missing-card'] }
                  : { submissionId: '999' }),
              }),
            )
          }
        }
        super.send(data)
      }
    }
    faults.sendHeld = () => NativeSocket.prototype.send.call(faults.socket, faults.held!)
  }, beforeRound)
  const mode = (mode: Faults['mode']) =>
    page.evaluate((mode) => {
      ;(window as unknown as { faults: Faults }).faults.mode = mode
    }, mode)
  return {
    inject: (event: Record<string, unknown>) =>
      page.evaluate((event) => {
        ;(window as unknown as { faults: Faults }).faults.socket.dispatchEvent(
          new MessageEvent('message', { data: JSON.stringify(event) }),
        )
      }, event),
    hold: () => mode('hold'),
    reject: () => mode('reject'),
    failSend: () => mode('throw'),
    pass: () => mode('pass'),
    release: () =>
      page.evaluate(() => {
        const faults = (window as unknown as { faults: Faults }).faults
        faults.mode = 'pass'
        faults.sendHeld()
      }),
    receiptPending: () =>
      page.evaluate(
        () => (window as unknown as { faults: Faults }).faults.acknowledgements.length > 0,
      ),
    delayAck: () =>
      page.evaluate(() => {
        ;(window as unknown as { faults: Faults }).faults.delayAck = true
      }),
    releaseAck: () =>
      page.evaluate(() => {
        const faults = (window as unknown as { faults: Faults }).faults
        faults.delayAck = false
        for (const data of faults.acknowledgements.splice(0))
          faults.socket.dispatchEvent(new MessageEvent('message', { data }))
      }),
  }
}

async function start(browser: Browser, godmode = false, beforeRound = false) {
  const { handle: host, roomCode } = godmode
    ? await createGameWithRule(browser, 'FeedbackHost', 'God Is Dead')
    : await createGame(browser, 'FeedbackHost')
  // These receipt tests hold commands deliberately; round expiry is a
  // separate server behavior and must not race the injected delay.
  const saved = host.page.waitForResponse(
    (response) => response.url().endsWith('/config') && response.request().method() === 'PATCH',
  )
  await host.page.getByRole('radio', { name: 'Off', exact: true }).click()
  expect((await saved).status()).toBe(204)
  const p1 = await joinGame(browser, 'FeedbackOne', roomCode)
  const p2 = await joinGame(browser, 'FeedbackTwo', roomCode)
  const players = [host, p1, p2]
  const wires = new Map<PlayerHandle, Awaited<ReturnType<typeof wire>>>()
  for (const player of players) wires.set(player, await wire(player.page, beforeRound))
  await expect(host.page.getByRole('button', { name: 'Start game' })).toBeEnabled()
  await host.page.getByRole('button', { name: 'Start game' }).click()
  await Promise.all(players.map((p) => p.page.waitForURL('**/session')))
  await waitForPhase(players, 'picking')
  return { players, wires }
}

async function selectHand(page: Page) {
  const text = await page.locator('.hand-dock .eyebrow').textContent()
  const pick = Number(/pick (\d)/.exec(text ?? '')?.[1] ?? 1)
  for (let i = 0; i < pick; i++) await page.locator('.hand-card-wrap .card-response').nth(i).click()
}

test('submit keeps selections on rejection and disconnect, and waits for delayed acceptance', async ({
  browser,
}) => {
  test.setTimeout(90_000)
  const { players, wires } = await start(browser)
  try {
    const czar = await getCzar(players)
    const player = players.find((p) => p !== czar)!
    const page = player.page
    const transport = wires.get(player)!
    await selectHand(page)
    await transport.failSend()
    await page.getByRole('button', { name: /Submit card/ }).click()
    await expect(page.getByRole('alert')).toHaveText('Could not send. Try again.')
    await expect(page.getByRole('button', { name: /Submit card/ })).toBeEnabled()
    await transport.reject()
    await page.getByRole('button', { name: /Submit card/ }).click()
    await expect(page.getByRole('alert')).toHaveText('Submit cards from your hand')
    await expect(page.getByRole('button', { name: /Submit card/ })).toBeEnabled()
    await disconnectBeforeClick(page, '.hand-dock-hd button')
    await expect(page.getByRole('alert')).toContainText('Disconnected')
    await expect(page.getByRole('button', { name: /Submit card/ })).toBeEnabled()
    await expect.poll(() => socketReady(page)).toBe(true)
    await transport.hold()
    await page.getByRole('button', { name: /Submit card/ }).click()
    await expect(page.getByRole('button', { name: 'Sending…' })).toBeDisabled()
    await expect(page.locator('.hand-dock')).toBeVisible()
    await page.evaluate(() => (window as unknown as { faults: Faults }).faults.socket.close())
    await expect(page.getByRole('alert')).toContainText('Disconnected')
    await expect(page.getByRole('button', { name: /Submit card/ })).toBeEnabled()
    await expect.poll(() => socketReady(page)).toBe(true)
    await expect
      .poll(() => page.getByRole('button', { name: /Submit card/ }).isEnabled())
      .toBe(true)
    await page.getByRole('button', { name: /Submit card/ }).click()
    await expect(page.getByRole('button', { name: 'Sending…' })).toBeDisabled()
    await transport.inject({
      type: 'error',
      code: 'invalid_state',
      message: 'Unrelated error',
      commandId: 'other-command',
    })
    await expect(page.getByRole('button', { name: 'Sending…' })).toBeDisabled()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await transport.release()
    await expect(page.locator('.hand-dock')).toBeHidden()
    await page.evaluate(() => (window as unknown as { faults: Faults }).faults.socket.close())
    await expect.poll(() => socketReady(page)).toBe(true)
    await expect(page.locator('.hand-dock')).toBeHidden()
  } finally {
    await Promise.all(players.map((p) => p.context.close()))
  }
})

async function socketReady(page: Page) {
  return page.evaluate(() => {
    const faults = (window as unknown as { faults: Faults }).faults
    return faults.socket.readyState === WebSocket.OPEN && faults.synchronized
  })
}

async function disconnectBeforeClick(page: Page, selector: string) {
  await page.evaluate((selector) => {
    // Close and click in one task, before React sees onclose: auth state
    // is stale while the native socket is already CLOSING.
    ;(window as unknown as { faults: Faults }).faults.socket.close()
    document.querySelector<HTMLElement>(selector)!.click()
  }, selector)
}

test('vote restores controls on rejection and disconnect, then confirms only the accepted vote', async ({
  browser,
}) => {
  test.setTimeout(90_000)
  const { players, wires } = await start(browser, true)
  try {
    const voter = players[0]!
    const ownText = await voter.page.locator('.hand-card-wrap .card-text').first().textContent()
    for (const p of players) {
      await selectHand(p.page)
      await p.page.getByRole('button', { name: /Submit card/ }).click()
    }
    const page = voter.page
    await expect(page.getByTestId('vote-btn')).toHaveCount(3)
    await expect(page.getByTestId('vote-btn').first()).toBeEnabled()
    // Multi-blank submissions render one slot per fill. Vote lives on
    // the first slot; the badge groups that slot with any matching fill.
    const own = await submissionVote(page, ownText!)
    await own.click()
    await expect(page.getByRole('alert')).toHaveText('Action was not accepted. Try again.')
    await expect(page.getByTestId('vote-btn').first()).toBeEnabled()
    await disconnectBeforeClick(page, '[data-testid="vote-btn"]')
    await expect(page.getByRole('alert')).toContainText('Disconnected')
    await expect.poll(() => socketReady(page)).toBe(true)
    await expect(page.getByTestId('vote-btn')).toHaveCount(3)
    const target = page
      .getByTestId('vote-btn')
      .nth(
        ((await own.evaluate((button) =>
          Array.from(document.querySelectorAll('[data-testid="vote-btn"]')).indexOf(button),
        )) +
          1) %
          3,
      )
    await wires.get(voter)!.hold()
    await target.click()
    await expect(page.getByRole('status')).toHaveText('Sending…')
    await expect(page.getByTestId('vote-btn').first()).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Voted', exact: true })).toHaveCount(0)
    await wires.get(voter)!.release()
    await expect(page.getByRole('button', { name: 'Voted', exact: true })).toHaveCount(1)
    await page.reload()
    await expect(page.getByRole('button', { name: 'Voted', exact: true })).toHaveCount(1)
  } finally {
    await Promise.all(players.map((p) => p.context.close()))
  }
})

test('winner pick reports rejection and disconnect without declaring a winner, then waits for the server outcome', async ({
  browser,
}) => {
  test.setTimeout(90_000)
  const { players, wires } = await start(browser)
  try {
    const czar = await getCzar(players)
    for (const player of players.filter((p) => p !== czar)) {
      await selectHand(player.page)
      await player.page.getByRole('button', { name: /Submit card/ }).click()
    }
    const page = czar.page
    await expect(page.locator('.flip-reveal .card-response')).toHaveCount(2)
    const card = page.locator('.flip-reveal .card-response').first()
    const transport = wires.get(czar)!
    await transport.reject()
    await card.click()
    await expect(page.getByRole('alert')).toHaveText('Command failed')
    await expect(page.locator('.is-winner')).toHaveCount(0)
    await disconnectBeforeClick(page, '.flip-reveal .card-response')
    await expect(page.getByRole('alert')).toContainText('Disconnected')
    await expect.poll(() => socketReady(page)).toBe(true)
    await expect(page.locator('.flip-reveal .card-response')).toHaveCount(2)
    await transport.hold()
    await card.click()
    await expect(page.getByRole('status')).toHaveText('Sending…')
    await expect(page.locator('.is-winner')).toHaveCount(0)
    await transport.delayAck()
    await transport.release()
    // Completion comes from the server's outcome; the next round can
    // arrive before a delayed acknowledgement without changing it back.
    await expect(page.locator('.pill', { hasText: 'Round 2' })).toBeVisible({ timeout: 15_000 })
    await transport.releaseAck()
    await expect(page.locator('.is-winner')).toHaveCount(0)
    await expect(page.locator('.hand-dock')).toBeVisible()
  } finally {
    await Promise.all(players.map((p) => p.context.close()))
  }
})

test('a lost submit acknowledgement reconciles accepted state before offering a retry', async ({
  browser,
}) => {
  test.setTimeout(90_000)
  const { players, wires } = await start(browser)
  try {
    const czar = await getCzar(players)
    const player = players.find((p) => p !== czar)!
    const page = player.page
    await wires.get(player)!.delayAck()
    await selectHand(page)
    await page.getByRole('button', { name: /Submit card/ }).click()
    await expect(page.getByRole('button', { name: 'Sending…' })).toBeDisabled()
    await expect(page.locator('.hand-dock')).toBeHidden({ timeout: 15_000 })
    await expect(page.getByRole('alert')).toContainText('Confirmation delayed')
    await expect(page.getByRole('status')).toHaveCount(0)
  } finally {
    await Promise.all(players.map((p) => p.context.close()))
  }
})

test('a tie revote clears pending and accepted vote receipts before an old acknowledgement arrives', async ({
  browser,
}) => {
  test.setTimeout(90_000)
  const { players, wires } = await start(browser, true)
  try {
    const texts = await Promise.all(
      players.map((p) => p.page.locator('.hand-card-wrap .card-text').first().textContent()),
    )
    for (const player of players) {
      await selectHand(player.page)
      await player.page.getByRole('button', { name: /Submit card/ }).click()
    }
    const voter = players[0]!
    await wires.get(voter)!.delayAck()
    for (let i = 0; i < players.length; i++) {
      const page = players[i]!.page
      const target = await submissionVote(page, texts[(i + 1) % players.length]!)
      await expect(target).toBeEnabled()
      await target.click()
    }
    await expect(voter.page.getByTestId('vote-btn').first()).toBeEnabled()
    await wires.get(voter)!.releaseAck()
    await expect(voter.page.getByRole('button', { name: 'Voted', exact: true })).toHaveCount(0)
    await voter.page.reload()
    await expect(voter.page.getByTestId('vote-btn').first()).toBeEnabled()
    await expect(voter.page.getByRole('button', { name: 'Voted', exact: true })).toHaveCount(0)
  } finally {
    await Promise.all(players.map((p) => p.context.close()))
  }
})

async function submissionVote(page: Page, text: string) {
  const slot = page.locator('.sub-card', { hasText: text }).first()
  const badge = slot.locator('.player-badge')
  if (await badge.count()) {
    const number = await badge.textContent()
    return page
      .locator('.sub-card')
      .filter({ has: page.locator('.player-badge', { hasText: new RegExp(`^${number}$`) }) })
      .getByTestId('vote-btn')
      .first()
  }
  return slot.getByTestId('vote-btn')
}

test('a session joining before the first round hydrates its hand before allowing gameplay commands', async ({
  browser,
}) => {
  test.setTimeout(90_000)
  const { players } = await start(browser, false, true)
  try {
    const czar = await getCzar(players)
    const player = players.find((p) => p !== czar)!
    await expect(player.page.locator('.score-chip')).toHaveCount(3)
    await selectHand(player.page)
    await player.page.getByRole('button', { name: /Submit card/ }).click()
    await expect(player.page.locator('.hand-dock')).toBeHidden()
  } finally {
    await Promise.all(players.map((p) => p.context.close()))
  }
})

test('a pending play locks wager changes and a rejected play still allows a legal two-submission gamble', async ({
  browser,
}) => {
  test.setTimeout(120_000)
  const { players, wires } = await start(browser)
  try {
    let gambler: PlayerHandle | undefined
    for (let rounds = 0; rounds < 3 && !gambler; rounds++) {
      gambler = (
        await Promise.all(
          players.map(async (player) =>
            (await player.page.getByTestId('wager-btn').isVisible()) ? player : undefined,
          ),
        )
      ).find(Boolean)
      if (gambler) break
      const czar = await getCzar(players)
      const round = await players[0]!.page.locator('.pill').first().textContent()
      let pick = 1
      for (const player of players.filter((p) => p !== czar)) {
        pick = Number(
          /pick (\d)/.exec(
            (await player.page.locator('.hand-dock .eyebrow').textContent()) ?? '',
          )?.[1] ?? 1,
        )
        await selectHand(player.page)
        await player.page.getByRole('button', { name: /Submit card/ }).click()
        await expect(player.page.locator('.hand-dock')).toBeHidden()
      }
      await expect(czar.page.locator('.flip-reveal .card-response')).toHaveCount(2 * pick)
      await czar.page.locator('.flip-reveal .card-response').first().click()
      await expect(players[0]!.page.locator('.pill').first()).not.toHaveText(round!, {
        timeout: 15_000,
      })
    }
    expect(gambler, 'a non-czar with a point can wager').toBeTruthy()
    const player = gambler!
    const page = player.page
    const transport = wires.get(player)!
    await transport.reject()
    await transport.delayAck()
    await selectHand(page)
    await page.getByRole('button', { name: /Submit card/ }).click()
    await expect(page.getByRole('button', { name: 'Sending…' })).toBeDisabled()
    await expect.poll(() => transport.receiptPending()).toBe(true)
    await expect(page.getByTestId('wager-btn')).toBeDisabled()
    await transport.releaseAck()
    await expect(page.getByRole('alert')).toHaveText('Submit cards from your hand')
    await expect(page.getByTestId('wager-btn')).toBeEnabled()

    // The pending guard must not remove legal wagers after rejection.
    await transport.pass()
    const pick = Number(
      /pick (\d)/.exec((await page.locator('.hand-dock .eyebrow').textContent()) ?? '')?.[1] ?? 1,
    )
    await page.getByTestId('wager-btn').click()
    await expect(page.locator('.hand-card-wrap')).toHaveCount(10 + pick)
    await expect(page.getByTestId('wager-btn')).toBeHidden()
    await transport.delayAck()
    await page.getByRole('button', { name: /Submit card/ }).click()
    await expect(page.getByRole('button', { name: 'Sending…' })).toBeDisabled()
    await expect.poll(() => transport.receiptPending()).toBe(true)
    await transport.releaseAck()
    await expect(page.getByRole('button', { name: /Pick a card|Pick \d+ more/ })).toBeVisible()
    await expect(page.locator('.hand-dock')).toBeVisible()
    await selectHand(page)
    await page.getByRole('button', { name: /Submit card/ }).click()
    await expect(page.locator('.hand-dock')).toBeHidden()
  } finally {
    await Promise.all(players.map((p) => p.context.close()))
  }
})
