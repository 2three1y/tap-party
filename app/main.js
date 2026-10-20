// main.js: Tap Party. Pages, the room, and wiring everything together.
import A11yDialog from '../vendor/a11y-dialog/a11y-dialog.esm.js'
import { words as learnWords } from '../vendor/morse-learn/morse-learn-data.mjs'
import { Keyer, keyerSettings, timing } from './keyer.js'
import { charName, cleanText, codeTokens, spell } from './morse.js'
import { audioSettings, earcon, playSymbol, playTokens, unlockAudio } from './audio.js'
import { hapticSettings, buzzSymbol } from './haptics.js'
import { initAnnouncer, announce } from './announcer.js'
import { toBraille } from './braille-text.js'
import { openRoom, relayCount, selfId } from './net.js'
import { initLearn, learnActive } from './learn.js'

const $ = (id) => document.getElementById(id)
initAnnouncer($('announcer'))

// ---------- settings ----------
const defaults = {
  name: '', speed: 'slow', autoLetter: true, sayLetters: true, saySymbols: false,
  tones: true, earcons: true, haptics: true, live: true, autoplay: false,
}
let prefs = { ...defaults }
try { prefs = { ...defaults, ...JSON.parse(localStorage.getItem('tap-party-settings') || '{}') } } catch {}
const savePrefs = () => { try { localStorage.setItem('tap-party-settings', JSON.stringify(prefs)) } catch {} }
function applyPrefs() {
  keyerSettings.speed = prefs.speed
  keyerSettings.autoLetter = prefs.autoLetter
  keyerSettings.sayLetters = prefs.sayLetters
  keyerSettings.saySymbols = prefs.saySymbols
  audioSettings.tones = prefs.tones
  audioSettings.earcons = prefs.earcons
  hapticSettings.on = prefs.haptics
}
applyPrefs()
const boxes = { 'set-auto': 'autoLetter', 'set-say-letters': 'sayLetters', 'set-say-symbols': 'saySymbols', 'set-tones': 'tones', 'set-earcons': 'earcons', 'set-haptics': 'haptics', 'set-live': 'live', 'set-autoplay': 'autoplay' }
for (const [id, key] of Object.entries(boxes)) {
  const el = $(id)
  el.checked = !!prefs[key]
  el.addEventListener('change', () => { prefs[key] = el.checked; applyPrefs(); savePrefs() })
}
for (const r of document.querySelectorAll('input[name="speed"]')) {
  r.checked = r.value === prefs.speed
  r.addEventListener('change', () => { if (r.checked) { prefs.speed = r.value; applyPrefs(); savePrefs() } })
}
$('set-name').value = prefs.name
$('set-name').addEventListener('change', () => {
  prefs.name = $('set-name').value.trim().slice(0, 24)
  savePrefs()
  if (room) room.send({ t: 'hello', name: prefs.name })
})

// ---------- dialogs (a11y-dialog) ----------
const appRoot = $('app')
const dialogs = {}
for (const id of ['settings-dialog', 'leave-dialog']) {
  const d = new A11yDialog($(id))
  d.on('show', () => { appRoot.inert = true })
  d.on('hide', () => { appRoot.inert = false })
  dialogs[id] = d
}

// ---------- time ----------
const hhmm = (ms) => { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') }

// ---------- pages ----------
const views = ['home', 'room', 'learn', 'braille', 'credits']
let currentView = null
function show(view) {
  for (const v of views) $('view-' + v).hidden = v !== view
  for (const a of document.querySelectorAll('.nav a')) {
    if (a.getAttribute('href') === location.hash || (view === 'home' && a.getAttribute('href') === '#/')) a.setAttribute('aria-current', 'page')
    else a.removeAttribute('aria-current')
  }
  const h1 = $('view-' + view).querySelector('h1')
  document.title = (view === 'home' ? 'Tap Party' : h1.textContent + ' · Tap Party')
  if (currentView !== null) h1.focus()
  currentView = view
  if (view === 'braille') renderBraille()
}

function route() {
  const h = location.hash.replace(/^#\/?/, '')
  const [page, code] = h.split('/')
  if (page === 'room' && code) {
    const c = normalizeCode(decodeURIComponent(code))
    if (!room || roomCode !== c) enterRoom(c)
    show('room')
  } else if (views.includes(page)) show(page)
  else show('home')
}
window.addEventListener('hashchange', route)

// ---------- room codes ----------
const skipWords = new Set(['postmark']) // never used as a room code
const codeWords = learnWords.filter((w) => /^[a-z]{3,6}$/.test(w) && !skipWords.has(w))
function newCode() {
  const pick = () => codeWords[crypto.getRandomValues(new Uint32Array(1))[0] % codeWords.length]
  return [pick(), pick(), pick()].join('-')
}
function normalizeCode(text) {
  let t = String(text).trim()
  const m = t.match(/#\/room\/([^/?#\s]+)/)
  if (m) t = decodeURIComponent(m[1])
  return t.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}
const roomUrl = (code) => location.origin + location.pathname + '#/room/' + encodeURIComponent(code)

$('new-room').addEventListener('click', () => { unlockAudio(); location.hash = '#/room/' + newCode() })
$('join-form').addEventListener('submit', (e) => {
  e.preventDefault()
  unlockAudio()
  const c = normalizeCode($('join-code').value)
  if (!c) {
    $('join-error').hidden = false
    $('join-error').textContent = 'Type a room code or paste a room link first.'
    announce($('join-error').textContent)
    $('join-code').focus()
    return
  }
  $('join-error').hidden = true
  location.hash = '#/room/' + c
})

// ---------- the room ----------
let room = null
let roomCode = ''
let peerNames = {}
let peerOrder = []
let statusTimer = null
const messages = []
let draft = ''

function peerName(id) {
  if (peerNames[id]) return peerNames[id]
  let n = peerOrder.indexOf(id)
  if (n < 0) { peerOrder.push(id); n = peerOrder.length - 1 }
  return 'Friend ' + (n + 1)
}
// Each friend's taps get their own pitch so you can tell them apart.
const peerFreq = (id) => [520, 780, 440, 880, 600, 700][Math.max(0, peerOrder.indexOf(id)) % 6]

function updateStatus() {
  if (!room) return
  const n = room.peers().length
  const relays = relayCount()
  const who = n === 0 ? 'No friends here yet' : n === 1 ? '1 friend here' : `${n} friends here`
  $('room-status').textContent = `${who}. ${relays ? `Connected to ${relays} Nostr relay${relays === 1 ? '' : 's'}.` : 'Connecting to Nostr relays…'}`
}

function enterRoom(code) {
  if (room) leaveRoom(true)
  roomCode = code
  peerNames = {}
  peerOrder = []
  const link = roomUrl(code)
  $('room-title').textContent = 'Room ' + code
  $('room-link').href = link
  $('room-link').textContent = link
  $('nav-room').href = '#/room/' + encodeURIComponent(code)
  $('nav-room-item').hidden = false
  $('share-link').hidden = !navigator.share
  room = openRoom(code, {
    onJoin(id) {
      peerName(id)
      room.send({ t: 'hello', name: prefs.name }, id)
      earcon('joined')
      buzzSymbol('.', 60)
      setTimeout(() => announce(`${peerName(id)} joined`), 900)
      updateStatus()
    },
    onLeave(id) {
      const name = peerName(id)
      earcon('left')
      announce(`${name} left`)
      updateStatus()
    },
    onData(data, id) { onPeerData(data, id) },
    onError(e) { $('room-status').textContent = 'Could not join this room: ' + (e?.error || 'unknown problem') },
  })
  updateStatus()
  clearInterval(statusTimer)
  statusTimer = setInterval(updateStatus, 3000)
  announce('Room ready. Share the room link with friends.')
}

function leaveRoom(quiet) {
  if (!room) return
  try { room.leave() } catch {}
  room = null
  clearInterval(statusTimer)
  $('nav-room-item').hidden = true
  if (!quiet) announce('You left the room')
}
$('leave-confirm').addEventListener('click', () => {
  dialogs['leave-dialog'].hide()
  leaveRoom()
  location.hash = '#/'
})
window.addEventListener('pagehide', () => { if (room) try { room.leave() } catch {} })

function onPeerData(data, id) {
  if (!data || typeof data !== 'object') return
  if (data.t === 'hello') {
    const name = String(data.name || '').trim().slice(0, 24)
    if (name) peerNames[id] = name
    else delete peerNames[id]
    peerName(id)
  } else if (data.t === 'sym' && (data.s === '.' || data.s === '-')) {
    if (prefs.live && !learnActive()) {
      playSymbol(data.s, timing().unit, peerFreq(id))
      buzzSymbol(data.s, timing().unit)
    }
  } else if (data.t === 'msg') {
    const text = cleanText(String(data.text || '')).slice(0, 500)
    if (!text) return
    addMessage({ from: peerName(id), text, at: Date.now(), mine: false, freq: peerFreq(id) })
    earcon('received')
    announce(`${peerName(id)}: ${text}`)
    if (prefs.autoplay) setTimeout(() => playMessage(text, peerFreq(id)), 700)
  }
}

function playMessage(text, freq = 650) {
  playTokens(codeTokens(text), timing().unit, freq, (sym) => buzzSymbol(sym, timing().unit))
}

function addMessage(m) {
  messages.push(m)
  $('log-empty').hidden = true
  const li = document.createElement('li')
  const p = document.createElement('p')
  p.textContent = `${hhmm(m.at)} ${m.mine ? 'You' : m.from}: ${m.text}`
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'btn small'
  b.textContent = 'Replay'
  b.setAttribute('aria-label', `Replay "${m.text}" as Morse`)
  b.addEventListener('click', () => { unlockAudio(); playMessage(m.text, m.freq) })
  li.append(p, b)
  $('log').append(li)
  if (currentView === 'braille') renderBraille()
}

// ---------- keyer in the room ----------
const roomKeyer = new Keyer({
  pad: $('room-pad'),
  onSymbol(sym) { if (room) room.send({ t: 'sym', s: sym }) },
  onLetter(ch) { draft += ch; renderDraft() },
  onChange() { $('room-current').textContent = roomKeyer.current ? spell(roomKeyer.current) : 'none' },
})
function renderDraft() {
  $('room-draft').textContent = draft ? draft : 'empty'
  $('braille-draft').textContent = toBraille(draft) || '⠀'
}
$('room-dot').addEventListener('click', () => roomKeyer.addSymbol('.'))
$('room-dash').addEventListener('click', () => roomKeyer.addSymbol('-'))
$('room-end').addEventListener('click', () => { if (!roomKeyer.endLetter()) announce('No letter to end') })
$('room-space').addEventListener('click', () => {
  roomKeyer.endLetter()
  if (draft && !draft.endsWith(' ')) { draft += ' '; renderDraft(); announce('space') }
})
$('room-delete').addEventListener('click', () => {
  if (roomKeyer.current) { roomKeyer.clear(); announce('Letter cleared'); return }
  if (!draft) { announce('Nothing to delete'); return }
  const gone = draft.slice(-1)
  draft = draft.slice(0, -1)
  renderDraft()
  announce(`Deleted ${charName(gone)}`)
})
$('room-clear').addEventListener('click', () => { roomKeyer.clear(); draft = ''; renderDraft(); announce('Message cleared') })
$('room-send').addEventListener('click', sendDraft)
function sendDraft() {
  roomKeyer.endLetter()
  const text = cleanText(draft)
  if (!text) { announce('Nothing to send yet. Tap some letters first.'); return }
  if (!room) return
  room.send({ t: 'msg', text, at: Date.now() })
  addMessage({ from: 'You', text, at: Date.now(), mine: true, freq: 650 })
  earcon('sent')
  const n = room.peers().length
  announce(n ? `Sent: ${text}` : `Sent: ${text}. No friends are in the room yet, so nobody got it.`)
  draft = ''
  renderDraft()
}

// ---------- invite ----------
$('copy-link').addEventListener('click', async () => {
  const link = roomUrl(roomCode)
  try { await navigator.clipboard.writeText(link); announce('Room link copied') }
  catch { announce('Could not copy. The room link is just above this button.') }
})
$('share-link').addEventListener('click', async () => {
  try { await navigator.share({ title: 'Tap Party', text: 'Tap Morse code with me', url: roomUrl(roomCode) }) } catch {}
})

// ---------- braille view ----------
function renderBraille() {
  const list = $('braille-log')
  list.textContent = ''
  $('braille-empty').hidden = messages.length > 0
  const print = $('braille-print').checked
  for (const m of messages) {
    const li = document.createElement('li')
    const who = document.createElement('span')
    who.textContent = `${m.mine ? 'You' : m.from}, ${hhmm(m.at)}: `
    const cells = document.createElement('span')
    cells.className = 'braille'
    cells.lang = 'en-Brai'
    cells.textContent = toBraille(m.text)
    li.append(who, cells)
    if (print) {
      const t = document.createElement('span')
      t.className = 'print'
      t.textContent = ` (${m.text})`
      li.append(t)
    }
    list.append(li)
  }
}
$('braille-print').addEventListener('change', renderBraille)

// ---------- go ----------
initLearn()
renderDraft()
route()
