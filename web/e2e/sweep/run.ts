// Entry point for `just sweep`. Turns flags into the env sweep.spec.ts reads and
// runs it under playwright.sweep.config.ts.
//
//   bun e2e/sweep/run.ts [--only settings,share] [--state doctor] [--sizes phone]
//     [--schemes dark] [--list]
//
// --only filters by area, --state by id substring; a narrowed run reshoots
// those states in place and merges them into sweep-out/manifest.json. --list
// prints the selected states without starting a browser.
import { spawnSync } from 'node:child_process'
import { selectStates } from './manifest'

const argv = process.argv.slice(2)
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return undefined
  const value = argv[i + 1]
  if (!value || value.startsWith('--')) throw new Error(`--${name} needs a value`)
  return value
}
const known = new Set(['--only', '--state', '--sizes', '--schemes', '--list'])
for (const a of argv) if (a.startsWith('--') && !known.has(a)) throw new Error(`unknown flag ${a}`)

const only = arg('only')
const state = arg('state')
const states = selectStates({ only: only?.split(','), state })

if (argv.includes('--list')) {
  for (const s of states) console.log(`${s.area.padEnd(12)} ${s.id.padEnd(26)} #${s.route}`)
  console.log(`${states.length} states`)
  process.exit(0)
}
if (!states.length) {
  console.error('no sweep states match; try --list')
  process.exit(1)
}

const started = Date.now()
const result = spawnSync('bunx', ['playwright', 'test', '-c', 'playwright.sweep.config.ts'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    SWEEP: '1',
    SWEEP_ONLY: only ?? '',
    SWEEP_STATE: state ?? '',
    SWEEP_SIZES: arg('sizes') ?? '',
    SWEEP_SCHEMES: arg('schemes') ?? '',
  },
})
console.log(`sweep finished in ${Math.round((Date.now() - started) / 1000)}s`)
process.exit(result.status ?? 1)
