// 0.5.0 item 31 (RAI-233): the page-id rule's slug (record 25 §3), worked examples from the record.
import { describe, expect, test } from "bun:test";
import { itemPaths, slug } from "./page-id.ts";

describe("slug — the page-id rule's ASCII slug (record 25 §3)", () => {
  test("lowercase ASCII, apostrophes dropped, every other run becomes one dash", () => {
    expect(slug("Don't Look Up")).toBe("dont-look-up");
    expect(slug("  Rock & Roll!  ")).toBe("rock-and-roll");
  });

  test("Cyrillic is transliterated by the fixed table, other accents stripped by NFKD", () => {
    expect(slug("Мастер и Маргарита")).toBe("master-i-margarita");
    expect(slug("Щука")).toBe("shchuka");
    expect(slug("Amélie")).toBe("amelie");
    expect(slug("Łódź")).toBe("lodz");
  });

  test("a name with no letter or digit gets x + 10 hex of its sha256", () => {
    const s = slug("🎵🎶");
    expect(s).toMatch(/^x[0-9a-f]{10}$/);
    expect(slug("🎵🎶")).toBe(s);
    expect(slug("🎶🎵")).not.toBe(s);
  });

  test("capped at 80: a longer slug keeps 72 characters, a dash and 7 hex", () => {
    expect(slug("a".repeat(80))).toBe("a".repeat(80));
    expect(slug("a".repeat(81))).toMatch(/^a{72}-[0-9a-f]{7}$/);
    expect(slug("a".repeat(81))).not.toBe(slug("a".repeat(82)));
    expect(slug("b".repeat(61), 60)).toMatch(/^b{52}-[0-9a-f]{7}$/);
  });
});

describe("itemPaths — the page-id rule's paths for an item (record 25 §3)", () => {
  test("the domain, the first Latin title's slug, --<creator|year>, then the --<type> collision variant", () => {
    expect(itemPaths({ title: "Thief", type: "Film" }, "movies")).toEqual(["items/movies/thief.md", "items/movies/thief--film.md"]);
    expect(itemPaths({ title: "Сталкер", title_ru: "Stalker", creator: "Andrei Tarkovsky", type: "Film" }, "movies"))
      .toEqual(["items/movies/stalker--andrei-tarkovsky.md", "items/movies/stalker--andrei-tarkovsky--film.md"]);
    expect(itemPaths({ title: "Heat", year: 1995 }, "movies")).toEqual(["items/movies/heat--1995.md"]);
  });

  test("a reserved base (index, log) takes -item", () => {
    expect(itemPaths({ title: "Log", type: "Book" }, "books")).toEqual(["items/books/log-item.md", "items/books/log--book.md"]);
    expect(itemPaths({ title: "Index" }, "books")).toEqual(["items/books/index-item.md"]);
  });

  test("no title: no path", () => {
    expect(itemPaths({ type: "Book" }, "books")).toEqual([]);
  });
});
