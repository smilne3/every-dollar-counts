import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within, act } from '@testing-library/react'
import { GoalsList } from '@/components/GoalsList'
import { SAVE_TIMEOUT_MS } from '@/lib/save-response'
import {
  answering,
  badGateway,
  neverSettles,
  offline,
  redirectedToLogin,
  refused,
  saved,
  savedAt,
  useFakeSaveClock,
} from './helpers/save-replies'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
  refresh.mockClear()
})

// A spy, so a test can tell whether the list is told to reload.
const refresh = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

// jsdom has no showModal()/close() on <dialog> (see tests/unit/confirm-dialog.test.tsx).
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
  }
})

// Two goals so a row renders, one of them complete, and one with a name long enough to lean on
// the row's truncation. readAt is when the page read them, by the server's clock.
const props = {
  initialGoals: [
    { id: '1', name: 'Emergency fund', target_amount: 3000, saved_amount: 1200 },
    { id: '2', name: 'New roof and gutters replacement fund', target_amount: 500, saved_amount: 500 },
  ],
  readAt: 1_000,
}

describe('GoalsList', () => {
  // The Goal field's min-w-[12rem] blocks the shrink that would otherwise let this row fit a
  // 390px screen beside the w-32 Target field. Below `md` the form stacks; above it, today's
  // side-by-side layout is restored exactly.
  it('stacks the add form below md', () => {
    const { container } = render(<GoalsList {...props} />)
    const form = container.querySelector('form') as HTMLElement
    expect(form.className).toContain('flex-col')
    expect(form.className).toContain('md:flex-row')
  })

  // Desktop output must not change, and the stacking rewrote the one class list that decides it.
  // Every class the form carried before is still here, with the two that only make sense on a row
  // moved behind `md`: `flex-wrap` (meaningless on a column) and `items-end` (which on a column is
  // the CROSS axis, so bare it would right-align and shrink-wrap both fields on a phone).
  //
  // `max-w-xl` is the one that would fail silently. Nothing about a phone depends on it — at 390px
  // the form is nowhere near 36rem — so dropping it breaks only the desktop, where the form would
  // widen to the full card. That is a Global Constraint violation no phone-shaped test can see,
  // which is exactly why it is asserted here.
  it('keeps every class the desktop form had, with the row-only ones behind md', () => {
    const { container } = render(<GoalsList {...props} />)
    const classes = (container.querySelector('form') as HTMLElement).className.split(/\s+/)
    expect(classes).toContain('max-w-xl')
    expect(classes).toContain('md:flex-wrap')
    expect(classes).toContain('md:items-end')
    // Neither row-only class may reach the phone. Split on whitespace, or the `md:` forms above
    // would satisfy these.
    expect(classes).not.toContain('flex-wrap')
    expect(classes).not.toContain('items-end')
  })

  it('does not floor the Goal field width below md', () => {
    const { container } = render(<GoalsList {...props} />)
    const label = container.querySelector('[data-goal-name-field]') as HTMLElement
    expect(label.className).toContain('md:min-w-[12rem]')
    expect(label.className.split(/\s+/)).not.toContain('min-w-[12rem]')
  })

  // §7 directly: a 128px Target field on a 390px screen is the other half of this row's problem,
  // and stacking the form does not fix it by itself — a `w-32` field in a column is still 128px of
  // a 390px width. It fills the width below `md` and the 8rem cap returns above it.
  it('lets the Target field fill the width below md', () => {
    const { container } = render(<GoalsList {...props} />)
    const label = container.querySelector('[data-goal-target-field]') as HTMLElement
    const classes = label.className.split(/\s+/)
    expect(classes).toContain('w-full')
    expect(classes).toContain('md:w-32')
    expect(classes).not.toContain('w-32')
  })

  // Guards Ruling 3: the goal rows were already compliant and this task must not disturb them.
  it('leaves the goal row progress bars full width', () => {
    const { container } = render(<GoalsList {...props} />)
    const bars = [...container.querySelectorAll('div')].filter(
      (d) => d.className.includes('rounded-full') && d.className.includes('w-full')
    )
    expect(bars.length).toBeGreaterThan(0)
  })

  // Stacking must not cost the form any of its fields, nor the list any of its goals.
  it('still renders both fields and every goal', () => {
    render(<GoalsList {...props} />)
    expect(screen.getByText('Goal')).toBeTruthy()
    expect(screen.getByText('Target')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add goal' })).toBeTruthy()
    expect(screen.getByText('Emergency fund')).toBeTruthy()
    expect(
      (screen.getByLabelText('Amount saved for Emergency fund') as HTMLInputElement).value
    ).toBe('1200')
  })
})

// #165: call() never read the reply and had no try/finally, so a failed save looked done, a
// request that threw left every goal control disabled, and the add form cleared before the reply.
describe('GoalsList saves', () => {
  const goalField = () => screen.getByLabelText('Goal') as HTMLInputElement
  const targetField = () => screen.getByLabelText('Target') as HTMLInputElement
  const addButton = () => screen.getByRole('button', { name: 'Add goal' }) as HTMLButtonElement
  const addForm = () => addButton().closest('form') as HTMLFormElement
  // The add form's card: the form and anything said under it.
  const addCard = () => addForm().parentElement as HTMLElement
  const amount = (goal: string) => screen.getByLabelText(`Amount saved for ${goal}`) as HTMLInputElement
  const card = (goal: string) => amount(goal).closest('[data-goal-card]') as HTMLElement
  const updateButton = (goal: string) => within(card(goal)).getByRole('button', { name: 'Update' }) as HTMLButtonElement
  const deleteButton = (goal: string) => screen.getByLabelText(`Delete ${goal}`) as HTMLButtonElement
  const EF = 'Emergency fund'
  const ROOF = 'New roof and gutters replacement fund'

  function addVacation() {
    fireEvent.change(goalField(), { target: { value: '  Vacation ' } })
    fireEvent.change(targetField(), { target: { value: '2000' } })
    fireEvent.click(addButton())
  }
  function updateEmergencyFund(value = '1500') {
    fireEvent.change(amount(EF), { target: { value } })
    fireEvent.click(updateButton(EF))
  }
  function deleteEmergencyFund() {
    fireEvent.click(deleteButton(EF))
    const dialog = screen.getByRole('dialog', { name: `Delete “${EF}”?` })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
  }
  // Every goal control, for "disabled while in flight" and "re-enabled after".
  const controls = () => [goalField(), targetField(), addButton(), amount(EF), amount(ROOF), deleteButton(EF), deleteButton(ROOF)]
  const sent = (fetchMock: { mock: { calls: [string, RequestInit?][] } }, i = 0) => ({
    url: fetchMock.mock.calls[i][0],
    method: fetchMock.mock.calls[i][1]?.method,
    body: JSON.parse(fetchMock.mock.calls[i][1]?.body as string),
  })

  const definite = [
    ['a refusal', () => answering(() => refused(400, "The amount saved can't be negative.")), "The amount saved can't be negative."],
    ['a redirect to the login page', () => answering(redirectedToLogin), 'Your session ended. Sign in again.'],
    ['a 200 without ok: true', () => answering(() => new Response('{}', { headers: { 'content-type': 'application/json' } })), 'That could not be saved.'],
  ] as const
  const unknown = [
    ['a gateway error page', () => answering(badGateway)],
    ['a request that fails in flight', () => offline()],
  ] as const

  describe('add', () => {
    it('adds the trimmed goal, clears the form and reloads', async () => {
      const fetchMock = answering(saved)
      vi.stubGlobal('fetch', fetchMock)
      render(<GoalsList {...props} />)
      addVacation()
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
      expect(sent(fetchMock)).toEqual({ url: '/api/goals', method: 'POST', body: { name: 'Vacation', target_amount: 2000 } })
      expect(goalField().value).toBe('')
      expect(targetField().value).toBe('')
      expect(screen.queryByRole('alert')).toBeNull()
      expect(addButton().disabled).toBe(false)
    })

    // #177 review: Add goal with either missing did nothing at all, with nothing said.
    it.each([
      ['no name', '', '2000'],
      ['a name of only spaces', '   ', '2000'],
      ['no target', 'Vacation', ''],
    ])('with %s, says to give the goal a name and a target under the form, and sends nothing', (_, goal, goalTarget) => {
      const fetchMock = answering(saved)
      vi.stubGlobal('fetch', fetchMock)
      render(<GoalsList {...props} />)
      fireEvent.change(goalField(), { target: { value: goal } })
      fireEvent.change(targetField(), { target: { value: goalTarget } })
      fireEvent.click(addButton())
      expect(within(addCard()).getByRole('alert').textContent).toBe('Give the goal a name and a target above zero.')
      expect(fetchMock).not.toHaveBeenCalled()
      expect(goalField().value).toBe(goal)
      expect(targetField().value).toBe(goalTarget)
      expect(addButton().disabled).toBe(false)
    })

    // A target under the field's min="1" is stopped by the browser's own check before the handler
    // runs, so the handler's check is reached by submitting the form directly.
    it.each([
      ['a target of zero', '0'],
      ['a negative target', '-5'],
    ])('with %s, says the same and sends nothing', (_, goalTarget) => {
      const fetchMock = answering(saved)
      vi.stubGlobal('fetch', fetchMock)
      render(<GoalsList {...props} />)
      fireEvent.change(goalField(), { target: { value: 'Vacation' } })
      fireEvent.change(targetField(), { target: { value: goalTarget } })
      fireEvent.submit(addForm())
      expect(within(addCard()).getByRole('alert').textContent).toBe('Give the goal a name and a target above zero.')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    // Nothing was written: say why under the form, and keep what was typed for another try.
    it.each(definite)('after %s, says why under the add form and keeps what was typed', async (_, fetchMock, message) => {
      vi.stubGlobal('fetch', fetchMock())
      render(<GoalsList {...props} />)
      addVacation()
      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toBe(message)
      expect(addCard().contains(alert)).toBe(true)
      expect(addForm().compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(goalField().value).toBe('  Vacation ')
      expect(targetField().value).toBe('2000')
      expect(refresh).not.toHaveBeenCalled()
      expect(controls().every((c) => !c.disabled)).toBe(true)
    })

    // It may have saved, and an add is not a set: left filled, the form invites a second Add that
    // could make the goal twice. Cleared, and the reload shows whether it landed.
    it.each(unknown)('after %s, says it may not have saved under the add form, clears it and reloads', async (_, fetchMock) => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.stubGlobal('fetch', fetchMock())
      render(<GoalsList {...props} />)
      addVacation()
      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toBe('It may not have saved. Showing the latest.')
      expect(addCard().contains(alert)).toBe(true)
      expect(goalField().value).toBe('')
      expect(targetField().value).toBe('')
      expect(refresh).toHaveBeenCalledTimes(1)
      expect(controls().every((c) => !c.disabled)).toBe(true)
      expect(logged).toHaveBeenCalledWith('[GoalsList] save failed', expect.anything())
    })

    it('gives up on an add that never settles: says so, reloads and re-enables every control', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      useFakeSaveClock()
      vi.stubGlobal('fetch', neverSettles())
      render(<GoalsList {...props} />)
      addVacation()
      expect(controls().every((c) => c.disabled)).toBe(true)
      expect(updateButton(EF).disabled).toBe(true)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS)
      })
      expect(within(addCard()).getByRole('alert').textContent).toBe('It may not have saved. Showing the latest.')
      expect(controls().every((c) => !c.disabled)).toBe(true)
      expect(refresh).toHaveBeenCalledTimes(1)
    })

    // Add goal is disabled while a save is in flight; Enter in either field submits the form
    // without it, and a second add would race the first.
    it('ignores Enter in the add form while a save is in flight', () => {
      const fetchMock = neverSettles()
      vi.stubGlobal('fetch', fetchMock)
      render(<GoalsList {...props} />)
      addVacation()
      fireEvent.submit(addForm())
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
  })

  describe('update', () => {
    it('sends the new amount saved for that goal and reloads', async () => {
      const fetchMock = answering(saved)
      vi.stubGlobal('fetch', fetchMock)
      render(<GoalsList {...props} />)
      updateEmergencyFund()
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
      expect(sent(fetchMock)).toEqual({ url: '/api/goals', method: 'PATCH', body: { id: '1', saved_amount: 1500 } })
      expect(amount(EF).value).toBe('1500')
      expect(screen.queryByRole('alert')).toBeNull()
      expect(controls().every((c) => !c.disabled)).toBe(true)
    })

    // Nothing was written: say why on that goal, and keep what was typed for another try.
    it.each(definite)('after %s, says why on that goal and keeps what was typed', async (_, fetchMock, message) => {
      vi.stubGlobal('fetch', fetchMock())
      render(<GoalsList {...props} />)
      updateEmergencyFund()
      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toBe(message)
      expect(card(EF).contains(alert)).toBe(true)
      expect(updateButton(EF).compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(screen.getAllByRole('alert')).toHaveLength(1)
      expect(amount(EF).value).toBe('1500')
      expect(updateButton(EF).disabled).toBe(false)
      expect(refresh).not.toHaveBeenCalled()
    })

    // It may have saved. The bar and the figures follow the field, so the typed amount left there
    // would show progress the server may not have.
    it.each(unknown)('after %s, says it may not have saved on that goal, shows the amount last read and reloads', async (_, fetchMock) => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.stubGlobal('fetch', fetchMock())
      render(<GoalsList {...props} />)
      updateEmergencyFund()
      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toBe('It may not have saved. Showing the latest.')
      expect(card(EF).contains(alert)).toBe(true)
      expect(amount(EF).value).toBe('1200')
      expect(within(card(EF)).getByText(/\$1,200\.00 of \$3,000\.00/)).toBeTruthy()
      expect(within(card(EF)).getByText('40%')).toBeTruthy()
      expect(refresh).toHaveBeenCalledTimes(1)
      expect(logged).toHaveBeenCalledWith('[GoalsList] save failed', expect.anything())
    })

    it('gives up on an update that never settles: says so, shows the amount last read, reloads and re-enables', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      useFakeSaveClock()
      vi.stubGlobal('fetch', neverSettles())
      render(<GoalsList {...props} />)
      updateEmergencyFund()
      expect(controls().every((c) => c.disabled)).toBe(true)
      expect(updateButton(EF).disabled).toBe(true)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS)
      })
      expect(within(card(EF)).getByRole('alert').textContent).toBe('It may not have saved. Showing the latest.')
      expect(amount(EF).value).toBe('1200')
      expect(controls().every((c) => !c.disabled)).toBe(true)
      expect(refresh).toHaveBeenCalledTimes(1)
    })

    // Deleted on the other phone: the list is stale, so show the latest under the message.
    it('says why and reloads when an update is refused because the goal is gone', async () => {
      vi.stubGlobal('fetch', answering(() => refused(404, 'That goal no longer exists.')))
      render(<GoalsList {...props} />)
      updateEmergencyFund()
      expect((await within(card(EF)).findByRole('alert')).textContent).toBe('That goal no longer exists.')
      expect(refresh).toHaveBeenCalledTimes(1)
    })

    // The reload is a new goal object even when its amount is the same one.
    const reloaded = (saved_amount: number) => [{ ...props.initialGoals[0], saved_amount }, { ...props.initialGoals[1] }]

    it('shows the amount as the server stores it once the reload after a save arrives', async () => {
      vi.stubGlobal('fetch', answering(saved))
      const { rerender } = render(<GoalsList {...props} />)
      updateEmergencyFund('1500.50')
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
      rerender(<GoalsList {...props} initialGoals={reloaded(1500.5)} />)
      expect(amount(EF).value).toBe('1500.5')
      expect(updateButton(EF).disabled).toBe(true)
    })

    // Whether or not it landed, the reload is the latest, and nothing was typed since the save.
    it.each([
      ['it did not land, and the amount comes back unchanged', 1200, '1200'],
      ['it landed', 1500, '1500'],
    ])('after an unknown outcome, the reload shows the latest when %s', async (_, latest, shown) => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.stubGlobal('fetch', answering(badGateway))
      const { rerender } = render(<GoalsList {...props} />)
      updateEmergencyFund()
      await screen.findByRole('alert')
      rerender(<GoalsList {...props} initialGoals={reloaded(latest)} />)
      expect(amount(EF).value).toBe(shown)
    })

    // A save that landed and was then saved over from the other phone: the reload brings back the
    // amount this card held before, and the field must follow it, not keep what this card sent.
    it('follows the reload when it brings back the amount the card held before the save', async () => {
      vi.stubGlobal('fetch', answering(saved))
      const { rerender } = render(<GoalsList {...props} />)
      updateEmergencyFund()
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
      rerender(<GoalsList {...props} initialGoals={reloaded(1200)} />)
      expect(amount(EF).value).toBe('1200')
    })

    it('keeps an amount typed into another goal when the reload arrives', async () => {
      vi.stubGlobal('fetch', answering(saved))
      const { rerender } = render(<GoalsList {...props} />)
      fireEvent.change(amount(ROOF), { target: { value: '450' } })
      updateEmergencyFund()
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
      rerender(<GoalsList {...props} initialGoals={reloaded(1500)} />)
      expect(amount(EF).value).toBe('1500')
      expect(amount(ROOF).value).toBe('450')
    })

    it('follows an amount changed on the other phone in a goal nobody has typed into', () => {
      const { rerender } = render(<GoalsList {...props} />)
      rerender(<GoalsList {...props} initialGoals={reloaded(1800)} />)
      expect(amount(EF).value).toBe('1800')
      expect(updateButton(EF).disabled).toBe(true)
    })

    // The reload from one save can land while the next is in flight. If the next one's outcome is
    // unknown, the field goes back to the amount the page holds by then: going back to the one it
    // held when Update was tapped put 1200 behind a 1500 the server had confirmed, with Update
    // enabled to write it.
    it('after an unknown outcome, goes back to the amount the latest reload brought, not an older one', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      useFakeSaveClock()
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(saved()).mockImplementationOnce(neverSettles()))
      const { rerender } = render(<GoalsList {...props} />)
      updateEmergencyFund('1500')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(refresh).toHaveBeenCalledTimes(1)
      updateEmergencyFund('1700')
      // The reload after the first save lands mid-save; what was typed since stays.
      rerender(<GoalsList {...props} initialGoals={reloaded(1500)} />)
      expect(amount(EF).value).toBe('1700')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS)
      })
      expect(within(card(EF)).getByRole('alert').textContent).toBe('It may not have saved. Showing the latest.')
      expect(amount(EF).value).toBe('1500')
      expect(updateButton(EF).disabled).toBe(true)
    })

    // A refusal wrote nothing, so what was typed is still the person's, whatever reloads after.
    it('keeps a refused amount when a later reload arrives', async () => {
      vi.stubGlobal('fetch', answering(() => refused(500, 'That could not be saved. Please try again.')))
      const { rerender } = render(<GoalsList {...props} />)
      updateEmergencyFund()
      await screen.findByRole('alert')
      rerender(<GoalsList {...props} initialGoals={reloaded(1200)} />)
      expect(amount(EF).value).toBe('1500')
    })

    // #182: two quick updates, and the reload asked for after the first read the goals before the
    // second was written. Refilled from it, the field went back to the first amount, with Update
    // disabled beside it, until the next reload. Times are the server's clock: the route says when it
    // wrote (savedAt), and the page when it read (readAt). The Emergency fund starts at 1,200, read
    // at 1,000.
    describe('and a reload that read before the last update (#182)', () => {
      const TRY_AGAIN = 'That could not be saved. Please try again.'
      // An update of the Emergency fund, to `value` or to what the field holds, and the render after
      // it settles: every goal control is disabled until then.
      async function updateAndSettle(value?: string) {
        if (value !== undefined) fireEvent.change(amount(EF), { target: { value } })
        fireEvent.click(updateButton(EF))
        await waitFor(() => expect(amount(EF).disabled).toBe(false))
      }
      // A first update that lands, written at 2,000, then a second whose reply waits for the test.
      function firstSavedThenHeld() {
        let settle!: (res: Response) => void
        vi.stubGlobal(
          'fetch',
          vi
            .fn()
            .mockResolvedValueOnce(savedAt(2_000))
            .mockImplementationOnce(() => new Promise<Response>((resolve) => (settle = resolve)))
        )
        return (res: Response) => settle(res)
      }

      it("keeps the second update's amount when the first update's reload lands after it", async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(savedAt(2_000)).mockResolvedValueOnce(savedAt(3_000)))
        const { rerender } = render(<GoalsList {...props} />)
        await updateAndSettle('1500')
        await updateAndSettle('1700')
        // The first update's reload, read at 2,500: after it was written and before the second was.
        rerender(<GoalsList readAt={2_500} initialGoals={reloaded(1500)} />)
        expect(amount(EF).value).toBe('1700')
        expect(within(card(EF)).getByText(/\$1,700\.00 of \$3,000\.00/)).toBeTruthy()
        // The second's, read at 3,500.
        rerender(<GoalsList readAt={3_500} initialGoals={reloaded(1700)} />)
        expect(amount(EF).value).toBe('1700')
        expect(updateButton(EF).disabled).toBe(true)
      })

      // The page takes its time before reading and the route after writing, so a read stamped in the
      // same millisecond as the write may still have read before it. The next reload brings anything
      // newer, the other phone's amounts with it.
      it('does not refill from a read stamped at the time of the update, and does from one after it', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(savedAt(2_000)))
        const { rerender } = render(<GoalsList {...props} />)
        await updateAndSettle('1500')
        rerender(<GoalsList readAt={2_000} initialGoals={reloaded(1200)} />)
        expect(amount(EF).value).toBe('1500')
        // Read just after: the other phone has set it to 1,600 since.
        rerender(<GoalsList readAt={2_001} initialGoals={reloaded(1600)} />)
        expect(amount(EF).value).toBe('1600')
      })

      // Tapped again before the first update's reload lands, Update sends the same amount, so the
      // field holds what it sent while the second update is in flight, and that reload, read before
      // the second was written, can land meanwhile. Refilled from it, the field took the other
      // phone's 1,600 and, once the second update was confirmed, kept it as typing: the reload after
      // never refilled the 1,500 the server held, and Update would have written 1,600 back.
      it('refills nothing while its update is in flight', async () => {
        const settle = firstSavedThenHeld()
        const { rerender } = render(<GoalsList {...props} />)
        await updateAndSettle('1500')
        fireEvent.click(updateButton(EF))
        // The first update's reload, read at 2,500: the other phone has set it to 1,600 since.
        rerender(<GoalsList readAt={2_500} initialGoals={reloaded(1600)} />)
        expect(amount(EF).value).toBe('1500')
        settle(savedAt(3_000))
        await waitFor(() => expect(amount(EF).disabled).toBe(false))
        rerender(<GoalsList readAt={3_500} initialGoals={reloaded(1500)} />)
        expect(amount(EF).value).toBe('1500')
        expect(updateButton(EF).disabled).toBe(true)
      })

      // Nothing reloads after a refusal, so a reload held back while the update was in flight is
      // applied once it is refused. Left unapplied, the field kept 1,500 beside the other phone's
      // 1,600, with Update enabled to write it back.
      it('applies a reload that landed during a refused update once it is refused', async () => {
        const settle = firstSavedThenHeld()
        const { rerender } = render(<GoalsList {...props} />)
        await updateAndSettle('1500')
        fireEvent.click(updateButton(EF))
        rerender(<GoalsList readAt={2_500} initialGoals={reloaded(1600)} />)
        settle(refused(500, TRY_AGAIN))
        await within(card(EF)).findByRole('alert')
        expect(amount(EF).value).toBe('1600')
        expect(updateButton(EF).disabled).toBe(true)
      })

      // Applied again after a refusal, the page is still only as new as its read: one made before the
      // last confirmed update refills nothing it sent.
      it('does not apply a reload older than the last update once a later one is refused', async () => {
        const settle = firstSavedThenHeld()
        const { rerender } = render(<GoalsList {...props} />)
        await updateAndSettle('1500')
        fireEvent.click(updateButton(EF))
        // Read at 1,500, before the first update was written.
        rerender(<GoalsList readAt={1_500} initialGoals={reloaded(1200)} />)
        settle(refused(500, TRY_AGAIN))
        await within(card(EF)).findByRole('alert')
        expect(amount(EF).value).toBe('1500')
      })

      // A card holds back only what its own update sent. Held back too, another goal's change from
      // the other phone was lost when the update was refused, since nothing reloads after one, and
      // that goal's Update was left enabled to write its old amount back.
      it("follows another goal's change from the other phone while an update is in flight, and after it is refused", async () => {
        let settle!: (res: Response) => void
        vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => (settle = resolve))))
        const { rerender } = render(<GoalsList {...props} />)
        updateEmergencyFund('1500')
        // Read at 1,500: the other phone has set the roof fund to 450.
        rerender(<GoalsList readAt={1_500} initialGoals={[{ ...props.initialGoals[0] }, { ...props.initialGoals[1], saved_amount: 450 }]} />)
        expect(amount(ROOF).value).toBe('450')
        settle(refused(500, TRY_AGAIN))
        await within(card(EF)).findByRole('alert')
        expect(amount(ROOF).value).toBe('450')
        expect(amount(EF).value).toBe('1500')
      })
    })
  })

  describe('delete', () => {
    it('deletes the goal once confirmed, and reloads', async () => {
      const fetchMock = answering(saved)
      vi.stubGlobal('fetch', fetchMock)
      render(<GoalsList {...props} />)
      deleteEmergencyFund()
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
      expect(sent(fetchMock)).toEqual({ url: '/api/goals', method: 'DELETE', body: { id: '1' } })
      expect(screen.queryByRole('alert')).toBeNull()
    })

    it.each([
      ['a refusal', () => answering(() => refused(500, 'That goal could not be deleted. Please try again.')), 'That goal could not be deleted. Please try again.', 0],
      ['a redirect to the login page', () => answering(redirectedToLogin), 'Your session ended. Sign in again.', 0],
      // Already deleted on the other phone: the list is stale.
      ['a refusal because the goal is gone', () => answering(() => refused(404, 'That goal was already deleted.')), 'That goal was already deleted.', 1],
      ['a gateway error page', () => answering(badGateway), 'It may not have saved. Showing the latest.', 1],
      ['a request that fails in flight', () => offline(), 'It may not have saved. Showing the latest.', 1],
    ])('after %s, says why on that goal and re-enables', async (_, fetchMock, message, reloads) => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.stubGlobal('fetch', fetchMock())
      render(<GoalsList {...props} />)
      deleteEmergencyFund()
      const alert = await within(card(EF)).findByRole('alert')
      expect(alert.textContent).toBe(message)
      expect(controls().every((c) => !c.disabled)).toBe(true)
      expect(refresh).toHaveBeenCalledTimes(reloads)
    })

    it('gives up on a delete that never settles: says so, reloads and re-enables every control', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      useFakeSaveClock()
      vi.stubGlobal('fetch', neverSettles())
      render(<GoalsList {...props} />)
      deleteEmergencyFund()
      expect(controls().every((c) => c.disabled)).toBe(true)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS)
      })
      expect(within(card(EF)).getByRole('alert').textContent).toBe('It may not have saved. Showing the latest.')
      expect(controls().every((c) => !c.disabled)).toBe(true)
      expect(refresh).toHaveBeenCalledTimes(1)
    })
  })

  // Each failure belongs to the control it was made at, and only that control's next save clears it.
  describe('failures', () => {
    const TRY_AGAIN = 'That could not be saved. Please try again.'
    // A save that settles when the test says.
    const deferred = () => {
      let resolveIt!: (res: Response) => void
      const promise = () => new Promise<Response>((resolve) => (resolveIt = resolve))
      return { promise, settle: (res: Response) => resolveIt(res) }
    }

    // #177 review: one failure for the whole list was cleared by any save, so after another goal's
    // save the refused card still read "50%, $1,500.00 of $3,000.00" with nothing to say the server
    // held $1,200. The bar follows the field as a preview; the message that stays explains it.
    it("keeps a goal's refusal, beside the amount it explains, when another goal and the add form save", async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(refused(500, TRY_AGAIN)).mockResolvedValueOnce(saved()).mockResolvedValueOnce(saved()))
      const { rerender } = render(<GoalsList {...props} />)
      updateEmergencyFund('1500')
      await within(card(EF)).findByRole('alert')
      fireEvent.change(amount(ROOF), { target: { value: '450' } })
      fireEvent.click(updateButton(ROOF))
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
      addVacation()
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2))
      // The reload after both saves: the server still holds $1,200.
      rerender(<GoalsList {...props} initialGoals={[{ ...props.initialGoals[0] }, { ...props.initialGoals[1], saved_amount: 450 }]} />)
      expect(within(card(EF)).getByRole('alert').textContent).toBe(TRY_AGAIN)
      expect(screen.getAllByRole('alert')).toHaveLength(1)
      expect(amount(EF).value).toBe('1500')
      expect(within(card(EF)).getByText(/\$1,500\.00 of \$3,000\.00/)).toBeTruthy()
      expect(within(card(EF)).getByText('50%')).toBeTruthy()
    })

    // A failure left beside that goal's next save would be read as that save's.
    it("clears a goal's failure once that goal's next save starts", async () => {
      const next = deferred()
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(refused(500, TRY_AGAIN)).mockImplementationOnce(next.promise))
      render(<GoalsList {...props} />)
      updateEmergencyFund('1500')
      await within(card(EF)).findByRole('alert')
      fireEvent.click(updateButton(EF))
      expect(screen.queryByRole('alert')).toBeNull()
      next.settle(saved())
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
      expect(screen.queryByRole('alert')).toBeNull()
    })

    it("keeps the add form's failure when a goal saves, and clears it once the form's next save starts", async () => {
      const next = deferred()
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce(refused(500, TRY_AGAIN)).mockResolvedValueOnce(saved()).mockImplementationOnce(next.promise)
      )
      render(<GoalsList {...props} />)
      addVacation()
      await within(addCard()).findByRole('alert')
      updateEmergencyFund('1500')
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
      expect(within(addCard()).getByRole('alert').textContent).toBe(TRY_AGAIN)
      fireEvent.click(addButton())
      expect(screen.queryByRole('alert')).toBeNull()
      next.settle(saved())
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2))
      expect(screen.queryByRole('alert')).toBeNull()
    })
  })

  // A goal's failure whose card a reload drops: the message would go with the card, so the list
  // says it instead, once, in words that fit a page that has already reloaded.
  describe('a goal a reload no longer lists', () => {
    const withoutEmergencyFund = () => [{ ...props.initialGoals[1] }]
    const goneLine = () => screen.getByRole('alert')
    // At the top of the list: after the add form's card, before the goals.
    function expectAtTopOfList(alert: HTMLElement) {
      expect(addCard().contains(alert)).toBe(false)
      expect(addCard().compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(alert.compareDocumentPosition(card(ROOF)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }

    // #177 review: the 404's own reload dropped the card and its message with it, so to the person
    // the goal just disappeared after Update.
    it('after an update refused because the goal is gone, says so at the top of the list once its card goes', async () => {
      vi.stubGlobal('fetch', answering(() => refused(404, 'That goal no longer exists.')))
      const { rerender } = render(<GoalsList {...props} />)
      updateEmergencyFund()
      await within(card(EF)).findByRole('alert')
      rerender(<GoalsList {...props} initialGoals={withoutEmergencyFund()} />)
      expect(screen.queryByLabelText(`Amount saved for ${EF}`)).toBeNull()
      expect(goneLine().textContent).toBe('That goal no longer exists.')
      expectAtTopOfList(goneLine())
    })

    it('after a delete refused because the goal was already deleted, says so at the top of the list once its card goes', async () => {
      vi.stubGlobal('fetch', answering(() => refused(404, 'That goal was already deleted.')))
      const { rerender } = render(<GoalsList {...props} />)
      deleteEmergencyFund()
      await within(card(EF)).findByRole('alert')
      rerender(<GoalsList {...props} initialGoals={withoutEmergencyFund()} />)
      expect(goneLine().textContent).toBe('That goal was already deleted.')
      expectAtTopOfList(goneLine())
    })

    // It may have saved, and the reload shows it did. "It may not have saved" would argue with the
    // list, so the line says what the list shows.
    it('after a delete whose outcome is unknown, says the goal no longer exists once the reload drops it', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.stubGlobal('fetch', offline())
      const { rerender } = render(<GoalsList {...props} />)
      deleteEmergencyFund()
      expect((await within(card(EF)).findByRole('alert')).textContent).toBe('It may not have saved. Showing the latest.')
      rerender(<GoalsList {...props} initialGoals={withoutEmergencyFund()} />)
      expect(goneLine().textContent).toBe('That goal no longer exists.')
    })

    it('says it once: the next save clears it, and a later reload does not bring it back', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(refused(404, 'That goal no longer exists.')).mockResolvedValueOnce(saved()))
      const { rerender } = render(<GoalsList {...props} />)
      updateEmergencyFund()
      await within(card(EF)).findByRole('alert')
      rerender(<GoalsList {...props} initialGoals={withoutEmergencyFund()} />)
      expect(goneLine().textContent).toBe('That goal no longer exists.')
      fireEvent.change(amount(ROOF), { target: { value: '450' } })
      fireEvent.click(updateButton(ROOF))
      expect(screen.queryByRole('alert')).toBeNull()
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2))
      rerender(<GoalsList {...props} initialGoals={withoutEmergencyFund()} />)
      expect(screen.queryByRole('alert')).toBeNull()
    })

    it('says nothing for a goal deleted without a failure', async () => {
      vi.stubGlobal('fetch', answering(saved))
      const { rerender } = render(<GoalsList {...props} />)
      deleteEmergencyFund()
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
      rerender(<GoalsList {...props} initialGoals={withoutEmergencyFund()} />)
      expect(screen.queryByRole('alert')).toBeNull()
    })
  })
})
