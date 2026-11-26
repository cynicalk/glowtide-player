// Glowtide's YouTube player page: YouTube's official IFrame player, driven by the Glowtide
// window that frames it (https://github.com/cynicalk/glowtide). It's on a public website
// because YouTube won't play most music in a player on a page served from the PC itself.
//
// It only takes commands from the window that frames it, checks every one, and tells that
// window what's playing. It keeps nothing and sends nothing anywhere else.
/* global YT */
'use strict'
let player = null,
  ready = false,
  loopTrack = false,
  loopAll = false,
  shuffle = false
let queued = [],
  watchdog = null,
  skipTimer = null
// Glowtide's own queue: YouTube's player no longer plays a list of video ids handed to it
// (it sits cued and never starts), so songs are given to it one at a time. A YouTube playlist
// (by its id) still uses the player's own playlist.
let list = null,
  order = [],
  at = 0
const own = () => Array.isArray(list)
const send = (m) => parent.postMessage(Object.assign({ glowtide: 'yt' }, m), '*')

// YouTube's player can report "not started" (-1) for a song that is playing, its time moving
// a second a second, and then never report that it ended. So what it says is checked against
// the clock: time moving is playing; time stopped at the very end is the end of the song.
let lastT = 0,
  lastAt = 0,
  moving = false,
  stillSince = 0,
  paused = false,
  endedFor = null,
  loads = 0
function sample() {
  if (!ready) return
  const t = player.getCurrentTime() || 0
  const now = Date.now()
  if (now - lastAt < 400) return
  const dt = (now - lastAt) / 1000
  const was = moving
  moving = t > lastT + 0.15 && t - lastT < dt * 3 + 0.5
  if (!moving && (was || !stillSince)) stillSince = now
  if (moving) {
    // it's playing: whatever said it hadn't started was wrong
    stillSince = 0
    clearTimeout(watchdog)
    clearTimeout(skipTimer)
  }
  lastT = t
  lastAt = now
}
function realState() {
  const s = player.getPlayerState()
  if (s === 0 || s === 2) return s
  return moving ? 1 : s
}
function ended() {
  const key = `${loads}:${(player.getVideoData() || {}).video_id}`
  if (endedFor === key) return
  endedFor = key
  if (loopTrack) {
    player.seekTo(0, true)
    player.playVideo()
  } else if (own()) next()
}
// the end of the song, even when the player doesn't say so
function watchEnd() {
  sample()
  if (!ready || paused) return
  const d = player.getDuration() || 0
  const t = player.getCurrentTime() || 0
  if (d > 1 && t >= d - 0.75 && !moving && stillSince && Date.now() - stillSince > 800) ended()
}
function report() {
  if (!ready) return
  const d = (player.getVideoData && player.getVideoData()) || {}
  send({
    type: 'state',
    videoId: d.video_id || null,
    title: d.title || '',
    author: d.author || '',
    duration: player.getDuration() || 0,
    time: player.getCurrentTime() || 0,
    state: realState(),
    playlist: own() ? order.map((k) => list[k]) : player.getPlaylist() || null,
    index: own() ? at : player.getPlaylistIndex()
  })
}
function playAt(i) {
  if (!own() || !order.length) return
  at = Math.max(0, Math.min(order.length - 1, i))
  clearTimeout(skipTimer)
  loads++
  paused = false
  player.loadVideoById(list[order[at]])
}
// the play order: in turn, or shuffled with the song playing now first
function reorder() {
  const n = list ? list.length : 0
  const cur = order.length ? order[at] : at
  order = Array.from({ length: n }, (_, k) => k)
  if (!shuffle) return void (at = cur)
  for (let k = n - 1; k > 0; k--) {
    const j = Math.floor(Math.random() * (k + 1))
    const t = order[k]
    order[k] = order[j]
    order[j] = t
  }
  const p = order.indexOf(cur)
  order[p] = order[0]
  order[0] = cur
  at = 0
}
function next() {
  if (!own()) return player.nextVideo()
  if (at + 1 < order.length) playAt(at + 1)
  else if (loopAll) playAt(0)
}
function previous() {
  if (player.getCurrentTime() > 3) return player.seekTo(0, true)
  if (own()) return at > 0 ? playAt(at - 1) : player.seekTo(0, true)
  if (!player.getPlaylist()) return player.seekTo(0, true)
  player.previousVideo()
}
// a song that won't play: Glowtide may send another upload of it ('replace'); if not, move on
function failed() {
  clearTimeout(skipTimer)
  skipTimer = setTimeout(() => (own() ? next() : player.getPlaylist() && player.nextVideo()), 6000)
}
const ID = /^[\w-]{11}$/
const LIST_ID = /^[\w-]{2,64}$/
const num = (v, lo, hi) =>
  typeof v === 'number' && isFinite(v) ? Math.max(lo, Math.min(hi, v)) : null
function run(c) {
  if (!ready) return queued.length < 50 && queued.push(c)
  const a = c.action,
    x = c.arg
  if (a === 'play') {
    paused = false
    player.playVideo()
  } else if (a === 'pause') {
    paused = true
    player.pauseVideo()
  } else if (a === 'next') next()
  else if (a === 'previous') previous()
  else if (a === 'seek') {
    if (num(x, 0, 864e5) !== null) player.seekTo(x / 1000, true)
  } else if (a === 'shuffle') {
    shuffle = !!x
    if (own()) reorder()
    else player.setShuffle(shuffle)
  } else if (a === 'repeat') {
    loopTrack = x === 'track'
    loopAll = x === 'context'
    if (!own()) player.setLoop(loopAll)
  } else if (a === 'volume') {
    if (num(x, 0, 100) !== null) player.setVolume(x)
  } else if (a === 'load' && x && typeof x === 'object') {
    clearTimeout(skipTimer)
    const ids = Array.isArray(x.videoIds)
      ? x.videoIds.filter((v) => typeof v === 'string' && ID.test(v)).slice(0, 200)
      : []
    const index = num(x.index, 0, 199) || 0
    if (typeof x.playlistId === 'string' && LIST_ID.test(x.playlistId) && !ids.length) {
      list = null
      order = []
      loads++
      paused = false
      player.loadPlaylist({ listType: 'playlist', list: x.playlistId, index })
    } else if (ids.length) {
      list = ids
      order = []
      at = Math.min(list.length - 1, index)
      reorder()
      playAt(at)
    }
  } else if (a === 'replace' && x && ID.test(x.videoId || '') && ID.test(x.from || '')) {
    // another upload of the song that wouldn't play, in its place
    if (own() && list[order[at]] === x.from) {
      list[order[at]] = x.videoId
      playAt(at)
    } else if (!own()) {
      clearTimeout(skipTimer)
      loads++
      paused = false
      player.loadVideoById(x.videoId)
    }
  } else return
  setTimeout(report, 150)
}
window.addEventListener('message', (e) => {
  if (e.source !== parent || !e.data || e.data.glowtide !== 'cmd') return
  run(e.data)
})
window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player('p', {
    width: '100%',
    height: '100%',
    playerVars: { playsinline: 1, rel: 0, iv_load_policy: 3, origin: location.origin },
    events: {
      onReady: () => {
        ready = true
        send({ type: 'ready' })
        queued.splice(0).forEach(run)
        report()
      },
      onStateChange: (e) => {
        // ended: the same song again, or straight on to the next
        if (e.data === 0) ended()
        // A video whose owner blocks this kind of playback can show "Video unavailable"
        // without firing onError (a refusal usually fires it at once). Watch for a start
        // (time moving, after any ad); if none comes, say so.
        if (e.data === -1) {
          clearTimeout(watchdog)
          const startedAt = loads
          watchdog = setTimeout(() => {
            sample()
            const s = player.getPlayerState()
            if (startedAt !== loads || paused || moving || s === 1 || s === 2 || s === 0) return
            if ((player.getCurrentTime() || 0) < 0.5) {
              send({
                type: 'error',
                code: 'stalled',
                videoId: (player.getVideoData() || {}).video_id
              })
              failed()
            }
          }, 30000) // long enough for YouTube's own ad before the song
        }
        if (e.data === 1 || e.data === 2) {
          clearTimeout(watchdog)
          clearTimeout(skipTimer)
        }
        report()
      },
      onError: (e) => {
        clearTimeout(watchdog)
        send({ type: 'error', code: e.data, videoId: (player.getVideoData() || {}).video_id })
        failed()
      }
    }
  })
}
setInterval(report, 1000)
setInterval(watchEnd, 500)
