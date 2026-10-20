#!/usr/bin/env node
// check-starred.mjs: makes sure every repo in credits.json is one 2three1y has starred.
//   node tools/check-starred.mjs                 checks against starred.txt (a snapshot)
//   node tools/check-starred.mjs path/to/list.txt
//   GITHUB_TOKEN=... node tools/check-starred.mjs --live
//       asks GitHub directly (GET /user/starred/OWNER/REPO answers 204 when starred;
//       the token must belong to 2three1y)
// Exits with code 1 if any credited repo is not starred.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const data = JSON.parse(readFileSync(join(root, 'credits.json'), 'utf8'))
const repos = [...data.credits.map((c) => c.repo), ...(data.testing_only || []).map((t) => t.repo)]
const args = process.argv.slice(2)
const live = args.includes('--live')
let missing = 0

if (live) {
  const token = process.env.GITHUB_TOKEN
  if (!token) { console.error('--live needs GITHUB_TOKEN'); process.exit(2) }
  for (const r of repos) {
    const res = await fetch(`https://api.github.com/user/starred/${r}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } })
    const ok = res.status === 204
    if (!ok) missing++
    console.log(`${ok ? 'starred    ' : 'NOT STARRED'}  ${r}`)
  }
} else {
  const file = args.find((a) => !a.startsWith('--')) || join(root, 'starred.txt')
  const starred = new Set(
    readFileSync(file, 'utf8').split('\n')
      .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
      .map((l) => l.split(/\s*\|\s*/)[0].toLowerCase()),
  )
  for (const r of repos) {
    const ok = starred.has(r.toLowerCase())
    if (!ok) missing++
    console.log(`${ok ? 'starred    ' : 'NOT STARRED'}  ${r}`)
  }
}
console.log(missing ? `\n${missing} credited repo(s) are not starred.` : `\nAll ${repos.length} credited repos are starred.`)
process.exit(missing ? 1 : 0)
