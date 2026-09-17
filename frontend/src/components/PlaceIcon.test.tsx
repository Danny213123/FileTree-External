import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const shell = vi.hoisted(() => ({ loadShellPathIcon: vi.fn(), peekShellPathIcon: vi.fn() }));
vi.mock("../lib/shellImages", () => shell);

import { PlaceIcon } from "./PlaceIcon";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

beforeEach(() => {
  shell.loadShellPathIcon.mockReset();
  shell.peekShellPathIcon.mockReset();
  shell.peekShellPathIcon.mockReturnValue(undefined);
  shell.loadShellPathIcon.mockResolvedValue(null);
});
afterEach(cleanup);

it("shows Windows' own icon for the drive once it arrives", async () => {
  shell.loadShellPathIcon.mockResolvedValue(PNG);
  render(<PlaceIcon path={"D:\\"} fallback="hdd" />);
  await waitFor(() => expect(document.querySelector("img")).toHaveAttribute("src", PNG));
  expect(shell.loadShellPathIcon).toHaveBeenCalledWith("D:\\");
});

it("keeps our own glyph when the shell cannot answer", async () => {
  render(<PlaceIcon path={"D:\\"} fallback="hdd" />);
  await waitFor(() => expect(shell.loadShellPathIcon).toHaveBeenCalled());
  expect(document.querySelector("img")).toBeNull();
  expect(document.querySelector("svg")).not.toBeNull();
});

it("paints a cached icon without waiting", () => {
  shell.peekShellPathIcon.mockReturnValue(PNG);
  render(<PlaceIcon path={"C:\\"} fallback="hdd" />);
  expect(document.querySelector("img")).toHaveAttribute("src", PNG);
});
