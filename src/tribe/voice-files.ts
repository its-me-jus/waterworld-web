/**
 * Which recorded voice files ship in public/audio/voices/<name>.mp3.
 * Written by shots/sound/pick-voices.py when takes are chosen; listing them
 * here (rather than probing) means a missing file never costs a 404.
 * A name listed here plays its file; a name not listed keeps its procedural
 * voice from tribe-sound.ts.
 */
import type { VoiceName } from './tribe-sound'

export const VOICE_FILES: readonly VoiceName[] = ['kael-breath', 'kael-charge', 'kael-exhale', 'kael-sigh', 'kael-snort', 'oru-chuckle', 'oru-hm', 'oru-yes', 'tala-breath', 'tala-call', 'tala-eh', 'tala-gasp', 'tala-laugh']
