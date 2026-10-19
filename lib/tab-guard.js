// Guard source prepended to browser cua_repl programs. It wraps cua.createBrowserTab and
// cua.listTabs so a call lists only plugin tabs, and wraps every Browser returned
// by cua.getBrowser / cua.browsers.{get,getDefault,getForUrl} so user tabs and
// browsing history stay blocked while allowUserTabs is off. The tab-guard marker lives on
// the cua object (so a replaced cua is wrapped again); recorded ids live in a global Symbol
// slot (so replacing cua does not lose the plugin tab ids). The allowUserTabs value
// is written to a global Symbol on every call and read when a guarded method runs, so a
// settings change applies to the next call without resetting the REPL.

/**
 * Return the self-contained guard block. The block adds no top-level bindings and does
 * not call a cua API itself, so the first Codex call still makes exactly one API call.
 * Installed wrappers read the current allowUserTabs value when they run. O(1) source.
 * @param {boolean} allowUserTabs current value of the allowUserTabs setting.
 * @returns {string} JavaScript source for one guarded browser call.
 */
export function tabGuardSource(allowUserTabs = false) {
  return `{
  const allowedKey = Symbol.for('dsh-pc-use.userTabs.allowed');
  Object.defineProperty(globalThis, allowedKey, {
    value: ${allowUserTabs === true ? 'true' : 'false'},
    writable: true,
    enumerable: false,
    configurable: true,
  });
  const guardKey = Symbol.for('dsh-pc-use.tabGuard');
  const tabsKey = Symbol.for('dsh-pc-use.tabGuard.tabs');
  const cua = globalThis.cua;
  let recorded = globalThis[tabsKey];
  if (!(recorded instanceof Set)) {
    recorded = new Set();
    Object.defineProperty(globalThis, tabsKey, { value: recorded, configurable: true });
  }
  const usable = cua !== null && typeof cua === 'object'
    && typeof cua.createBrowserTab === 'function'
    && typeof cua.listTabs === 'function';
  if (usable && cua[guardKey] !== true) {
    const originalCreate = cua.createBrowserTab;
    const originalList = cua.listTabs;
    cua.createBrowserTab = function (...args) {
      const result = originalCreate.apply(this, args);
      if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
        return result.then((tab) => {
          if (tab !== null && tab !== undefined
            && tab.id !== null && tab.id !== undefined) {
            recorded.add(String(tab.id));
          }
          return tab;
        });
      }
      if (result !== null && result !== undefined
        && result.id !== null && result.id !== undefined) {
        recorded.add(String(result.id));
      }
      return result;
    };
    cua.listTabs = function (...args) {
      const last = args.length > 0 ? args[args.length - 1] : undefined;
      const hasOptions = last !== null && typeof last === 'object' && !Array.isArray(last);
      const wantsOutput = !hasOptions || last.emit !== false;
      if (hasOptions) args[args.length - 1] = { ...last, emit: false };
      else args.push({ emit: false });
      const finish = (items) => {
        const filtered = Array.isArray(items)
          ? items.filter((item) => item !== null && item !== undefined
            && recorded.has(String(item.id)))
          : [];
        if (wantsOutput && globalThis.nodeRepl !== undefined) {
          globalThis.nodeRepl.write(JSON.stringify(filtered.map((item) => ({
            id: item.id, title: item.title, url: item.url,
          }))));
        }
        return filtered;
      };
      const result = originalList.apply(this, args);
      if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
        return result.then(finish);
      }
      return finish(result);
    };
    Object.defineProperty(cua, guardKey, { value: true, configurable: true });
  }
  // cua_repl's cua.browsers, Browser and browser.user are runtime proxies that cache a
  // wrapper by property name on the first read. Writing a replacement with defineProperty
  // changes only the target, while reads keep returning the cached wrapper; the old guard
  // therefore did nothing. The views below are the only objects this guard writes to; the
  // real runtime objects are never modified.
  const installKey = Symbol.for('dsh-pc-use.userTabs.guard.v3');
  const blocked = (name) => new Error("dsh-pc-use blocked " + name + "(): the allowUserTabs "
    + "setting is off. It protects user tabs and history. If the user wants you to "
    + "use them, tell the user to turn on allowUserTabs in the dsh-pc-use settings.");
  const rememberClaim = (tab) => {
    if (tab !== null && tab !== undefined && tab.id !== null && tab.id !== undefined) {
      recorded.add(String(tab.id));
    }
    return tab;
  };
  const recordClaim = (result) => {
    if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
      return result.then(rememberClaim);
    }
    return rememberClaim(result);
  };
  const browserViews = new WeakMap();
  const userViews = new WeakMap();
  const tabsViews = new WeakMap();
  const isObject = (value) => value !== null
    && (typeof value === 'object' || typeof value === 'function');
  // A non-configurable, non-writable data property cannot be shadowed by a Proxy get trap.
  // Return a box so a fixed undefined value is distinguishable from "not fixed".
  const fixed = (holder, key) => {
    const desc = Object.getOwnPropertyDescriptor(holder, key);
    if (desc === undefined || desc.configurable !== false || desc.writable !== false
      || !('value' in desc)) {
      return null;
    }
    return { value: desc.value };
  };
  const ownsRef = (value) => (typeof value === 'string' || typeof value === 'number')
    && recorded.has(String(value));
  const ownsTabArg = (value) => ownsRef(value) || (isObject(value)
    && value.id !== null && value.id !== undefined && recorded.has(String(value.id)));
  // Read the original only when the method is actually called: reading it while building a
  // view would let the runtime proxy cache the unguarded wrapper.
  const callMethod = (holder, name, label, after) => function (...args) {
    if (globalThis[allowedKey] !== true) {
      return Promise.reject(blocked(label));
    }
    const result = Reflect.apply(Reflect.get(holder, name), holder, args);
    return after === undefined ? result : after(result);
  };
  const makeUserView = (user) => {
    const labels = {
      openTabs: 'browser.user.openTabs',
      claimTab: 'browser.user.claimTab',
      getTabContext: 'browser.user.getTabContext',
    };
    const methods = {
      openTabs: callMethod(user, 'openTabs', labels.openTabs),
      claimTab: callMethod(user, 'claimTab', labels.claimTab, recordClaim),
      getTabContext: callMethod(user, 'getTabContext', labels.getTabContext),
    };
    return new Proxy(user, {
      get(_target, key) {
        if (labels[key] !== undefined) {
          const pinned = fixed(user, key);
          if (pinned !== null) {
            if (globalThis[allowedKey] !== true) throw blocked(labels[key]);
            return pinned.value;
          }
          return methods[key];
        }
        return Reflect.get(user, key);
      },
    });
  };
  const userView = (user) => {
    if (!isObject(user)) return user;
    const cached = userViews.get(user);
    if (cached !== undefined) return cached;
    const view = makeUserView(user);
    userViews.set(user, view);
    return view;
  };
  const makeTabsView = (tabs) => {
    const guarded = (name, label, after) => function (...args) {
      if (globalThis[allowedKey] !== true && !ownsTabArg(args[0])) {
        return Promise.reject(blocked(label));
      }
      const result = Reflect.apply(Reflect.get(tabs, name), tabs, args);
      return after === undefined ? result : after(result);
    };
    const forwarded = (name) => function (...args) {
      return Reflect.apply(Reflect.get(tabs, name), tabs, args);
    };
    const methods = {
      get: guarded('get', 'browser.tabs.get', recordClaim),
      content: guarded('content', 'browser.tabs.content'),
      new: function (...args) {
        return recordClaim(Reflect.apply(Reflect.get(tabs, 'new'), tabs, args));
      },
      list: forwarded('list'),
      selected: forwarded('selected'),
    };
    const labels = {
      get: 'browser.tabs.get',
      content: 'browser.tabs.content',
    };
    return new Proxy(tabs, {
      get(_target, key) {
        if (labels[key] !== undefined) {
          const pinned = fixed(tabs, key);
          if (pinned !== null) {
            if (globalThis[allowedKey] !== true) throw blocked(labels[key]);
            return pinned.value;
          }
          return methods[key];
        }
        if (key === 'new' || key === 'list' || key === 'selected') {
          const pinned = fixed(tabs, key);
          return pinned !== null ? pinned.value : methods[key];
        }
        return Reflect.get(tabs, key);
      },
    });
  };
  const tabsView = (tabs) => {
    if (!isObject(tabs)) return tabs;
    const cached = tabsViews.get(tabs);
    if (cached !== undefined) return cached;
    const view = makeTabsView(tabs);
    tabsViews.set(tabs, view);
    return view;
  };
  const makeBrowserView = (browser) => {
    const historyLabel = 'browser.history';
    const historyMethod = callMethod(browser, 'history', historyLabel);
    return new Proxy(browser, {
      get(_target, key) {
        if (key === 'user') {
          const pinned = fixed(browser, key);
          if (pinned !== null) {
            if (globalThis[allowedKey] !== true) throw blocked('browser.user');
            return pinned.value;
          }
          return userView(Reflect.get(browser, key));
        }
        if (key === 'history') {
          const pinned = fixed(browser, key);
          if (pinned !== null) {
            if (globalThis[allowedKey] !== true) throw blocked(historyLabel);
            return pinned.value;
          }
          return historyMethod;
        }
        if (key === 'tabs') {
          const pinned = fixed(browser, key);
          if (pinned !== null) {
            if (globalThis[allowedKey] !== true) throw blocked('browser.tabs');
            return pinned.value;
          }
          return tabsView(Reflect.get(browser, key));
        }
        return Reflect.get(browser, key);
      },
    });
  };
  const browserView = (browser) => {
    if (!isObject(browser)) return browser;
    const cached = browserViews.get(browser);
    if (cached !== undefined) return cached;
    const view = makeBrowserView(browser);
    browserViews.set(browser, view);
    return view;
  };
  const wrapResult = (result) => {
    if (result !== null && typeof result === 'object'
      && typeof result.then === 'function') {
      return result.then((browser) => browserView(browser));
    }
    return browserView(result);
  };
  const readBrowserDescriptor = () => {
    let holder = cua;
    while (holder !== null && holder !== undefined) {
      const desc = Object.getOwnPropertyDescriptor(holder, 'browsers');
      if (desc !== undefined) return desc;
      holder = Object.getPrototypeOf(holder);
    }
    return undefined;
  };
  // If cua.browsers is an accessor, call the getter on every use so the view always wraps
  // the object the runtime returns for that read.
  const installBrowserView = () => {
    const desc = readBrowserDescriptor();
    if (desc === undefined) return;
    const getter = typeof desc.get === 'function' ? desc.get : null;
    const value = getter === null ? desc.value : undefined;
    const current = () => (getter === null ? value : getter.call(cua));
    const entrance = (name) => function (...args) {
      const holder = current();
      return wrapResult(Reflect.apply(Reflect.get(holder, name), holder, args));
    };
    const get = entrance('get');
    const getDefault = entrance('getDefault');
    const getForUrl = entrance('getForUrl');
    const view = new Proxy({}, {
      get(_target, key) {
        if (key === 'get') return get;
        if (key === 'getDefault') return getDefault;
        if (key === 'getForUrl') return getForUrl;
        return Reflect.get(current(), key);
      },
      // Feature detection must see the same entrances the get trap serves; the empty target
      // would otherwise report none of them.
      has(_target, key) {
        return Reflect.has(current(), key);
      },
    });
    try {
      Object.defineProperty(cua, 'browsers', {
        value: view,
        writable: true,
        enumerable: desc.enumerable !== false,
        configurable: true,
      });
    } catch {}
  };
  const installGetBrowser = () => {
    let original;
    try {
      original = cua.getBrowser;
    } catch {
      return;
    }
    if (typeof original !== 'function') return;
    try {
      cua.getBrowser = function (...args) {
        return wrapResult(original.apply(this, args));
      };
    } catch {}
  };
  const installGetTab = () => {
    let original;
    try {
      original = cua.getTab;
    } catch {
      return;
    }
    if (typeof original !== 'function') return;
    try {
      cua.getTab = function (...args) {
        if (globalThis[allowedKey] !== true && !ownsRef(args[0])) {
          return Promise.reject(blocked('cua.getTab'));
        }
        const result = original.apply(this, args);
        return globalThis[allowedKey] === true ? recordClaim(result) : result;
      };
    } catch {}
  };
  // Copy the returned state and filter its tabs; the runtime object is never modified.
  const filterState = (state, wantsOutput) => {
    if (!isObject(state)) return state;
    const copy = { ...state };
    let hidden = 0;
    if (Array.isArray(state.browsers)) {
      copy.browsers = state.browsers.map((browser) => {
        if (!isObject(browser) || !Array.isArray(browser.tabs)) return browser;
        const tabs = browser.tabs.filter((tab) => {
          const keep = isObject(tab) && tab.id !== null && tab.id !== undefined
            && recorded.has(String(tab.id));
          if (!keep) hidden += 1;
          return keep;
        });
        return { ...browser, tabs };
      });
    }
    if (wantsOutput && globalThis.nodeRepl !== undefined) {
      const text = hidden > 0
        ? JSON.stringify(copy) + '\\n' + hidden
          + ' user tabs hidden because allowUserTabs is off'
        : JSON.stringify(copy);
      globalThis.nodeRepl.write(text);
    }
    return copy;
  };
  const installGetState = () => {
    let original;
    try {
      original = cua.getState;
    } catch {
      return;
    }
    if (typeof original !== 'function') return;
    try {
      cua.getState = function (...args) {
        if (globalThis[allowedKey] === true) return original.apply(this, args);
        const last = args.length > 0 ? args[args.length - 1] : undefined;
        const hasOptions = last !== null && typeof last === 'object' && !Array.isArray(last);
        const wantsOutput = !hasOptions || last.emit !== false;
        if (hasOptions) args[args.length - 1] = { ...last, emit: false };
        else args.push({ emit: false });
        const result = original.apply(this, args);
        if (result !== null && typeof result === 'object'
          && typeof result.then === 'function') {
          return result.then((state) => filterState(state, wantsOutput));
        }
        return filterState(result, wantsOutput);
      };
    } catch {}
  };
  try {
    if (isObject(cua) && cua[installKey] !== true) {
      Object.defineProperty(cua, installKey, { value: true, configurable: true });
      installGetBrowser();
      installBrowserView();
      installGetTab();
      installGetState();
    }
  } catch {}
}`;
}
