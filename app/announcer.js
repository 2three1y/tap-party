// announcer.js: the page's one and only aria-live region.
let el = null
let timer = null
let queue = []
export function initAnnouncer(node) { el = node }
// Speak a message through VoiceOver or TalkBack. Several calls close together are joined.
export function announce(text) {
  if (!el || !text) return
  queue.push(text)
  clearTimeout(timer)
  timer = setTimeout(() => {
    const msg = queue.join('. ')
    queue = []
    el.textContent = ''
    // A short pause so the same words said twice in a row are still read.
    setTimeout(() => { el.textContent = msg }, 60)
  }, 80)
}
