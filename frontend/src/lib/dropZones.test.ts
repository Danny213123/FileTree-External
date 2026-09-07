import { afterEach, describe, expect, it, vi } from "vitest";
import { dropZoneAt, registerDropZone } from "./dropZones";

/** jsdom has no layout, so hit-testing is stubbed to a chosen element. */
function pointAt(el: Element | null) {
  document.elementFromPoint = vi.fn(() => el) as unknown as typeof document.elementFromPoint;
}

describe("shell drop-zone registry", () => {
  afterEach(() => { document.body.innerHTML = ""; });

  it("resolves the zone from a descendant of the registered element", () => {
    // A shell drop reports a window position, which lands on whatever leaf is
    // painted there — usually a child of the element that registered.
    const zoneEl = document.createElement("div");
    const child = document.createElement("span");
    zoneEl.append(child);
    document.body.append(zoneEl);
    const onDrop = vi.fn();
    registerDropZone(zoneEl, { onDrop });

    pointAt(child);
    dropZoneAt(1, 1)?.zone.onDrop(["C:\\Users\\alex\\Downloads"]);

    expect(onDrop).toHaveBeenCalledWith(["C:\\Users\\alex\\Downloads"]);
  });

  it("stops resolving once unregistered", () => {
    const zoneEl = document.createElement("div");
    document.body.append(zoneEl);
    const dispose = registerDropZone(zoneEl, { onDrop: vi.fn() });

    pointAt(zoneEl);
    expect(dropZoneAt(1, 1)).not.toBeNull();

    dispose();
    expect(dropZoneAt(1, 1)).toBeNull();
  });

  it("picks the innermost zone when zones nest", () => {
    const outer = document.createElement("div");
    const inner = document.createElement("div");
    outer.append(inner);
    document.body.append(outer);
    const outerDrop = vi.fn();
    const innerDrop = vi.fn();
    registerDropZone(outer, { onDrop: outerDrop });
    registerDropZone(inner, { onDrop: innerDrop });

    pointAt(inner);
    dropZoneAt(1, 1)?.zone.onDrop([]);

    expect(innerDrop).toHaveBeenCalled();
    expect(outerDrop).not.toHaveBeenCalled();
  });
});
