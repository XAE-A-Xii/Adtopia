import { describe, expect, it } from "vitest";
import { captureSiteVisuals, pickPages } from "@/lib/creative/capture";
import { ApiError } from "@/lib/http";

const HOME_LINKS = [
  { href: "/", text: "Monid" },
  { href: "/pricing", text: "Pricing" },
  { href: "https://monid.ai/features", text: "Features" },
  { href: "https://docs.monid.ai/", text: "Docs" },
  { href: "https://docs.monid.ai/reference/tools/search", text: "Search tool" },
  { href: "/blog/how-agents-pay", text: "How agents pay" },
  { href: "/login", text: "Log in" },
  { href: "https://app.monid.ai/signup", text: "Sign up" },
  { href: "/privacy-policy", text: "Privacy" },
  { href: "/terms", text: "Terms" },
  { href: "https://twitter.com/monid", text: "Twitter" },
  { href: "/about", text: "About" },
  { href: "/customers", text: "Customers" },
  { href: "mailto:hi@monid.ai", text: "Email" },
];

describe("pickPages", () => {
  it("picks pricing, product, docs and proof pages, one each, skipping login, legal, blog posts and other sites", () => {
    expect(pickPages(HOME_LINKS, "monid.ai")).toEqual(["https://monid.ai/pricing", "https://monid.ai/features", "https://docs.monid.ai/", "https://monid.ai/customers"]);
  });

  it("respects the page limit and prefers a section's front page", () => {
    const links = [
      { href: "https://shop.example.com/products/vintage-cola-12-pack", text: "Vintage Cola" },
      { href: "/collections/all", text: "Shop all" },
      { href: "/pages/how-it-works", text: "How it works" },
      { href: "/docs/getting-started/install/linux", text: "Install" },
    ];
    expect(pickPages(links, "https://www.example.com/", 2)).toEqual(["https://example.com/pages/how-it-works", "https://shop.example.com/products/vintage-cola-12-pack"]);
  });

  it("finds nothing worth showing on a page of off-site and legal links", () => {
    expect(pickPages([{ href: "https://instagram.com/x", text: "IG" }, { href: "/terms-of-service", text: "Terms" }], "monid.ai")).toEqual([]);
  });
});

describe("captureSiteVisuals", () => {
  it("throws not_configured directing callers to local Chrome capture", async () => {
    const error = await captureSiteVisuals({ domain: "monid.ai", dir: "/tmp/unused" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("not_configured");
    expect((error as Error).message).toMatch(/local Chrome/i);
  });
});
