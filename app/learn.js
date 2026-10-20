// learn.js: Learn mode. The letter order, the "learned after 2 right" rule
// and the practice words come from googlecreativelab/morse-learn (Apache-2.0).
import { lettersToLearn, LEARNED_THRESHOLD, words } from '../vendor/morse-learn/morse-learn-data.mjs'
import { Keyer, timing } from './keyer.js'
import { toMorse, spell, charName, codeTokens } from './morse.js'
import { earcon, playTokens, unlockAudio } from './audio.js'
import { buzzSymbol } from './haptics.js'
import { announce } from './announcer.js'

const $ = (id) => document.getElementById(id)
const KEY = 'tap-party-learn'
let state = { unlocked: 1, scores: {} }
let target = null // { kind: 'letter' | 'word', text, pos }
let keyer = null

export const learnActive = () => !$('view-learn').hidden

const skipWords = new Set(['postmark']) // left out of practice
const practiceWords = words.filter((w) => !skipWords.has(w))
const load = () => { try { state = { unlocked: 1, scores: {}, ...JSON.parse(localStorage.getItem(KEY) || '{}') } } catch {} }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)) } catch {} }
const pool = () => lettersToLearn.slice(0, state.unlocked)
const score = (l) => state.scores[l] || 0
const describe = (ch) => `${charName(ch)}, ${spell(toMorse[ch])}`

function pickTarget() {
  const letters = pool()
  const newest = letters[letters.length - 1]
  if (score(newest) < LEARNED_THRESHOLD || letters.length < 3) {
    const unsure = letters.filter((l) => score(l) < LEARNED_THRESHOLD)
    const pickFrom = unsure.length ? unsure : letters
    const l = pickFrom.includes(newest) && Math.random() < 0.6 ? newest : pickFrom[Math.floor(Math.random() * pickFrom.length)]
    target = { kind: 'letter', text: l, pos: 0 }
  } else {
    const fits = practiceWords.filter((w) => w.length <= 6 && [...w].every((c) => letters.includes(c)) && w.includes(newest))
    const any = fits.length ? fits : practiceWords.filter((w) => w.length <= 6 && [...w].every((c) => letters.includes(c)))
    if (any.length && Math.random() < 0.5) target = { kind: 'word', text: any[Math.floor(Math.random() * any.length)], pos: 0 }
    else target = { kind: 'letter', text: letters[Math.floor(Math.random() * letters.length)], pos: 0 }
  }
}

function promptText() {
  if (!target) return ''
  if (target.kind === 'letter') return `Tap the letter ${describe(target.text)}.`
  const done = target.text.slice(0, target.pos)
  const next = target.text[target.pos]
  return `Tap the word "${target.text}"${done ? `. Done so far: ${done}` : ''}. Next letter: ${describe(next)}.`
}

function render(say) {
  $('learn-prompt').textContent = promptText()
  const learned = pool().filter((l) => score(l) >= LEARNED_THRESHOLD).length
  $('learn-progress').textContent = `You have learned ${learned} of ${lettersToLearn.length} letters. Unlocked so far: ${pool().map((l) => l.toUpperCase()).join(' ')}.`
  if (say) announce(promptText())
}

function bump(letter, d) {
  const max = LEARNED_THRESHOLD + 2, min = -LEARNED_THRESHOLD - 2
  state.scores[letter] = Math.max(min, Math.min(max, score(letter) + d))
}

function maybeUnlock() {
  const letters = pool()
  const newest = letters[letters.length - 1]
  if (score(newest) >= LEARNED_THRESHOLD && state.unlocked < lettersToLearn.length) {
    state.unlocked++
    const fresh = lettersToLearn[state.unlocked - 1]
    earcon('learned')
    return `You learned ${charName(newest)}. New letter unlocked: ${describe(fresh)}.`
  }
  return ''
}

function onLetter(ch) {
  if (!target) return
  const want = target.kind === 'letter' ? target.text : target.text[target.pos]
  if (ch === want) {
    bump(want, 1)
    if (target.kind === 'word' && target.pos < target.text.length - 1) {
      target.pos++
      earcon('right')
      save()
      render(false)
      announce(`Right. Next: ${describe(target.text[target.pos])}`)
      return
    }
    earcon('right')
    const extra = maybeUnlock()
    const finished = target.kind === 'word' ? `Right! You tapped "${target.text}".` : 'Right!'
    save()
    pickTarget()
    render(false)
    announce([finished, extra, promptText()].filter(Boolean).join(' '))
  } else {
    bump(want, -1)
    earcon('wrong')
    save()
    render(false)
    announce(`That was ${describe(ch)}. You need ${describe(want)}. Try again.`)
  }
}

function hear() {
  unlockAudio()
  if (!target) return
  const text = target.kind === 'letter' ? target.text : target.text.slice(target.pos)
  playTokens(codeTokens(text), timing().unit * 1.3, 650, (s) => buzzSymbol(s, timing().unit))
}

export function initLearn() {
  load()
  keyer = new Keyer({
    pad: $('learn-pad'),
    freq: 600,
    onLetter,
    onUnknown(code) { earcon('wrong') },
    onChange() { $('learn-current').textContent = keyer.current ? spell(keyer.current) : 'none' },
  })
  $('learn-dot').addEventListener('click', () => keyer.addSymbol('.'))
  $('learn-dash').addEventListener('click', () => keyer.addSymbol('-'))
  $('learn-end').addEventListener('click', () => { if (!keyer.endLetter()) announce('No letter to end') })
  $('learn-hear').addEventListener('click', hear)
  $('learn-skip').addEventListener('click', () => { pickTarget(); render(true) })
  $('learn-reset').addEventListener('click', () => {
    state = { unlocked: 1, scores: {} }
    save(); pickTarget(); render(false)
    announce('Progress reset. ' + promptText())
  })
  const list = $('learn-letters')
  for (const l of lettersToLearn) {
    const li = document.createElement('li')
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'btn letter'
    b.textContent = `${l.toUpperCase()}: ${spell(toMorse[l])}`
    b.addEventListener('click', () => { unlockAudio(); playTokens(codeTokens(l), timing().unit * 1.3, 650, (s) => buzzSymbol(s, timing().unit)) })
    li.append(b)
    list.append(li)
  }
  $('learn-play-form').addEventListener('submit', (e) => {
    e.preventDefault()
    unlockAudio()
    const t = $('learn-play-text').value
    const tokens = codeTokens(t)
    if (!tokens.length) { announce('Type some letters or numbers first.'); return }
    playTokens(tokens, timing().unit, 650, (s) => buzzSymbol(s, timing().unit))
  })
  pickTarget()
  render(false)
}
