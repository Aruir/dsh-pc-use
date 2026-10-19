// Guard source prepended to browser cua_repl programs. It wraps cua.createBrowserTab and
// cua.listTabs so a session only sees the tabs it opened, and wraps every Browser returned
// by cua.getBrowser / cua.browsers.{get,getDefault,getForUrl} so the user's own tabs and
// browsing history stay blocked while allowUserTabs is off. The tab-guard marker lives on
// the cua object (so a replaced cua is wrapped again); recorded ids live in a global Symbol
// slot (so replacing cua does not lose the session's own tab ids). The allowUserTabs value
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
  const userGuardKey = Symbol.for('dsh-pc-use.userTabs.guard');
  const userWrappedKey = Symbol.for('dsh-pc-use.userTabs.wrapped');
  const blocked = (name) => new Error("dsh-pc-use blocked " + name + "(): the allowUserTabs "
    + "setting is off. It protects the user's own tabs and history. If the user wants you to "
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
  // Own property on the holder: works whether the original method is own or inherited.
  // The wrapper reads the allowUserTabs value at call time, never at install time. O(1).
  const shield = (holder, name, label, after) => {
    let original;
    try {
      original = holder[name];
    } catch {
      return;
    }
    if (typeof original !== 'function') return;
    try {
      Object.defineProperty(holder, name, {
        value: function (...args) {
          if (globalThis[allowedKey] !== true) {
            return Promise.reject(blocked(label));
          }
          const result = original.apply(this, args);
          return after === undefined ? result : after(result);
        },
        writable: true,
        enumerable: false,
        configurable: true,
      });
    } catch {}
  };
  // Guard one Browser object once; a frozen object is skipped silently (README limitation).
  const guardBrowser = (browser) => {
    if (browser === null || (typeof browser !== 'object' && typeof browser !== 'function')) {
      return;
    }
    try {
      if (browser[userWrappedKey] === true) return;
      Object.defineProperty(browser, userWrappedKey, {
        value: true,
        writable: false,
        enumerable: false,
        configurable: true,
      });
    } catch {
      return;
    }
    let user = null;
    try {
      user = browser.user;
    } catch {}
    if (user !== null && (typeof user === 'object' || typeof user === 'function')) {
      shield(user, 'openTabs', 'browser.user.openTabs');
      shield(user, 'claimTab', 'browser.user.claimTab', recordClaim);
      shield(user, 'getTabContext', 'browser.user.getTabContext');
    }
    shield(browser, 'history', 'browser.history');
  };
  // Wrap one entrance; a sync return and a Promise are both guarded. O(1) per call.
  const wrapEntrance = (holder, name) => {
    let original;
    try {
      original = holder[name];
    } catch {
      return;
    }
    if (typeof original !== 'function') return;
    try {
      Object.defineProperty(holder, name, {
        value: function (...args) {
          const result = original.apply(this, args);
          if (result !== null && typeof result === 'object'
            && typeof result.then === 'function') {
            return result.then((browser) => {
              guardBrowser(browser);
              return browser;
            });
          }
          guardBrowser(result);
          return result;
        },
        writable: true,
        enumerable: false,
        configurable: true,
      });
    } catch {}
  };
  try {
    if (cua !== null && (typeof cua === 'object' || typeof cua === 'function')
      && cua[userGuardKey] !== true) {
      Object.defineProperty(cua, userGuardKey, { value: true, configurable: true });
      wrapEntrance(cua, 'getBrowser');
      const browsers = cua.browsers;
      if (browsers !== null
        && (typeof browsers === 'object' || typeof browsers === 'function')) {
        wrapEntrance(browsers, 'get');
        wrapEntrance(browsers, 'getDefault');
        wrapEntrance(browsers, 'getForUrl');
      }
    }
  } catch {}
}`;
}
