/* A jsdom window installed as the globals React expects, plus act(). */
import { JSDOM } from 'jsdom';

export function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/', pretendToBeVisual: true
  });
  const w = dom.window;
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event',
                     'CustomEvent', 'getComputedStyle', 'MutationObserver', 'requestAnimationFrame',
                     'cancelAnimationFrame']) {
    if (w[key] !== undefined) globalThis[key] = w[key];
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return dom;
}

/** Let effects, microtasks and timers settle. */
export async function flush(act, ms = 0) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}
