/**
 * The browser side of the SpaceMouse: finding the device through WebHID,
 * listening to it, and holding what it last said.
 *
 * WebHID exists in Chromium-based browsers only. Everywhere else `supported` is
 * false and nothing here does anything.
 */
import type { Motion, RawAxes, SpaceMouseSettings } from './spacemouse.js';
import {
  STILL,
  USAGE_MULTI_AXIS,
  USAGE_PAGE_GENERIC_DESKTOP,
  VENDOR_3DCONNEXION,
  VENDOR_LOGITECH,
  ZERO_AXES,
  isStill,
  parseSettings,
  pressed,
  readReport,
  toMotion,
} from './spacemouse.js';

// The DOM library TypeScript ships has no WebHID, so the little of it used here
// is described locally rather than pulling in a package for it.
interface HidInputReportEvent extends Event {
  readonly device: HidDevice;
  readonly reportId: number;
  readonly data: DataView;
}

interface HidCollection {
  usagePage?: number;
  usage?: number;
}

interface HidDevice extends EventTarget {
  readonly opened: boolean;
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  readonly collections: readonly HidCollection[];
  open(): Promise<void>;
  close(): Promise<void>;
}

interface HidConnectionEvent extends Event {
  readonly device: HidDevice;
}

interface HidFilter {
  vendorId?: number;
  usagePage?: number;
  usage?: number;
}

interface Hid extends EventTarget {
  getDevices(): Promise<HidDevice[]>;
  requestDevice(options: { filters: HidFilter[] }): Promise<HidDevice[]>;
}

const FILTERS: HidFilter[] = [
  { vendorId: VENDOR_3DCONNEXION },
  { vendorId: VENDOR_LOGITECH, usagePage: USAGE_PAGE_GENERIC_DESKTOP, usage: USAGE_MULTI_AXIS },
];

const SETTINGS_KEY = 'wirecad.spacemouse';

function hid(): Hid | null {
  const candidate = (navigator as Navigator & { hid?: Hid }).hid;
  return candidate ?? null;
}

/**
 * A Logitech device is one of ours only if it is a multi-axis controller; the
 * same vendor ID is on every Logitech mouse and keyboard, and a device granted
 * earlier for something else must not be mistaken for a SpaceMouse.
 */
function isSpaceMouse(device: HidDevice): boolean {
  if (device.vendorId === VENDOR_3DCONNEXION) return true;
  return (
    device.vendorId === VENDOR_LOGITECH &&
    device.collections.some(
      (c) => c.usagePage === USAGE_PAGE_GENERIC_DESKTOP && c.usage === USAGE_MULTI_AXIS,
    )
  );
}

export class SpaceMouse {
  readonly supported = hid() !== null;
  private device: HidDevice | null = null;
  private axes: RawAxes = { ...ZERO_AXES };
  private buttons = 0;
  private settingsValue: SpaceMouseSettings;
  private readonly buttonListeners = new Set<(button: number) => void>();
  private readonly stateListeners = new Set<() => void>();

  private readonly onReport = (event: Event): void => {
    const { reportId, data } = event as HidInputReportEvent;
    const before = this.buttons;
    const next = readReport(this.axes, this.buttons, reportId, data);
    this.axes = next.axes;
    this.buttons = next.buttons;
    if (next.changed !== 'buttons') return;
    for (const button of pressed(before, this.buttons)) {
      for (const listener of this.buttonListeners) listener(button);
    }
  };

  constructor() {
    this.settingsValue = parseSettings(readStored());

    const api = hid();
    if (api === null) return;

    api.addEventListener('connect', (event) => {
      const { device } = event as HidConnectionEvent;
      if (this.device === null && isSpaceMouse(device)) void this.use(device);
    });
    api.addEventListener('disconnect', (event) => {
      if ((event as HidConnectionEvent).device === this.device) this.drop();
    });

    // A cap held as the window loses focus would otherwise keep the view
    // moving until it came back: reports stop arriving, the last one stays.
    window.addEventListener('blur', () => this.release());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.release();
    });
  }

  get connected(): boolean {
    return this.device !== null;
  }

  get name(): string | null {
    return this.device?.productName ?? null;
  }

  get settings(): Readonly<SpaceMouseSettings> {
    return this.settingsValue;
  }

  updateSettings(change: Partial<SpaceMouseSettings>): void {
    this.settingsValue = { ...this.settingsValue, ...change };
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settingsValue));
    } catch {
      // Storage refused (private window, blocked site data): the setting holds
      // for this visit and is simply not remembered.
    }
  }

  /** What the cap is doing now, shaped and in the cap's own frame. */
  motion(): Motion {
    if (this.device === null) return STILL;
    const motion = toMotion(this.axes, this.settingsValue);
    return isStill(motion) ? STILL : motion;
  }

  onButton(listener: (button: number) => void): () => void {
    this.buttonListeners.add(listener);
    return () => this.buttonListeners.delete(listener);
  }

  /** Told whenever the device comes or goes. */
  onChange(listener: () => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /**
   * Picks up a device the person granted on an earlier visit, without asking.
   * The browser remembers the grant; only the first time needs the chooser.
   */
  async reconnect(): Promise<void> {
    const api = hid();
    if (api === null || this.device !== null) return;
    const granted = await api.getDevices();
    const device = granted.find(isSpaceMouse);
    if (device !== undefined) await this.use(device);
  }

  /**
   * Opens the browser's device chooser. Has to be called from a click or a key
   * press: the browser refuses it otherwise.
   */
  async request(): Promise<void> {
    const api = hid();
    if (api === null) throw new Error('this browser has no WebHID — try Chrome or Edge');
    const chosen = await api.requestDevice({ filters: FILTERS });
    const device = chosen.find(isSpaceMouse);
    if (device === undefined) return;
    await this.use(device);
  }

  async disconnect(): Promise<void> {
    const device = this.device;
    if (device === null) return;
    this.drop();
    await device.close();
  }

  private async use(device: HidDevice): Promise<void> {
    if (!device.opened) await device.open();
    // Opening can succeed and still be useless if another program holds the
    // device exclusively; nothing reports that, the reports simply never come.
    device.addEventListener('inputreport', this.onReport);
    this.device = device;
    this.release();
    this.changed();
  }

  private drop(): void {
    this.device?.removeEventListener('inputreport', this.onReport);
    this.device = null;
    this.release();
    this.changed();
  }

  private release(): void {
    this.axes = { ...ZERO_AXES };
    this.buttons = 0;
  }

  private changed(): void {
    for (const listener of this.stateListeners) listener();
  }
}

function readStored(): string | null {
  try {
    return window.localStorage.getItem(SETTINGS_KEY);
  } catch {
    return null;
  }
}
