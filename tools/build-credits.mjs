#!/usr/bin/env node
// build-credits.mjs: credits.json is the source. This writes:
//   - the CREDITS section of README.md (between the CREDITS markers)
//   - the Credits page in index.html (between the CREDITS markers), made of headings and lists
// Run: node tools/build-credits.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const data = JSON.parse(readFileSync(join(root, 'credits.json'), 'utf8'))
const START = '<!-- CREDITS:START -->'
const END = '<!-- CREDITS:END -->'
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function replaceBetween(text, inner) {
  const a = text.indexOf(START), b = text.indexOf(END)
  if (a < 0 || b < a) throw new Error('CREDITS markers not found')
  return text.slice(0, a + START.length) + '\n' + inner + '\n' + text.slice(b)
}

// ---- README (Markdown) ----
const md = []
md.push(`Every library in ${data.project} comes from a repo [2three1y](https://github.com/2three1y) has starred. ${data.credits.length} starred repos went in.`, '')
for (const c of data.credits) {
  md.push(`### ${c.name}`, '')
  md.push(`- Repo: [${c.repo}](${c.link})`)
  md.push(`- Author: ${c.author}`)
  md.push(`- License: ${c.license} ([full text](${c.license_file}))`)
  md.push(`- Used for: ${c.used_for}`)
  md.push(`- Files: ${c.files.join('; ')}`)
  md.push(`- Changes: ${c.changes}`)
  md.push(`- Notice: ${c.notice}`, '')
}
md.push('### Looked at, not used', '')
for (const n of data.not_used) md.push(`- ${n.repo}: ${n.why}`)
md.push('', '### Used only for testing', '')
for (const t of data.testing_only) md.push(`- [${t.repo}](https://github.com/${t.repo}) (${t.license}): ${t.why}`)
const readmePath = join(root, 'README.md')
writeFileSync(readmePath, replaceBetween(readFileSync(readmePath, 'utf8'), md.join('\n').trim()))

// ---- Credits page (HTML: headings and lists, no tables) ----
const h = []
h.push(`<p>Every library in ${esc(data.project)} comes from a repo that <a href="https://github.com/2three1y">2three1y</a> has starred on GitHub. ${data.credits.length} starred repos went in.</p>`)
h.push('<h2>Starred repos used</h2>')
h.push('<ul class="credits-list">')
for (const c of data.credits) {
  h.push('<li>')
  h.push(`<h3>${esc(c.name)}</h3>`)
  h.push('<ul>')
  h.push(`<li>Repo: <a href="${esc(c.link)}">${esc(c.repo)}</a></li>`)
  h.push(`<li>Author: ${esc(c.author)}</li>`)
  h.push(`<li>License: ${esc(c.license)}, <a href="${esc(c.license_file)}">full ${esc(c.license)} text for ${esc(c.name)}</a></li>`)
  h.push(`<li>Used for: ${esc(c.used_for)}</li>`)
  h.push(`<li>Changes: ${esc(c.changes)}</li>`)
  h.push(`<li>Notice: ${esc(c.notice)}</li>`)
  h.push('</ul>')
  h.push('</li>')
}
h.push('</ul>')
h.push('<h2>Looked at, not used</h2>')
h.push('<ul>')
for (const n of data.not_used) h.push(`<li>${esc(n.repo)}: ${esc(n.why)}</li>`)
h.push('</ul>')
h.push('<h2>Used only for testing</h2>')
h.push('<ul>')
for (const t of data.testing_only) h.push(`<li><a href="https://github.com/${esc(t.repo)}">${esc(t.repo)}</a> (${esc(t.license)}): ${esc(t.why)}</li>`)
h.push('</ul>')
h.push('<h2>Tap Party itself</h2>')
h.push('<p>Tap Party is MIT licensed. <a href="LICENSE">Tap Party licence</a>, <a href="NOTICE">NOTICE file</a>, <a href="https://github.com/2three1y/tap-party">source code on GitHub</a>.</p>')
const indexPath = join(root, 'index.html')
writeFileSync(indexPath, replaceBetween(readFileSync(indexPath, 'utf8'), h.join('\n')))
console.log(`Wrote CREDITS for ${data.credits.length} repos to README.md and index.html`)
