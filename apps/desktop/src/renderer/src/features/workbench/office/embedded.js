/* SPDX-License-Identifier: MIT */
'use strict';

globalThis.ScholarSeedOfficeEmbedded = (() => {
  const MATH_SERVICE = 'com.sun.star.formula.FormulaProperties'
  const NATIVE_EVENT_SETTLE_DELAY_MS = 0

  function deactivate(css, model) {
    const objects = model.getEmbeddedObjects()
    for (const name of objects.getElementNames()) {
      const object = objects.getByName(name).getExtendedControlOverEmbeddedObject()
      const state = object.getCurrentState()
      if (state !== css.embed.EmbedStates.UI_ACTIVE && state !== css.embed.EmbedStates.INPLACE_ACTIVE) continue
      if (object.getComponent()?.supportsService(MATH_SERVICE)) object.changeState(css.embed.EmbedStates.RUNNING)
    }
  }

  function observe(zetajs, css, model, editable, changed, failed) {
    const root = model.getCurrentController().getFrame()
    const desktop = css.frame.Desktop.create(zetajs.getUnoComponentContext())
    const installed = []
    const objects = []
    let disposed = false
    let scanning = false
    let active = false
    let scanTimer
    function scheduleScan() {
      if (disposed || scanTimer !== undefined) return
      scanTimer = setTimeout(() => {
        scanTimer = undefined
        try { scan() } catch (error) { failed(error) }
      }, NATIVE_EVENT_SETTLE_DELAY_MS)
    }
    function govern(frame) {
      const component = frame.getController()?.getModel()
      if (!component?.supportsService(MATH_SERVICE)) return
      if (installed.some(entry => zetajs.sameUnoObject(entry.frame, frame))) return
      const entry = { frame, component, release: undefined, uiActive: false }
      installed.push(entry)
      try {
        entry.release = ScholarSeedOfficeGovernance.install(zetajs, css, component, ScholarSeedOfficePolicy.select('math', editable))
        const modified = zetajs.unoObject([css.util.XModifyListener], {
          modified() { changed({ dirty: true }); scheduleScan() }, disposing() {}
        })
        component.addModifyListener(modified)
        const release = entry.release
        entry.activate = release.activateEmbedded
        entry.release = () => { component.removeModifyListener(modified); release() }
        console.info('[office-embedded] native Math governed')
      } catch (error) {
        frame.getContainerWindow().setEnable(false)
        failed(error)
      }
    }
    function scan() {
      if (disposed || scanning) return
      scanning = true
      try {
        const collection = model.getEmbeddedObjects()
        const current = collection.getElementNames().map(name => collection.getByName(name).getExtendedControlOverEmbeddedObject())
        for (let index = objects.length - 1; index >= 0; index--) {
          const entry = objects[index]
          if (current.some(object => zetajs.sameUnoObject(entry.object, object))) continue
          try { entry.object.removeStateChangeListener(entry.stateListener) } catch (error) { /* deleted native object */ }
          objects.splice(index, 1)
        }
        for (const object of current) {
          if (objects.some(entry => zetajs.sameUnoObject(entry.object, object))) continue
          const stateListener = zetajs.unoObject([css.embed.XStateChangeListener], {
            changingState() {
              const component = object.getComponent()
              if (component?.supportsService(MATH_SERVICE)) {
                ScholarSeedOfficeGovernance.prepareEmbedded(zetajs, component, ScholarSeedOfficePolicy.select('math', editable))
              }
            },
            stateChanged() { scan(); scheduleScan() },
            disposing() {}
          })
          object.addStateChangeListener(stateListener)
          objects.push({ object, stateListener })
        }
        for (const child of desktop.getFrames().queryFrames(css.frame.FrameSearchFlag.ALL)) govern(child)
        for (const entry of installed) {
          const uiActive = objects.some(({ object }) => (
            object.getCurrentState() === css.embed.EmbedStates.UI_ACTIVE
            && zetajs.sameUnoObject(object.getComponent(), entry.component)
          ))
          if (uiActive && !entry.uiActive) {
            entry.activate?.()
            console.info('[office-embedded] native Math menu activated')
          }
          entry.uiActive = uiActive
        }
        const nextActive = objects.some(entry => {
          const state = entry.object.getCurrentState()
          return state === css.embed.EmbedStates.INPLACE_ACTIVE || state === css.embed.EmbedStates.UI_ACTIVE
        })
        if (nextActive !== active) {
          active = nextActive
          changed({ active })
        }
      } finally { scanning = false }
    }
    const documentListener = zetajs.unoObject([css.document.XDocumentEventListener], {
      documentEventOccured() { scan(); scheduleScan() }, disposing() {}
    })
    const listener = zetajs.unoObject([css.frame.XFrameActionListener], {
      frameAction(event) {
        if (disposed) return
        govern(event.Frame)
        scan()
        scheduleScan()
      },
      disposing() {}
    })
    root.addFrameActionListener(listener)
    desktop.addFrameActionListener(listener)
    model.addDocumentEventListener(documentListener)
    scan()
    return {
      deactivate() { deactivate(css, model) },
      get active() { return active },
      scan,
      dispose() {
        disposed = true
        if (scanTimer !== undefined) clearTimeout(scanTimer)
        root.removeFrameActionListener(listener)
        desktop.removeFrameActionListener(listener)
        model.removeDocumentEventListener(documentListener)
        for (const entry of objects) {
          try { entry.object.removeStateChangeListener(entry.stateListener) } catch (error) { /* deleted native object */ }
        }
        for (const entry of installed) {
          try { entry.release?.() } catch (error) { /* native child may already be disposed */ }
        }
      }
    }
  }
  return Object.freeze({ observe, deactivate })
})();
