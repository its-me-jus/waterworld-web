/**
 * Rasterise the app icons from their SVG sources.
 *
 * Installed-app icons have to be PNG — Android and iOS both refuse SVG for the
 * home screen — but keeping the artwork as SVG means there is still exactly one
 * copy of it. Chrome is already a dev dependency for the shot suite, so it does
 * the rasterising rather than pulling in an image library.
 *
 *   npm run icons
 */
import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CHROME = process.env.CHROME ?? '/usr/local/bin/google-chrome'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const publicDir = join(root, 'public')

/** [source svg, output png, pixel size]. */
const TARGETS = [
  ['favicon.svg', 'icon-192.png', 192],
  ['favicon.svg', 'icon-512.png', 512],
  ['favicon.svg', 'apple-touch-icon.png', 180],
  ['icon-maskable.svg', 'icon-maskable-512.png', 512],
]

const browser = await chromium.launch({ executablePath: CHROME })

for (const [source, output, size] of TARGETS) {
  const svg = readFileSync(join(publicDir, source), 'utf8')
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
  })
  await page.setContent(
    `<!doctype html><style>
      html,body{margin:0;padding:0;width:${size}px;height:${size}px;overflow:hidden}
      svg{display:block;width:${size}px;height:${size}px}
    </style>${svg}`,
    { waitUntil: 'load' },
  )
  await page.screenshot({ path: join(publicDir, output), omitBackground: false })
  await page.close()
  console.log(`${output}  ${size}×${size}`)
}

await browser.close()
console.log('icons written to public/')
