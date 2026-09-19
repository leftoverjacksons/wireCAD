/**
 * The menu a right-click opens, wherever it is opened.
 *
 * There are two places that want one — a node in the graph, a body in the view
 * — and they are two views of the same document, so they had better look and
 * behave like one thing. What goes in it is decided elsewhere; this is only how
 * it is drawn, placed and dismissed.
 */

export interface MenuItem {
  action: string;
  label: string;
  /** What it will do to the rest of the document, where that is worth saying. */
  detail?: string;
  /** Why it would do nothing here. Set means the entry is there but dead. */
  refusal?: string;
  /** Draw a rule above this entry. */
  divide?: boolean;
}

export interface MenuRequest {
  /** What the menu is about, in a word or two. */
  title: string;
  items: readonly MenuItem[];
  /** Where the pointer was, in client coordinates. */
  clientX: number;
  clientY: number;
  onChoose(action: string): void;
}

/**
 * Puts a menu on screen and hands back the way to take it off again.
 *
 * Dismissal is the menu's own business: a click anywhere else, Escape, the
 * wheel, or the window losing focus. Every one of them is a way of saying "not
 * that", and a menu that survives any of them is a menu in the way.
 */
export function showMenu(container: HTMLElement, request: MenuRequest): () => void {
  const menu = document.createElement('div');
  menu.className = 'menu';

  const heading = document.createElement('div');
  heading.className = 'menu-title';
  heading.textContent = request.title;
  menu.append(heading);

  let close = (): void => undefined;

  for (const item of request.items) {
    const entry = document.createElement('button');
    entry.type = 'button';
    entry.className = 'menu-item';
    entry.dataset.action = item.action;
    if (item.divide === true) entry.classList.add('menu-divided');

    const label = document.createElement('span');
    label.className = 'menu-label';
    label.textContent = item.label;
    entry.append(label);

    const note = item.refusal ?? item.detail;
    if (note !== undefined) {
      const detail = document.createElement('span');
      detail.className = 'menu-detail';
      detail.textContent = note;
      entry.append(detail);
    }

    // An entry that would do nothing stays, saying why, rather than leaving a
    // gap that reads as the menu not having thought of it.
    if (item.refusal !== undefined) {
      entry.disabled = true;
      entry.title = item.refusal;
    } else {
      entry.addEventListener('click', () => {
        close();
        request.onChoose(item.action);
      });
    }

    menu.append(entry);
  }

  container.append(menu);

  // Where the pointer was, pulled back inside when that would hang it off the
  // edge: a menu you have to scroll to reach is a menu you cannot use.
  const rect = container.getBoundingClientRect();
  const x = Math.min(request.clientX - rect.left, rect.width - menu.offsetWidth - 6);
  const y = Math.min(request.clientY - rect.top, rect.height - menu.offsetHeight - 6);
  menu.style.left = `${Math.max(6, x)}px`;
  menu.style.top = `${Math.max(6, y)}px`;

  const dismiss = (event: Event): void => {
    if (event.target instanceof Node && menu.contains(event.target)) return;
    close();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') close();
  };

  let closed = false;
  close = (): void => {
    if (closed) return;
    closed = true;
    menu.remove();
    window.removeEventListener('pointerdown', dismiss, true);
    window.removeEventListener('wheel', dismiss, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', close);
  };

  window.addEventListener('pointerdown', dismiss, true);
  window.addEventListener('wheel', dismiss, true);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', close);

  return close;
}
