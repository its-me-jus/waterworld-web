/**
 * The HUD stays out of the way on purpose: nothing here tells you where to go
 * or what exists. The one thing it carries is the whisper — a single fading
 * line that names something the world is already doing ("The tide is
 * turning."), queued so a run of them can't stomp each other.
 */

const WHISPER_SECONDS = 4.2
const WHISPER_QUEUE_MAX = 4

export function createHud(app: HTMLElement) {
  const whisperBox = document.createElement('div')
  whisperBox.id = 'whisper'
  app.appendChild(whisperBox)

  const queue: string[] = []
  let timer = 0
  let showing = false

  /** A quiet one-liner, queued so several can't stomp each other. */
  function whisper(text: string) {
    if (queue.length < WHISPER_QUEUE_MAX) queue.push(text)
  }

  function update(dt: number) {
    timer -= dt
    if (timer > 0) return
    const next = queue.shift()
    if (next) {
      whisperBox.textContent = next
      whisperBox.classList.add('on')
      showing = true
      timer = WHISPER_SECONDS
    } else if (showing) {
      whisperBox.classList.remove('on')
      showing = false
    }
  }

  return { whisper, update }
}

export type Hud = ReturnType<typeof createHud>
