/* SPDX-License-Identifier: MIT */
'use strict';

// Native UNO integration; no translated or simulated React toolbar.
globalThis.ScholarSeedOfficeGovernance = (() => {
  const MENUBAR = 'private:resource/menubar/menubar'
  const STATUSBAR = 'private:resource/statusbar/statusbar'
  const SIDEBAR = 'private:resource/dockingwindow/Sidebar'
  const MODULE_CONFIGURATION = '/singletons/com.sun.star.ui.theModuleUIConfigurationManagerSupplier'
  const CONFIGURATION_SOURCE_PROPERTY = 'ConfigurationSource'
  const READONLY_INFOBAR = 'readonly'
  const COMMAND_PROPERTY = 'CommandURL'
  const LABEL_PROPERTY = 'Label'
  const CHILDREN_PROPERTY = 'ItemDescriptorContainer'
  const MENU_COMMAND = 'CommandURL'
  const MENU_CHILDREN = 'SubContainer'
  const MENU_LABEL = 'Text'
  const EMBEDDED_MENU_ANCHORS = ['.uno:PickList', '.uno:WindowList']
  const MENUBAR_LABELS = Object.freeze({
    '.uno:PickList': 'File',
    '.uno:FileMenu': 'File',
    '.uno:EditMenu': 'Edit',
    '.uno:ViewMenu': 'View',
    '.uno:InsertMenu': 'Insert',
    '.uno:FormatMenu': 'Format',
    '.uno:ToolsMenu': 'Tools',
    '.uno:WindowList': 'Window',
    '.uno:HelpMenu': 'Help'
  })
  const UNO_COMMAND_PREFIX = '.uno:'
  const MENU_SUFFIX = /Menu$/
  const WORD_BOUNDARY = /([a-z0-9])([A-Z])/g
  const policyApi = globalThis.ScholarSeedOfficePolicy

  function englishMenuLabel(command) {
    if (Object.prototype.hasOwnProperty.call(MENUBAR_LABELS, command)) return MENUBAR_LABELS[command]
    if (!command.startsWith(UNO_COMMAND_PREFIX)) return ''
    return command.split('?', 1)[0].slice(UNO_COMMAND_PREFIX.length)
      .replace(MENU_SUFFIX, '')
      .replace(WORD_BOUNDARY, '$1 $2')
  }

  function labelMenubar(zetajs, settings) {
    if (!settings.$precise) throw new Error('office_menubar_precise_unavailable')
    for (let index = 0; index < settings.getCount(); index += 1) {
      const wrappedEntry = settings.$precise.getByIndex(index)
      const entry = wrappedEntry.val
      const command = entry.find(value => value.Name === COMMAND_PROPERTY)?.Value?.val || ''
      const label = entry.find(value => value.Name === LABEL_PROPERTY)
      const children = entry.find(value => value.Name === CHILDREN_PROPERTY)?.Value?.val
      if (children) labelMenubar(zetajs, children)
      const englishLabel = englishMenuLabel(command)
      if (label && englishLabel) {
        label.Value = new zetajs.Any(label.Value.type, englishLabel)
        settings.$precise.replaceByIndex(index, wrappedEntry)
      }
    }
  }

  function trimSettings(settings, policy) {
    for (let index = settings.getCount() - 1; index >= 0; index -= 1) {
      const entry = settings.getByIndex(index)
      const command = entry.find(value => value.Name === COMMAND_PROPERTY)?.Value || ''
      const children = entry.find(value => value.Name === CHILDREN_PROPERTY)?.Value
      if (children) trimSettings(children, policy)
      const mergeAnchor = children && policy.menus.includes(MENUBAR) && EMBEDDED_MENU_ANCHORS.includes(command)
      if (!mergeAnchor && (children ? children.getCount() === 0 : !policyApi.allows(policy, command))) {
        settings.removeByIndex(index)
      }
    }
  }

  function trimMenu(items, policy) {
    for (let index = items.getCount() - 1; index >= 0; index -= 1) {
      const entry = items.getByIndex(index)
      const info = entry.getPropertySetInfo()
      const children = info.hasPropertyByName(MENU_CHILDREN) ? entry.getPropertyValue(MENU_CHILDREN) : null
      const command = info.hasPropertyByName(MENU_COMMAND) ? entry.getPropertyValue(MENU_COMMAND) : ''
      if (children) trimMenu(children, policy)
      if (children ? children.getCount() === 0 : !policyApi.allows(policy, command)) items.removeByIndex(index)
    }
  }

  function labelContextMenu(items) {
    for (let index = 0; index < items.getCount(); index += 1) {
      const entry = items.getByIndex(index)
      const info = entry.getPropertySetInfo()
      const children = info.hasPropertyByName(MENU_CHILDREN) ? entry.getPropertyValue(MENU_CHILDREN) : null
      const command = info.hasPropertyByName(MENU_COMMAND) ? entry.getPropertyValue(MENU_COMMAND) : ''
      if (children) labelContextMenu(children)
      const englishLabel = info.hasPropertyByName(MENU_LABEL) ? englishMenuLabel(command) : ''
      if (englishLabel) entry.setPropertyValue(MENU_LABEL, englishLabel)
    }
  }

  function prepareEmbedded(zetajs, model, policy) {
    const moduleManager = zetajs.getUnoComponentContext().getValueByName(
      MODULE_CONFIGURATION
    ).getUIConfigurationManager(policy.module.service)
    const manager = model.getUIConfigurationManager()
    for (const resource of [...policy.menus, ...policy.toolbars]) {
      const settings = moduleManager.getSettings(resource, true)
      if (resource === MENUBAR) labelMenubar(zetajs, settings)
      trimSettings(settings, policy)
      if (manager.hasSettings(resource)) manager.replaceSettings(resource, settings)
      else manager.insertSettings(resource, settings)
    }
  }

  function install(zetajs, css, model, policy, actions = {}) {
    const controller = model.getCurrentController()
    const frame = controller.getFrame()
    const layout = frame.LayoutManager
    let hidingChrome = false
    function hideDisallowedChrome() {
      if (policy.editable || hidingChrome) return
      hidingChrome = true
      try {
        const sidebar = controller.getSidebar?.()
        sidebar?.showDecks(false)
        sidebar?.setVisible(false)
        if (controller.hasInfobar?.(READONLY_INFOBAR)) controller.removeInfobar(READONLY_INFOBAR)
        layout.setVisible(false)
      } finally {
        hidingChrome = false
      }
    }
    const layoutListener = zetajs.unoObject([css.frame.XLayoutManagerListener], {
      layoutEvent(_source, event, info) {
        const resource = zetajs.fromAny(info)
        if (event === css.frame.LayoutManagerEvents.UIELEMENT_VISIBLE && !policyApi.allowsResource(policy, resource)) {
          layout.hideElement(resource)
        }
        hideDisallowedChrome()
      },
      disposing() {}
    })
    let master, slave
    function queryDispatch(url, target, flags) {
      if (!policyApi.allows(policy, url.Complete) || !slave) return null
      const dispatch = slave.queryDispatch(url, target, flags)
      if (!dispatch) return null
      // Preserve native dispatch identity and its private Sfx argument transport.
      // Wrapping InputLineEnter drops ScInputStatusItem and commits empty cells.
      const action = actions[url.Complete.split('?')[0]]
      if (!action && !policyApi.requiresArgumentCheck(url.Complete)) return dispatch
      return zetajs.unoObject([css.frame.XDispatch], {
        dispatch(command, args) {
          if (action) { action(dispatch, command, args); return }
          const values = args.map(arg => ({ Name: arg.Name, Value: zetajs.fromAny(arg.Value) }))
          if (policyApi.allowsDispatch(policy, command.Complete, values)) dispatch.dispatch(command, args)
        },
        addStatusListener(listener, command) { dispatch.addStatusListener(listener, command) },
        removeStatusListener(listener, command) { dispatch.removeStatusListener(listener, command) }
      })
    }
    const interceptor = zetajs.unoObject([css.frame.XDispatchProviderInterceptor, css.frame.XInterceptorInfo], {
      getMasterDispatchProvider() { return master },
      setMasterDispatchProvider(value) { master = value },
      getSlaveDispatchProvider() { return slave },
      setSlaveDispatchProvider(value) { slave = value },
      getInterceptedURLs() { return ['*'] },
      queryDispatch,
      queryDispatches(requests) {
        return requests.map(request => queryDispatch(request.FeatureURL, request.FrameName, request.SearchFlags))
      }
    })
    const menuInterceptor = zetajs.unoObject([css.ui.XContextMenuInterceptor], {
      notifyContextMenuExecute(event) {
        if (!policy.contextMenus) return css.ui.ContextMenuInterceptorAction.CANCELLED
        try {
          trimMenu(event.ActionTriggerContainer, policy)
          labelContextMenu(event.ActionTriggerContainer)
          return css.ui.ContextMenuInterceptorAction.EXECUTE_MODIFIED
        } catch (error) {
          console.error('[office-policy] context menu rejected', String(error))
          return css.ui.ContextMenuInterceptorAction.CANCELLED
        }
      }
    })
    frame.registerDispatchProviderInterceptor(interceptor)
    let stage = 'context-menu-interceptor'
    try {
      controller.registerContextMenuInterceptor?.(menuInterceptor)
      layout.addLayoutManagerEventListener(layoutListener)
      stage = 'document-ui-manager'
      const manager = model.getUIConfigurationManager()
      stage = 'module-ui-manager'
      const moduleManager = zetajs.getUnoComponentContext().getValueByName(
        MODULE_CONFIGURATION
      ).getUIConfigurationManager(policy.module.service)
      stage = 'layout-hide'
      if (!policy.module.embedded) frame.getContainerWindow().FullScreen = true
      layout.lock()
      try {
        for (const element of layout.getElements()) {
          if (!policyApi.allowsResource(policy, element.ResourceURL)) layout.hideElement(element.ResourceURL)
        }
        if (!policy.module.embedded) layout.hideElement(MENUBAR)
        layout.hideElement(SIDEBAR)
        for (const resource of [...policy.menus, ...policy.toolbars]) {
          stage = resource
          if (policy.nativeToolbars.includes(resource)) {
            layout.createElement(resource)
            layout.showElement(resource)
            continue
          }
          const settings = moduleManager.getSettings(resource, true)
          if (resource === MENUBAR) labelMenubar(zetajs, settings)
          trimSettings(settings, policy)
          if (manager.hasSettings(resource)) manager.replaceSettings(resource, settings)
          else manager.insertSettings(resource, settings)
          if (policy.module.embedded) {
            // An in-place frame has no menubar until Writer's native merge completes.
            // Publish restricted settings first; do not create/show a standalone UI.
            const existing = layout.getElement(resource)
            if (existing) {
              existing.setPropertyValue(CONFIGURATION_SOURCE_PROPERTY, manager)
              existing.updateSettings()
            }
            continue
          }
          layout.createElement(resource)
          const element = layout.getElement(resource)
          element.setPropertyValue(CONFIGURATION_SOURCE_PROPERTY, manager)
          element.updateSettings()
          layout.showElement(resource)
        }
        if (!policy.module.embedded && policy.statusbar) {
          layout.createElement(STATUSBAR)
          layout.showElement(STATUSBAR)
        } else {
          layout.hideElement(STATUSBAR)
        }
      } finally { layout.unlock() }
      hideDisallowedChrome()
    } catch (error) {
      const detail = error instanceof WebAssembly.Exception ? zetajs.catchUnoException(error) : error
      console.error('[office-policy] installation failed', policy.kind, stage, detail?.Message || String(detail))
      controller.releaseContextMenuInterceptor?.(menuInterceptor)
      layout.removeLayoutManagerEventListener(layoutListener)
      frame.releaseDispatchProviderInterceptor(interceptor)
      throw error
    }
    const release = () => {
      controller.releaseContextMenuInterceptor?.(menuInterceptor)
      layout.removeLayoutManagerEventListener(layoutListener)
      frame.releaseDispatchProviderInterceptor(interceptor)
    }
    // Private worker-only transport for already validated, host-acquired media.
    release.dispatchNative = (command, args) => css.frame.DispatchHelper.create(
      zetajs.getUnoComponentContext()
    ).executeDispatch(slave, command, '', 0, args)
    release.activateEmbedded = () => {
      if (policy.module.embedded && policy.menus.includes(MENUBAR)) {
        // Native setMergedMenuBar is a no-op while an earlier merge is installed.
        layout.removeMergedMenuBar()
        layout.setMergedMenuBar(model.getUIConfigurationManager().getSettings(MENUBAR, false))
      }
    }
    release.enforce = hideDisallowedChrome
    return release
  }
  return Object.freeze({ install, prepareEmbedded, trimSettings, trimMenu, labelMenubar, labelContextMenu })
})();
