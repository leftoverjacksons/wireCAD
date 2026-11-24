import type { FeatureSpec, FeatureTab } from './features.js';

/**
 * A tab that belongs to something happening rather than to the program: it
 * appears when that starts, opens itself, and goes when it ends. Its buttons
 * are handed over ready-made, because they belong to whoever is running it.
 */
interface ContextTab {
  id: string;
  label: string;
  groups: ReadonlyArray<{ label: string; buttons: HTMLElement[] }>;
  button: HTMLButtonElement;
  /** Shown beside the tab for as long as it is up: how to end what it is for. */
  extra: HTMLElement | null;
  /** The tab that was open before this one opened itself, to go back to. */
  returnTo: string;
}
import { attachIconMotion, featureIcon } from './icons.js';

export class Toolbar {
  readonly element: HTMLElement;
  private readonly actions: HTMLElement;
  private readonly groupsRow: HTMLElement;
  private readonly tabButtons = new Map<string, HTMLButtonElement>();
  private active: string;
  private readonly heightListeners: Array<(below: number) => void> = [];
  private readonly tabsRow: HTMLElement;
  private context: ContextTab | null = null;

  constructor(
    container: HTMLElement,
    private readonly tabs: readonly FeatureTab[],
    private readonly onChoose: (spec: FeatureSpec) => void,
  ) {
    this.active = tabs[0]?.id ?? '';

    this.element = document.createElement('div');
    this.element.className = 'toolbar';

    const tabsRow = document.createElement('div');
    tabsRow.className = 'toolbar-row toolbar-tabs';
    this.tabsRow = tabsRow;

    for (const tab of tabs) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'toolbar-tab';
      button.textContent = tab.label;
      button.addEventListener('click', () => this.select(tab.id));
      this.tabButtons.set(tab.id, button);
      tabsRow.append(button);
    }

    const gap = document.createElement('div');
    gap.className = 'toolbar-gap';

    this.actions = document.createElement('div');
    this.actions.className = 'toolbar-actions';
    tabsRow.append(gap, this.actions);

    this.groupsRow = document.createElement('div');
    this.groupsRow.className = 'toolbar-row toolbar-groups';

    this.element.append(tabsRow, this.groupsRow);
    container.append(this.element);

    // The dialogs and the sketch panel open just under the toolbar, and how
    // tall the toolbar is depends on its icons, its font and the tab showing.
    // Measured rather than written down, so a restyle cannot leave a dialog
    // underneath it.
    const measure = (): void => {
      const below = this.element.offsetTop + this.element.offsetHeight + 8;
      container.style.setProperty('--below-toolbar', `${below}px`);
      for (const listener of this.heightListeners) listener(below);
    };
    this.remeasure = measure;
    if (typeof ResizeObserver === 'function') new ResizeObserver(measure).observe(this.element);

    this.select(this.active);
    measure();
  }

  private remeasure: (() => void) | undefined;

  /** Told how far down the toolbar reaches, now and whenever that changes. */
  onHeightChange(listener: (below: number) => void): void {
    this.heightListeners.push(listener);
    this.remeasure?.();
  }

  appendAction(element: HTMLElement): void {
    this.actions.append(element);
  }

  /**
   * Shows a tab for something that has just started, and opens it. Showing it
   * again while it is up — a session picking itself back up after an undo —
   * keeps it rather than adding a second.
   */
  showContext(
    id: string,
    label: string,
    groups: ContextTab['groups'],
    extra: HTMLElement | null = null,
  ): void {
    if (this.context !== null && this.context.id === id) {
      this.context.groups = groups;
      this.select(id);
      return;
    }
    this.hideContext();

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toolbar-tab toolbar-tab-context';
    button.textContent = label;
    button.addEventListener('click', () => this.select(id));
    this.tabsRow.prepend(button);
    if (extra !== null) button.after(extra);

    this.context = { id, label, groups, button, extra, returnTo: this.active };
    this.select(id);
  }

  /** Takes the tab away again, and goes back to the tab that was open before it. */
  hideContext(): void {
    const context = this.context;
    if (context === null) return;
    this.context = null;
    context.button.remove();
    context.extra?.remove();
    this.select(this.active === context.id ? context.returnTo : this.active);
  }

  select(tabId: string): void {
    this.active = tabId;
    for (const [id, button] of this.tabButtons) {
      button.classList.toggle('is-active', id === tabId);
    }
    const context = this.context;
    context?.button.classList.toggle('is-active', context.id === tabId);

    this.groupsRow.replaceChildren();
    if (context !== null && context.id === tabId) {
      this.layOut(context.groups);
      this.remeasure?.();
      return;
    }

    const tab = this.tabs.find((candidate) => candidate.id === tabId);
    if (tab === undefined) return;

    this.layOut(
      tab.groups.map((group) => ({
        label: group.label,
        buttons: group.features.map((spec) => this.featureTile(spec)),
      })),
    );
    this.remeasure?.();
  }

  private featureTile(spec: FeatureSpec): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tool-tile';
    // The icon is decoration to a screen reader, so the button's name is its
    // label and nothing else — which is also what the tests find it by.
    const icon = featureIcon(spec.id);
    if (icon !== null) button.append(icon);
    const label = document.createElement('span');
    label.className = 'tool-tile-label';
    label.textContent = spec.label;
    button.append(label);
    attachIconMotion(button);
    button.addEventListener('click', () => this.onChoose(spec));
    return button;
  }

  private layOut(groups: ReadonlyArray<{ label: string; buttons: HTMLElement[] }>): void {
    groups.forEach((group, index) => {
      if (index > 0) {
        const divider = document.createElement('div');
        divider.className = 'group-divider';
        this.groupsRow.append(divider);
      }

      const wrapper = document.createElement('div');
      wrapper.className = 'tool-group';

      const buttons = document.createElement('div');
      buttons.className = 'group-buttons';
      buttons.append(...group.buttons);

      const label = document.createElement('div');
      label.className = 'group-label';
      label.textContent = group.label;

      wrapper.append(buttons, label);
      this.groupsRow.append(wrapper);
    });
  }
}
