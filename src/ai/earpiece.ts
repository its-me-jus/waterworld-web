import type { StoryState } from './contract.ts'

/** Supply grounded terrain elevation in metres, or pass onFoot=false while gliding/swimming. */
export function createEarpiece() {
  let onRidge = false
  let index = 0
  function update(altitude: number, state: StoryState, onFoot = true): string | null {
    if (!Number.isFinite(altitude)) return null
    if (altitude <= 16) onRidge = false
    if (!onFoot || altitude <= 18 || onRidge || state.ending) return null
    onRidge = true
    const cash = '$' + state.cashAmount.toLocaleString('en-US')
    const { timesCaptured, metOru, metTala } = state.flags
    let message: string
    if (state.bagState === 'stashed_caves') message = 'You put ' + cash + ' in a tidal cave? Terrific. What time does the branch flood?'
    else if (state.bagState === 'dropped') message = 'Where’s the duffel? I can hear two hands climbing. That is one hand too many.'
    else if (timesCaptured) message = 'Still got ' + cash + '? Blink twice if we need to add another deductible.'
    else if (state.cashAmount < 2_400_000) message = cash + ' left? That better be the tide rounding down.'
    else if (metOru) message = 'If the elder asks what I bring to the table, say a plane. Past tense. Quietly.'
    else if (metTala) message = 'Your diver reads cargo manuals? Ask if there’s a chapter on returning a plane without the plane.'
    else if (state.relationships.kael.met) message = 'He’s got a spear? Tell him the bag is already perforated for drainage.'
    else message = [
      'Two point four million. All I need to hear is a zipper. Give me one reassuring little zip.',
      'You hear surf. I hear two point four million dollars on the delicate cycle.',
    ][index % 2]
    index++
    return 'Vince [static]  “' + message + '”'
  }
  return { update, reset() { onRidge = false; index = 0 } }
}
