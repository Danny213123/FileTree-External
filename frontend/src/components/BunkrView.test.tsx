import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const downloadText = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../lib/exportRows", () => ({ downloadText }));

import { BunkrView, listName, urlList } from "./BunkrView";
import type { PluginDef } from "../lib/plugins";

const page = {
  albums: [
    { title: "First album", url: "https://bunkr.cr/a/one", files: 10, thumbnail: null },
    { title: "Second album", url: "https://bunkr.cr/a/two", files: 1, thumbnail: null },
  ],
  page: 1,
  pages: 2,
  url: "https://balbums.st/?search=test",
};

function show() {
  render(<BunkrView plugin={{} as PluginDef} />);
  fireEvent.change(screen.getByLabelText("Search albums"), { target: { value: "test" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
}

beforeEach(() => {
  localStorage.clear();
  invoke.mockReset();
  downloadText.mockReset();
  invoke.mockResolvedValue(page);
});
afterEach(cleanup);

describe("urlList", () => {
  it("uses every album when nothing is ticked", () => {
    expect(urlList(page.albums, new Set())).toBe("https://bunkr.cr/a/one\nhttps://bunkr.cr/a/two\n");
  });

  it("keeps only the ticked albums", () => {
    expect(urlList(page.albums, new Set(["https://bunkr.cr/a/two"]))).toBe("https://bunkr.cr/a/two\n");
  });
});

describe("listName", () => {
  it("slugs the query", () => {
    expect(listName(" Two Words! ")).toBe("bunkr-two-words.txt");
    expect(listName("   ")).toBe("bunkr-search.txt");
  });
});

describe("BunkrView", () => {
  it("searches with the chosen options and lists what comes back", async () => {
    show();
    await waitFor(() => expect(screen.getByText("First album")).toBeInTheDocument());
    expect(invoke).toHaveBeenCalledWith("bunkr_search", { query: "test", mode: "broad", per: 20, sort: "latest", page: 1 });
    expect(screen.getByText("10 files")).toBeInTheDocument();
    expect(screen.getByText("1 file")).toBeInTheDocument();
  });

  it("pages forward through the results", async () => {
    show();
    await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith("bunkr_search", expect.objectContaining({ page: 2 })));
  });

  it("saves the ticked albums as a URL list", async () => {
    show();
    await waitFor(() => expect(screen.getByLabelText("Second album")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("Second album"));
    fireEvent.click(screen.getByRole("button", { name: "Save .txt" }));
    expect(downloadText).toHaveBeenCalledWith("bunkr-test.txt", "https://bunkr.cr/a/two\n", "text/plain;charset=utf-8");
  });

  it("hands the list to Cyberdrop once an installation is known", async () => {
    localStorage.setItem("filetree.cyberdrop.repo", "C:\\Tools\\CyberDropDownloader");
    show();
    await waitFor(() => expect(screen.getByRole("button", { name: "Send to Cyberdrop" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Send to Cyberdrop" }));
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith("cyberdrop_workspace", {
      repo: "C:\\Tools\\CyberDropDownloader",
      request: { action: "create", text: "https://bunkr.cr/a/one\nhttps://bunkr.cr/a/two\n", label: "bunkr-test.txt" },
    }));
  });

  it("cannot send to Cyberdrop before it is connected", async () => {
    show();
    await waitFor(() => expect(screen.getByText("First album")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Send to Cyberdrop" })).toBeDisabled();
  });

  it("reports a failed search instead of an empty list", async () => {
    invoke.mockRejectedValueOnce("the album index answered 503");
    show();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("503"));
  });
});
