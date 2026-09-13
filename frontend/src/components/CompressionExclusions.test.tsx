import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CompressionExclusions } from "./CompressionExclusions";
import { isCompressionExcluded, loadCompressionExclusions } from "../lib/compressionExclusions";
afterEach(() => { cleanup(); localStorage.clear(); });
it("saves a folder exclusion without excluding similarly named siblings", () => {
  const onChange = vi.fn();
  render(<CompressionExclusions paths={[]} selectedPaths={[]} disabled={false} onChange={onChange} />);
  fireEvent.change(screen.getByLabelText("Folder or file to exclude"), { target: { value: "G:\\A" } });
  fireEvent.click(screen.getByText("Exclude path"));
  const paths = loadCompressionExclusions();
  expect(paths).toEqual(["G:\\A"]);
  expect(isCompressionExcluded("g:/a/AB/deep/file.mp4", paths)).toBe(true);
  expect(isCompressionExcluded("G:/AB/file.mp4", paths)).toBe(false);
  expect(onChange).toHaveBeenCalledWith(paths);
});
it("can tag selected files and remove a saved exclusion", () => {
  const onChange = vi.fn();
  const { rerender } = render(<CompressionExclusions paths={[]} selectedPaths={["G:/a.txt"]} disabled={false} onChange={onChange} />);
  fireEvent.click(screen.getByText("Exclude selected files"));
  expect(loadCompressionExclusions()).toEqual(["G:/a.txt"]);
  rerender(<CompressionExclusions paths={["G:/a.txt"]} selectedPaths={[]} disabled={false} onChange={onChange} />);
  fireEvent.click(screen.getByLabelText("Remove exclusion G:/a.txt"));
  expect(loadCompressionExclusions()).toEqual([]);
});
