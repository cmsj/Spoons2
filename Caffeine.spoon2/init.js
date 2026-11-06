// Caffeine — ported from the v1 Spoon of the same name.
// Toggles system-idle-sleep prevention from a menubar icon, backed by hs.power.

let menuItem = null
let active = false

function render() {
    menuItem.setIcon(HSImage.fromSymbol(active ? "cup.and.saucer.fill" : "cup.and.saucer"))
    menuItem.setTooltip(active ? "Caffeine: sleep prevented" : "Caffeine: idle")
}

function setState(newState) {
    if (newState === active) return
    if (newState) {
        hs.power.preventSleep("display")
    } else {
        hs.power.allowSleep("display")
    }
    active = newState
    if (menuItem) render()
}

function toggle() {
    setState(!active)
}

function start() {
    if (menuItem) return module.exports
    menuItem = hs.menubar.create(false)
    menuItem.setClickCallback(() => toggle())
    render()
    console.log("[Caffeine] started")
    return module.exports
}

function stop() {
    setState(false)
    if (menuItem) { menuItem.destroy(); menuItem = null }
    console.log("[Caffeine] stopped")
    return module.exports
}

module.exports = {
    start, stop, setState, toggle,

    // Actions for bindHotkeys(), which hs.spoons.load() provides
    bindings: {
        toggle: { pressed: () => toggle(), message: "Toggle sleep prevention" }
    }
}
