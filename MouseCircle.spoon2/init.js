// MouseCircle — ported from the v1 Spoon of the same name.
//
// Known limitation vs v1: hs.ui.window has no click-through/ignoresMouseEvents toggle exposed
// to JS, so this overlay (briefly) intercepts clicks within its own small bounds while shown.
// v1's hs.drawing circle did not intercept clicks at all. Kept the window small and short-lived
// to minimize the practical impact — see the migration report.

const SIZE = 80
const FADE_STEPS = 20
const FADE_INTERVAL = 0.05 // seconds -> ~1s total fade

let win = null
let fadeTimer = null

function alphaHex(alpha) {
    const clamped = Math.max(0, Math.min(1, alpha))
    return Math.round(clamped * 255).toString(16).padStart(2, "0").toUpperCase()
}

// hs.mouse.absolutePosition() is flipped (0,0 = top-left of the primary screen, y down), but
// hs.ui.window takes raw AppKit coordinates (0,0 = bottom-left, y up) — convert here.
function flippedToAppKit(x, y, w, h) {
    const primaryHeight = hs.screen.primary().fullFrame.h
    return { x, y: primaryHeight - y - h, w, h }
}

function show() {
    if (win) { fadeTimer.stop(); win.destroy(); win = null }

    const pos = hs.mouse.absolutePosition()
    const color = HSColor.hex("#FF0000")
    const rect = flippedToAppKit(pos.x - SIZE / 2, pos.y - SIZE / 2, SIZE, SIZE)

    win = hs.ui.window(rect)
        .titled(false)
        .allowResize(false)
        .level("screenSaver")
        .backgroundColor("#00000000")
        .circle()
            .stroke(color)
            .strokeWidth(4)
            .frame({ w: SIZE, h: SIZE })
        .show()

    let step = 0
    fadeTimer = hs.timer.doEvery(FADE_INTERVAL, () => {
        step += 1
        const alpha = 1 - step / FADE_STEPS
        if (alpha <= 0) {
            fadeTimer.stop()
            win.destroy()
            win = null
            return
        }
        color.set(`#FF0000${alphaHex(alpha)}`)
    })
}

function start() {}

module.exports = {
    show, start,

    // Actions for bindHotkeys(), which hs.spoons.load() provides
    bindings: {
        show: { pressed: () => show(), message: "Find the mouse pointer" }
    }
}
