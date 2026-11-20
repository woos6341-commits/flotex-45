import { describe, expect, it } from "vitest";
import { getFocusedScrollOffset, getKeyboardOverlap, type KeyboardRect } from "../shared/keyboard-geometry";

const viewport: KeyboardRect = { x: 20, y: 100, width: 350, height: 680 };
const keyboard: KeyboardRect = { x: 0, y: 480, width: 390, height: 300 };
const field = (y: number, height = 54): KeyboardRect => ({ x: 40, y, width: 300, height });
const calculate = (input: KeyboardRect, scrollY = 0, override: Partial<Parameters<typeof getFocusedScrollOffset>[0]> = {}) =>
  getFocusedScrollOffset({ viewport, input, keyboard, scrollY, contentHeight: 1400, ...override });

describe("keyboard viewport overlap", () => {
  it("reserves only actual overlap on unresized iOS, not screen height", () => {
    expect(getKeyboardOverlap(viewport, keyboard)).toBe(300);
    expect(getKeyboardOverlap({ ...viewport, height: 500 }, keyboard)).toBe(120);
  });
  it("does not double-inset an already resized Android viewport", () => {
    expect(getKeyboardOverlap({ ...viewport, height: 380 }, keyboard)).toBe(0);
  });
  it("accounts for a viewport ending above a tab bar or safe area", () => {
    expect(getKeyboardOverlap({ ...viewport, height: 600 }, keyboard)).toBe(220);
  });
  it("adds no inset at rest, for hardware keyboard, or for an offscreen keyboard", () => {
    expect(getKeyboardOverlap(viewport, null)).toBe(0);
    expect(getKeyboardOverlap(viewport, { ...keyboard, height: 0 })).toBe(0);
    expect(getKeyboardOverlap(viewport, { ...keyboard, y: 900 })).toBe(0);
    expect(getKeyboardOverlap(viewport, { ...keyboard, y: -500 })).toBe(0);
  });
  it("does not reserve space for a floating keyboard beside this viewport", () => {
    expect(getKeyboardOverlap({ ...viewport, width: 150 }, { ...keyboard, x: 250, width: 140 })).toBe(0);
  });
});

describe("focused input visibility", () => {
  it("scrolls the entire input above the keyboard with a 12px gap on opening", () => {
    expect(calculate(field(580))).toBe(166);
  });
  it("does not move a field already fully visible", () => {
    expect(calculate(field(250), 120)).toBe(120);
  });
  it("moves further down on focus change while the keyboard stays open", () => {
    const first = calculate(field(580));
    const second = calculate(field(750 - first), first);
    expect(second).toBe(336);
  });
  it("scrolls back up when focus moves to a field clipped above the viewport", () => {
    expect(calculate(field(40), 300)).toBe(228);
  });
  it("accounts for a keyboard frame/height change without accumulating insets", () => {
    expect(calculate(field(430))).toBe(16);
    expect(calculate(field(430), 0, { keyboard: { ...keyboard, y: 400, height: 380 } })).toBe(96);
  });
  it("reveals a bottom-most input once keyboard-only overflow is added", () => {
    expect(calculate(field(720), 0, { contentHeight: 680 + 300 + 12 })).toBe(306);
  });
  it("uses actual Android resized height even though overlap is zero", () => {
    expect(calculate(field(580), 0, { viewport: { ...viewport, height: 380 } })).toBe(166);
  });
  it("does not scroll for a floating keyboard next to the active field", () => {
    expect(calculate({ x: 30, y: 500, width: 120, height: 54 }, 0, { keyboard: { ...keyboard, x: 230, width: 160 } })).toBe(0);
  });
  it("clamps at the top and current content's maximum scroll range", () => {
    expect(calculate(field(10), 0)).toBe(0);
    expect(calculate(field(900), 0, { contentHeight: 780 })).toBe(100);
  });
  it("aligns an oversized multiline field's top when full visibility is impossible", () => {
    expect(calculate(field(260, 500), 0)).toBe(148);
  });
  it("ignores zero measurements and inaccessible keyboard-filled viewports", () => {
    expect(calculate(field(400, 0), 25)).toBe(25);
    expect(calculate(field(400), 25, { viewport: { ...viewport, height: 0 } })).toBe(25);
    expect(calculate(field(400), 25, { keyboard: { ...keyboard, y: 100, height: 680 } })).toBe(25);
  });
  it.each([
    { width: 320, height: 568, keyboardHeight: 216 },
    { width: 360, height: 640, keyboardHeight: 280 },
    { width: 390, height: 844, keyboardHeight: 336 },
    { width: 430, height: 932, keyboardHeight: 370 },
  ])("fully reveals inputs on $width×$height phone geometry", ({ width, height, keyboardHeight }) => {
    const phoneViewport = { x: 20, y: 90, width: width - 40, height: height - 90 };
    const phoneKeyboard = { x: 0, y: height - keyboardHeight, width, height: keyboardHeight };
    const input = { x: 30, y: height - 80, width: width - 60, height: 54 };
    const offset = calculate(input, 0, { viewport: phoneViewport, keyboard: phoneKeyboard, contentHeight: height + keyboardHeight + 12 });
    expect(input.y + input.height - offset).toBeLessThanOrEqual(phoneKeyboard.y - 12);
    expect(input.y - offset).toBeGreaterThanOrEqual(phoneViewport.y + 12);
  });
  it.each([
    { width: 320, height: 568, keyboardHeight: 216 },
    { width: 360, height: 640, keyboardHeight: 280 },
    { width: 390, height: 844, keyboardHeight: 336 },
    { width: 430, height: 932, keyboardHeight: 370 },
  ])("keeps the savings expected-return panel visible above the keyboard on $width×$height", ({ width, height, keyboardHeight }) => {
    const phoneViewport = { x: 20, y: 90, width: width - 40, height: height - 90 };
    const phoneKeyboard = { x: 0, y: height - keyboardHeight, width, height: keyboardHeight };
    const input = { x: 30, y: height - 130, width: width - 60, height: 54 };
    const keyboardGap = 88;
    const scrollOffset = getFocusedScrollOffset({
      viewport: phoneViewport,
      input,
      keyboard: phoneKeyboard,
      scrollY: 0,
      contentHeight: height + keyboardHeight + 100,
      gap: keyboardGap,
    });
    const visibleInputBottom = input.y + input.height - scrollOffset;
    expect(visibleInputBottom).toBeLessThanOrEqual(phoneKeyboard.y - keyboardGap);
    expect(visibleInputBottom + 64).toBeLessThanOrEqual(phoneKeyboard.y);
  });
});
