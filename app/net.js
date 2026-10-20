// net.js: rooms with dmotz/trystero. Peers find each other through public
// Nostr relays, then talk directly over WebRTC. No server of our own.
import { joinRoom, selfId, getRelaySockets } from '../vendor/trystero/nostr/index.mjs'

const APP_ID = 'tap-party.2three1y.github.io'
export { selfId }

export function openRoom(code, handlers) {
  const room = joinRoom({ appId: APP_ID, password: 'tap-party:' + code }, code, {
    onJoinError: (e) => handlers.onError?.(e),
  })
  const wire = room.makeAction('tp')
  wire.onMessage = (data, ctx) => handlers.onData?.(data, ctx.peerId)
  room.onPeerJoin = (id) => handlers.onJoin?.(id)
  room.onPeerLeave = (id) => handlers.onLeave?.(id)
  return {
    send: (data, target) => wire.send(data, target ? { target } : undefined).catch(() => {}),
    peers: () => Object.keys(room.getPeers()),
    leave: () => room.leave(),
  }
}

export function relayCount() {
  try {
    return Object.values(getRelaySockets()).filter((s) => s && s.readyState === 1).length
  } catch { return 0 }
}
