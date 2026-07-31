/**
 * Whisper HUD — the least UI that still communicates.
 *
 * Two elements, both diegetic-adjacent and quiet:
 *  - whispers: one-line thoughts that fade in and out ("Your stomach knots.")
 *  - prompt: the contextual interaction hint ("F — pry the crate open")
 *
 * No meters, no bars. Breath, hunger and fatigue speak through the body —
 * vignette, tremor, cadence — and these lines only name what the body
 * already told you.
 */
export function createHud(app: HTMLElement) {
  const whisperEl = document.createElement('div')
  whisperEl.id = 'whisper'
  app.appendChild(whisperEl)

  const promptEl = document.createElement('div')
  promptEl.id = 'prompt'
  app.appendChild(promptEl)

  const queue: string[] = []
  let showing = false

  function pump() {
    if (showing) return
    const text = queue.shift()
    if (text === undefined) return
    showing = true
    whisperEl.textContent = text
    whisperEl.classList.add('show')
    window.setTimeout(() => whisperEl.classList.remove('show'), 3400)
    window.setTimeout(() => {
      showing = false
      pump()
    }, 4300)
  }

  return {
    /** Queue a quiet one-liner. Duplicates back-to-back are dropped. */
    whisper(text: string) {
      if (queue[queue.length - 1] === text) return
      queue.push(text)
      pump()
    },
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
