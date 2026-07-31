/**
 * HUD — the least UI that still communicates.
 *
 * Whisper lines used to name what the body already told you ("Your stomach
 * knots."). That got in the way of discovery — the ocean should leave you
 * alone to figure it out. `whisper` is kept as a silent no-op so call sites
 * stay cheap to write, but nothing ever appears on screen.
 *
 * What remains: the contextual interaction prompt ("F — pry the crate open")
 * and the touch palm button. No meters, no bars, no narrative text.
 */
export function createHud(app: HTMLElement) {
  const promptEl = document.createElement('div')
  promptEl.id = 'prompt'
  app.appendChild(promptEl)

  return {
    /** Silent. Kept so callers don't care that narrative text is off. */
    whisper(_text: string) {},
    /** Set (or clear, with null) the contextual interaction hint. */
    setPrompt(text: string | null) {
      if (text) {
        promptEl.textContent = text
        promptEl.classList.add('show')
      } else {
        promptEl.classList.remove('show')
      }
    },
    get promptShowing() {
      return promptEl.classList.contains('show')
    },
  }
}

export type Hud = ReturnType<typeof createHud>
