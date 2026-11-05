// URLDispatcher — ported from the v1 Spoon of the same name.
//
// v1's URLDispatcher also supported a `default_handler` used whenever nothing matched, and
// opened plain (non-matching) URLs there instead of leaving them to the system default. This
// port keeps that behavior: if nothing matches, and a defaultHandler is configured, the URL is
// opened with it explicitly rather than falling through.

let urlPatterns = []   // [{ regex, handler }]
let appPatterns = []   // [{ appName, handler }]
let defaultHandler = null
let started = false

function matchApp(senderPID) {
    if (!senderPID) return null
    const app = hs.application.fromPID(senderPID)
    return app ? app.name : null
}

function dispatch(scheme, host, params, fullURL, senderPID) {
    for (const { regex, handler } of urlPatterns) {
        if (regex.test(fullURL)) {
            console.log(`[URLDispatcher] "${fullURL}" matched URL pattern ${regex}`)
            handler(fullURL)
            return
        }
    }

    const appName = matchApp(senderPID)
    if (appName) {
        for (const { appName: pattern, handler } of appPatterns) {
            if (appName === pattern) {
                console.log(`[URLDispatcher] "${fullURL}" matched app pattern "${pattern}" (sender: ${appName})`)
                handler(fullURL)
                return
            }
        }
    }

    if (defaultHandler) {
        hs.urlevent.openURLWithBundle(fullURL, defaultHandler)
    } else {
        hs.urlevent.openURL(fullURL)
    }
}

function configure(options) {
    urlPatterns = options.urlPatterns || []
    appPatterns = options.appPatterns || []
    defaultHandler = options.defaultHandler || null
    return module.exports
}

function start() {
    if (started) return module.exports
    hs.urlevent.httpCallback = (scheme, host, params, fullURL, senderPID) => {
        dispatch(scheme, host, params, fullURL, senderPID)
    }
    started = true
    console.log("[URLDispatcher] started")
    return module.exports
}

function stop() {
    if (!started) return module.exports
    hs.urlevent.httpCallback = null
    started = false
    console.log("[URLDispatcher] stopped")
    return module.exports
}

module.exports = { configure, start, stop }
