import type { FeatureSpec, FeatureTab } from './features.js';

export class Toolbar {
  readonly element: HTMLElement;
  private readonly actions: HTMLElement;
  private readonly groupsRow: HTMLElement;
  private readonly tabButtons = new Map<string, HTMLButtonElement>();
  private active: string;

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

    this.select(this.active);
  }

  appendAction(element: HTMLElement): void {
    this.actions.append(element);
  }

  select(tabId: string): void {
    this.active = tabId;
    for (const [id, button] of this.tabButtons) {
      button.classList.toggle('is-active', id === tabId);
    }

    this.groupsRow.replaceChildren();
    const tab = this.tabs.find((candidate) => candidate.id === tabId);
    if (tab === undefined) return;

    tab.groups.forEach((group, index) => {
      if (index > 0) {
        const divider = document.createElement('div');
        divider.className = 'group-divider';
        this.groupsRow.append(divider);
      }

      const wrapper = document.createElement('div');
      wrapper.className = 'tool-group';

      const buttons = document.createElement('div');
      buttons.className = 'group-buttons';
      for (const spec of group.features) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'tool-button';
        button.textContent = spec.label;
        button.addEventListener('click', () => this.onChoose(spec));
        buttons.append(button);
      }

      const label = document.createElement('div');
      label.className = 'group-label';
      label.textContent = group.label;

      wrapper.append(buttons, label);
      this.groupsRow.append(wrapper);
    });
  }
}
