import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(root, 'tools/blender/create_swimmer_hand.py')
const candidates = [
  process.env.BLENDER,
  'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe',
  'C:/Program Files/Blender Foundation/Blender 4.5/blender.exe',
  'blender',
].filter(Boolean)

const blender = candidates.find((p) => p === 'blender' || existsSync(p))
if (!blender) {
  console.error('Blender not found. Set BLENDER to the blender.exe path.')
  process.exit(1)
}

const result = spawnSync(blender, ['--background', '--python', script], {
  stdio: 'inherit',
  shell: false,
})
process.exit(result.status ?? 1)
