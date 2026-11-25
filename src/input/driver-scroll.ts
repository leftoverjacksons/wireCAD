/**
 * Keeps 3Dconnexion's driver from zooming the view a second time.
 *
 * For an application it has no profile for, 3DxWare turns pushing the cap
 * into scroll-wheel events. Here the wheel zooms, in steps, so a push zoomed
 * twice — smoothly through WebHID and in jumps through the driver — and the
 * view snapped.
 *
 * Dropping wheel events while the cap is moving was not enough on its own: the
 * driver's first event of a push can arrive before the browser has the HID
 * report saying the cap moved, and that one got through. So while a SpaceMouse
 * is connected, a wheel event over the view or the node editor is held for a
 * moment and replayed only if no motion turns up around it.
 */
import type { SpaceMouse } from './spacemouse-hid.js';

/**
 * How long a wheel event waits for the HID report that would show the driver
 * made it. Costs a real wheel this much delay, and only while connected.
 */
const HOLD_MS = 80;
/**
 * How long before a wheel event cap motion still condemns it. Generous: the
 * driver can keep scrolling a little after the cap is let go.
 */
const BEFORE_MS = 250;

export type ScrollVerdict = 'passed' | 'dropped' | 'held' | 'replayed';

export function installDriverScrollFilter(
  spaceMouse: SpaceMouse,
  /** Surfaces whose wheel does nothing native, so a replayed copy is the same. */
  surfaces: readonly HTMLElement[],
  observe: (event: WheelEvent, verdict: ScrollVerdict) => void = () => undefined,
): void {
  // A replayed copy is let through rather than held again.
  const replays = new WeakSet<Event>();

  const swallow = (event: WheelEvent): void => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  window.addEventListener(
    'wheel',
    (event) => {
      if (replays.has(event)) return;
      if (!spaceMouse.connected) return;

      const arrived = performance.now();
      if (spaceMouse.movedSince(arrived - BEFORE_MS)) {
        swallow(event);
        observe(event, 'dropped');
        return;
      }

      // Anywhere else — a dialog or a panel that scrolls — a copy would not
      // scroll it, so only the canvas surfaces wait.
      const target = event.target;
      if (!(target instanceof Node) || !surfaces.some((surface) => surface.contains(target))) {
        observe(event, 'passed');
        return;
      }

      swallow(event);
      observe(event, 'held');
      const copy = new WheelEvent('wheel', {
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaZ: event.deltaZ,
        deltaMode: event.deltaMode,
        clientX: event.clientX,
        clientY: event.clientY,
        screenX: event.screenX,
        screenY: event.screenY,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        buttons: event.buttons,
        bubbles: true,
        cancelable: true,
        composed: true,
      });
      window.setTimeout(() => {
        // Motion at any point from shortly before the event until now.
        if (spaceMouse.movedSince(arrived - BEFORE_MS)) {
          observe(event, 'dropped');
          return;
        }
        replays.add(copy);
        observe(copy, 'replayed');
        target.dispatchEvent(copy);
      }, HOLD_MS);
    },
    { capture: true, passive: false },
  );
}
