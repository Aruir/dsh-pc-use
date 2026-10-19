// Guard source prepended to browser cua_repl programs. It wraps cua.createBrowserTab and
// cua.listTabs so a session only sees the tabs it opened. The marker lives on the cua
// object (so a replaced cua is wrapped again); recorded ids live in a global Symbol slot
// (so replacing cua does not lose the session's own tab ids).

/**
 * Return the self-contained guard block. The block adds no top-level bindings and does
 * not call a cua API itself, so the first Codex call still makes exactly one API call.
 * @returns JavaScript source for one guarded browser call.
 */
export function tabGuardSource() {
  return `{
  const guardKey = Symbol.for('dsh-pc-use.tabGuard');
  const tabsKey = Symbol.for('dsh-pc-use.tabGuard.tabs');
  const cua = globalThis.cua;
  const usable = cua !== null && typeof cua === 'object'
    && typeof cua.createBrowserTab === 'function'
    && typeof cua.listTabs === 'function';
  if (usable && cua[guardKey] !== true) {
    const recorded = globalThis[tabsKey] instanceof Set
      ? globalThis[tabsKey]
      : new Set();
    if (!(globalThis[tabsKey] instanceof Set)) {
      Object.defineProperty(globalThis, tabsKey, { value: recorded, configurable: true });
    }
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
}`;
}
