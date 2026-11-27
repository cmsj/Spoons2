// MouseCircle — makes the mouse pointer impossible to miss, on any number of monitors.
//
// When triggered, every screen gets a click-through canvas, and they all draw one effect, centred
// on the pointer, in their own coordinates. Together they act as a single desktop-wide surface:
//
//   1. Iris: the whole desktop dims, apart from a hole that closes from beyond the farthest
//      screen corner down to a spotlight around the pointer.
//   2. Rings: coloured rings sweep in from the edges of the desktop, one after another, and land
//      on the pointer. On the other monitors you see their arcs moving towards the right screen.
//   3. Lock-on: when the last ring lands, a shockwave bursts outwards and the ring around the
//      pointer pulses.
//   4. The iris opens again, everything fades, and the canvases are destroyed.
//
// The effect follows the pointer while it plays. Showing it again while it's playing restarts it.
//
// Usage:
//   hs.spoons.load("MouseCircle").bindHotkeys({ show: [["cmd", "alt", "ctrl"], "m"] })
//   // Also find the pointer by shaking the mouse:
//   hs.spoons.use("MouseCircle", { config: { colors: ["#FF2D95", "#00E5FF", "#FFD60A"] }, start: true })

const obj = {
    /// Ring colours, as hex strings, in the order the rings arrive. The last one is the ring that
    /// stays around the pointer.
    colors: ["#00E5FF", "#FF2D95", "#FFD60A"],
    /// How dark the desktop gets around the spotlight, from 0 (not at all) to 1 (black)
    dimAlpha: 0.45,
    /// Radius of the undimmed spotlight around the pointer, in points
    spotlightRadius: 140,
    /// Radius of the ring that settles around the pointer, in points
    ringRadius: 34,
    /// Seconds the effect stays locked on to the pointer before fading away
    holdTime: 0.6,
    /// Once `start()` has been called, shaking the mouse for this many seconds without pausing
    /// shows the effect. The default leaves time for macOS's own shake-to-locate to enlarge the
    /// pointer first, so the effect only appears if you're still shaking after that.
    shakeDuration: 2.5,
    /// The fewest mouse shakes (quick left-right direction changes) that can trigger the effect
    shakeReversals: 4,
}

// Element indices, the same on every screen's canvas
const HOLE = 1       // reversed clip: the spotlight (punched out of the rectangle built at 0)
const DIM = 2        // the dimming, drawn everywhere outside the spotlight
const HALO = 4       // a soft glow behind the pointer
const RING0 = 5      // first of the incoming rings; there is one per entry in obj.colors
// The shockwave comes after the rings

// Easing curves
const SWOOP = [0.16, 1, 0.3, 1]   // fast start, long gentle landing
const SNAP = [0.5, 0, 0.75, 0]    // slow start, accelerating

let canvases = []       // [{canvas, origin}]
let generation = 0      // bumped whenever an effect is started or torn down, to stop stale steps
let followTimer = null
let lastPos = null
let shakeTap = null

// --- helpers -------------------------------------------------------------------------------

function rgba(hex, alpha) {
    const h = hex.replace(/^#/, "")
    const full = h.length === 3 ? h.split("").map(c => c + c).join("") : h.slice(0, 6)
    const n = parseInt(full, 16)
    return { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255, alpha }
}

function local(pos, origin) {
    return { x: pos.x - origin.x, y: pos.y - origin.y }
}

// The distance from `pos` to the farthest corner of any screen, so the iris and rings start
// beyond everything that can be seen
function farthestDistance(pos, screens) {
    let far = 0
    for (const s of screens) {
        const f = s.fullFrame
        for (const [x, y] of [[f.x, f.y], [f.x + f.w, f.y], [f.x, f.y + f.h], [f.x + f.w, f.y + f.h]]) {
            far = Math.max(far, Math.hypot(x - pos.x, y - pos.y))
        }
    }
    return far + 40
}

function ringCount() {
    return Math.max(1, obj.colors.length)
}

function shockwaveIndex() {
    return RING0 + ringCount()
}

function lastColor() {
    return obj.colors[ringCount() - 1] || "#FFFFFF"
}

// Applies `fn(canvas)` to every screen's canvas
function each(fn) {
    for (const entry of canvases) fn(entry.canvas, entry)
}

function animate(options, fn) {
    return hs.canvas.animate(options, () => each(fn))
}

function after(seconds, fn) {
    const mine = generation
    hs.timer.doAfter(seconds, () => { if (mine === generation) fn() })
}

// --- building ------------------------------------------------------------------------------

function elementsFor(center, far) {
    const whole = { x: 0, y: 0, w: "100%", h: "100%" }
    const elements = [
        { type: "rectangle", action: "build", frame: whole },
        { type: "circle", action: "clip", reversePath: true, center, radius: far },
        { type: "rectangle", action: "fill", frame: whole,
          fillColor: { red: 0, green: 0, blue: 0, alpha: 0 } },
        { type: "resetClip" },
        { type: "circle", action: "fill", center, radius: obj.spotlightRadius,
          fillGradient: "radial",
          fillGradientColors: [rgba(lastColor(), 0), rgba(lastColor(), 0)] },
    ]
    // Rings start progressively farther out, so they arrive one after another
    obj.colors.forEach((color, i) => {
        elements.push({ type: "circle", action: "stroke", center, radius: far * (1 + 0.12 * i),
                        strokeWidth: 28, strokeColor: rgba(color, 0) })
    })
    elements.push({ type: "circle", action: "stroke", center, radius: obj.ringRadius,
                    strokeWidth: 6, strokeColor: rgba(lastColor(), 0) })
    return elements
}

function teardown() {
    generation += 1
    if (followTimer) { followTimer.stop(); followTimer = null }
    each(canvas => canvas.destroy(0))
    canvases = []
}

// Keeps the effect centred on the pointer while it plays. Centres are set outside animate(), so
// they move instantly, while the radii and colours carry on animating.
function follow() {
    const pos = hs.mouse.absolutePosition()
    if (lastPos && pos.x === lastPos.x && pos.y === lastPos.y) return
    lastPos = pos
    const centred = [HOLE, HALO, shockwaveIndex()]
    for (let i = 0; i < ringCount(); i++) centred.push(RING0 + i)
    for (const { canvas, origin } of canvases) {
        const c = local(pos, origin)
        for (const index of centred) canvas.setElementAttribute(index, "center", c)
    }
}

// --- the effect ----------------------------------------------------------------------------

function show() {
    teardown()
    const mine = generation

    const screens = hs.screen.all()
    const pos = hs.mouse.absolutePosition()
    const far = farthestDistance(pos, screens)
    lastPos = pos

    for (const screen of screens) {
        const frame = screen.fullFrame
        const origin = { x: frame.x, y: frame.y }
        const canvas = hs.canvas.create(frame)
            .levelValue(hs.canvas.windowLevels.screenSaver + 1)
            .behaviorList(["canJoinAllSpaces", "fullScreenAuxiliary", "transient"])
            .ignoreMouseEvents(true)
        canvas.appendElements(elementsFor(local(pos, origin), far))
        canvas.show(0)
        canvases.push({ canvas, origin })
    }

    followTimer = hs.timer.doEvery(1 / 60, follow)

    // 1. Iris closes and the halo glows
    animate({ duration: 0.7, curve: SWOOP }, canvas => {
        canvas.setElementAttribute(HOLE, "radius", obj.spotlightRadius)
        canvas.setElementAttribute(DIM, "fillColor", { red: 0, green: 0, blue: 0, alpha: obj.dimAlpha })
        canvas.setElementAttribute(HALO, "fillGradientColors", [rgba(lastColor(), 0.35), rgba(lastColor(), 0)])
    })

    // 2. Rings sweep in, staggered, and land on the pointer
    const stagger = 0.11
    const sweep = 0.6
    obj.colors.forEach((color, i) => {
        after(i * stagger, () => {
            const isLast = i === ringCount() - 1
            animate({ duration: sweep, curve: SWOOP }, canvas => {
                canvas.setElementAttribute(RING0 + i, "radius", obj.ringRadius * (isLast ? 1 : 0.6 + 0.2 * i))
                canvas.setElementAttribute(RING0 + i, "strokeWidth", isLast ? 6 : 3)
                canvas.setElementAttribute(RING0 + i, "strokeColor", rgba(color, 1))
            }).then(finished => {
                if (!finished || mine !== generation) return
                if (isLast) lockOn(mine)
                else {
                    // Earlier rings melt into the final one
                    animate({ duration: 0.3, curve: "easeIn" }, canvas => {
                        canvas.setElementAttribute(RING0 + i, "radius", obj.ringRadius)
                        canvas.setElementAttribute(RING0 + i, "strokeColor", rgba(color, 0))
                    })
                }
            })
        })
    })
}

// 3. Shockwave and pulse once the last ring has landed
function lockOn(mine) {
    const last = RING0 + ringCount() - 1
    const shock = shockwaveIndex()

    each(canvas => canvas.setElementAttribute(shock, "strokeColor", rgba(lastColor(), 0.9)))
    animate({ duration: 0.55, curve: "easeOut" }, canvas => {
        canvas.setElementAttribute(shock, "radius", obj.ringRadius * 5)
        canvas.setElementAttribute(shock, "strokeWidth", 1)
        canvas.setElementAttribute(shock, "strokeColor", rgba(lastColor(), 0))
    })

    const pulse = (times) => {
        if (mine !== generation) return
        if (times === 0) { after(obj.holdTime, () => fadeAway(mine)); return }
        animate({ duration: 0.16, curve: "easeOut" }, canvas => {
            canvas.setElementAttribute(last, "radius", obj.ringRadius * 1.3)
            canvas.setElementAttribute(last, "strokeWidth", 9)
        }).then(() => {
            if (mine !== generation) return
            animate({ duration: 0.2, curve: "easeIn" }, canvas => {
                canvas.setElementAttribute(last, "radius", obj.ringRadius)
                canvas.setElementAttribute(last, "strokeWidth", 6)
            }).then(() => pulse(times - 1))
        })
    }
    pulse(2)
}

// 4. Iris opens, everything fades, and the canvases go away
function fadeAway(mine) {
    if (mine !== generation) return
    const far = farthestDistance(hs.mouse.absolutePosition(), hs.screen.all())
    animate({ duration: 0.45, curve: SNAP }, canvas => {
        canvas.setElementAttribute(HOLE, "radius", far)
        canvas.setElementAttribute(DIM, "fillColor", { red: 0, green: 0, blue: 0, alpha: 0 })
        canvas.setElementAttribute(HALO, "fillGradientColors", [rgba(lastColor(), 0), rgba(lastColor(), 0)])
        obj.colors.forEach((color, i) => canvas.setElementAttribute(RING0 + i, "strokeColor", rgba(color, 0)))
        canvas.setElementAttribute(RING0 + ringCount() - 1, "radius", obj.ringRadius * 0.4)
    }).then(() => {
        if (mine === generation) teardown()
    })
}

// --- shake to find -------------------------------------------------------------------------

// A shake is a run of quick horizontal direction changes, each after a decent amount of travel.
// It has to keep going for obj.shakeDuration seconds; a pause between reversals starts it over.
const SHAKE_MAX_GAP = 0.5     // seconds allowed between reversals before the shake is over
const SHAKE_MIN_TRAVEL = 60   // points the pointer has to travel between reversals

// started: when the current run of reversals began; last: the latest reversal in it
let shake = { x: null, dir: 0, travel: 0, started: 0, last: 0, reversals: 0 }

function onMouseMoved(event) {
    const x = event.location.x
    if (shake.x === null) { shake.x = x; return }
    const dx = x - shake.x
    shake.x = x
    if (dx === 0) return

    const dir = dx > 0 ? 1 : -1
    if (dir === shake.dir) {
        shake.travel += Math.abs(dx)
        return
    }

    const counts = shake.dir !== 0 && shake.travel >= SHAKE_MIN_TRAVEL
    shake.dir = dir
    shake.travel = Math.abs(dx)
    if (!counts) return

    const now = hs.timer.secondsSinceEpoch()
    if (now - shake.last > SHAKE_MAX_GAP) {
        shake.started = now
        shake.reversals = 0
    }
    shake.last = now
    shake.reversals += 1

    if (now - shake.started >= obj.shakeDuration && shake.reversals >= obj.shakeReversals) {
        // Start a fresh run, so shaking on afterwards needs another full shakeDuration
        shake.started = now
        shake.reversals = 0
        if (canvases.length === 0) show()
    }
}

// --- public API ----------------------------------------------------------------------------

obj.show = show

/// Starts watching for the mouse being shaken, which shows the effect
obj.start = function() {
    if (shakeTap) return obj
    const types = hs.eventtap.eventTypes
    shakeTap = hs.eventtap.addWatcher(
        [types.mouseMoved, types.leftMouseDragged, types.rightMouseDragged],
        onMouseMoved, true)
    if (shakeTap) shakeTap.start()
    else console.warn("MouseCircle: couldn't watch the mouse for shakes (is Accessibility permission granted?)")
    return obj
}

/// Stops watching for mouse shakes, and removes the effect if it's showing
obj.stop = function() {
    if (shakeTap) {
        hs.eventtap.removeWatcher(shakeTap)
        shakeTap = null
    }
    teardown()
    return obj
}

// Actions for bindHotkeys(), which hs.spoons.load() provides
obj.bindings = {
    show: { pressed: () => show(), message: "Find the mouse pointer" },
}

module.exports = obj
