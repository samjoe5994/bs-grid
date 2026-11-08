/** Port of AG's `AutoScrollService` (ag-stack rendering/autoScrollService.ts) — scrolls the
 *  viewport while a drag is held near/past its edge, so a cell range can be extended beyond
 *  the visible window. Same thresholds AG uses: a 20px hot zone per edge, a 100ms tick, and a
 *  ramping tick distance (40px, 80px after 10 ticks, 200px after 20). */
export interface AutoScrollParams {
  scrollContainer: HTMLElement;
  scrollAxis: 'x' | 'y' | 'xy';
  scrollByTick?: number;
  getVerticalPosition?: () => number;
  setVerticalPosition?: (position: number) => void;
  getHorizontalPosition?: () => number;
  setHorizontalPosition?: (position: number) => void;
  shouldSkipVerticalScroll?: () => boolean;
  shouldSkipHorizontalScroll?: () => boolean;
  /** offset from the top of the scroll container to the start of the scrollable row area */
  getTopOffset?: () => number;
  /** offset from the bottom of the scroll container to the end of the scrollable row area */
  getBottomOffset?: () => number;
  onScrollCallback?: () => void;
}

export class AutoScrollService {
  private tickingInterval: any = null;
  private tickCount = 0;
  private tickLeft = false;
  private tickRight = false;
  private tickUp = false;
  private tickDown = false;

  private readonly scrollHorizontally: boolean;
  private readonly scrollVertically: boolean;
  private readonly scrollByTick: number;

  constructor(private readonly params: AutoScrollParams) {
    this.scrollHorizontally = params.scrollAxis.includes('x');
    this.scrollVertically = params.scrollAxis.includes('y');
    this.scrollByTick = params.scrollByTick ?? 20;
  }

  get scrolling(): boolean { return this.tickingInterval !== null; }

  check(mouseEvent: { clientX: number; clientY: number }, forceSkipVerticalScroll = false): void {
    const p = this.params;
    const skipVertical = !this.scrollVertically || forceSkipVerticalScroll || !!p.shouldSkipVerticalScroll?.();
    const skipHorizontal = !this.scrollHorizontally || !!p.shouldSkipHorizontalScroll?.();
    if (skipVertical && skipHorizontal) return;

    const rect = p.scrollContainer.getBoundingClientRect();
    const tick = this.scrollByTick;
    const topOffset = p.getTopOffset?.() ?? 0;
    const bottomOffset = p.getBottomOffset?.() ?? 0;

    this.tickLeft = !skipHorizontal && mouseEvent.clientX < rect.left + tick;
    this.tickRight = !skipHorizontal && mouseEvent.clientX > rect.right - tick;
    this.tickUp = !skipVertical && mouseEvent.clientY < rect.top + topOffset + tick;
    this.tickDown = !skipVertical && mouseEvent.clientY > rect.bottom - bottomOffset - tick;

    if (this.tickLeft || this.tickRight || this.tickUp || this.tickDown) this.ensureTickingStarted();
    else this.ensureCleared();
  }

  ensureCleared(): void {
    if (this.tickingInterval) {
      clearInterval(this.tickingInterval);
      this.tickingInterval = null;
    }
  }

  private ensureTickingStarted(): void {
    if (this.tickingInterval === null) {
      this.tickingInterval = setInterval(() => this.doTick(), 100);
      this.tickCount = 0;
    }
  }

  private doTick(): void {
    this.tickCount++;
    const amount = this.tickCount > 20 ? 200 : this.tickCount > 10 ? 80 : 40;
    const p = this.params;

    if (this.scrollVertically) {
      const top = p.getVerticalPosition!();
      if (this.tickUp) p.setVerticalPosition!(top - amount);
      if (this.tickDown) p.setVerticalPosition!(top + amount);
    }
    if (this.scrollHorizontally) {
      const left = p.getHorizontalPosition!();
      if (this.tickLeft) p.setHorizontalPosition!(left - amount);
      if (this.tickRight) p.setHorizontalPosition!(left + amount);
    }

    p.onScrollCallback?.();
  }
}
