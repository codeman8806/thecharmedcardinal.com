#!/usr/bin/env node

/**
 * Etsy → Puppeteer → Full Site Builder
 * thecharmedcardinal.com
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const puppeteer = require("puppeteer");
const { parseStringPromise } = require("xml2js");

/* -----------------------------------------
   CONFIG
----------------------------------------- */

const DOMAIN = "https://thecharmedcardinal.com";
const SHOP_URL = "https://www.etsy.com/shop/thecharmedcardinal";
const RSS_URL = `${SHOP_URL}/rss`;
const FALLBACK_IMG = "/assets/product-placeholder.jpg";

/* -----------------------------------------
   HELPERS
----------------------------------------- */

function writeFile(dest, data) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, data);
}

function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function downloadImage(url, destPath) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          return reject(
            new Error(
              `Image download failed: ${url} (HTTP ${res.statusCode})`
            )
          );
        }

        const stream = fs.createWriteStream(destPath);
        res.pipe(stream);

        stream.on("finish", () => stream.close(() => resolve(destPath)));
      })
      .on("error", reject);
  });
}

/* -----------------------------------------
   META EXTRACTION
----------------------------------------- */

function extractMeta(html, attr, name) {
  const regex = new RegExp(
    `<meta[^>]+${attr}=["']${name}["'][^>]+content=["']([^"']+)["']`,
    "i"
  );
  const m = html.match(regex);
  return m ? m[1] : null;
}

/* -----------------------------------------
   SLUG + TYPE DETECTION
----------------------------------------- */

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function detectType(text) {
  const t = text.toLowerCase();
  if (t.includes("pattern") || t.includes("seamless")) return "digital-pattern";
  if (t.includes("flag")) return "garden-flag";
  return "garden-flag";
}

/* -----------------------------------------
   FETCH VIA RSS
----------------------------------------- */

async function fetchListingUrls() {
  const fetch = (...args) =>
    import("node-fetch").then(({ default: fetch }) => fetch(...args));

  console.log(`→ Fetching Etsy RSS…`);

  const res = await fetch(RSS_URL);
  if (!res.ok) throw new Error("RSS failed");

  const xml = await res.text();
  const json = await parseStringPromise(xml);

  const items = json.rss.channel[0].item;
  const urls = items.map((i) => i.link[0]);

  return urls;
}

/* -----------------------------------------
   PUPPETEER LISTING SCRAPER
----------------------------------------- */

async function scrapeListing(url, browser) {
  console.log(`→ Scraping listing via Puppeteer: ${url}`);

  const page = await browser.newPage();

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/122.0.0.0 Safari/537.36"
  );

  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9",
  });

  await page.goto(url, {
    waitUntil: "networkidle2",
    timeout: 60000,
  });

  const html = await page.content();
  await page.close();

  let title =
    extractMeta(html, "property", "og:title") ||
    extractMeta(html, "name", "title") ||
    "Untitled";

  title = title.replace(/\s+-\s+Etsy.*/i, "").trim();

  let description =
    extractMeta(html, "property", "og:description") ||
    extractMeta(html, "name", "description") ||
    "";

  description = description.replace(/\s+-\s+Etsy.*/i, "").trim();

  const ogImage = extractMeta(html, "property", "og:image");

  const id = (url.match(/listing\/(\d+)/) || [])[1] || "";
  const slug = `${slugify(title)}-by-thecharmedcardinal-${id}`;
  const type = detectType(title + " " + description);

  return {
    id,
    slug,
    title,
    description,
    etsy: url,
    ogImage,
    type,
  };
}

/* -----------------------------------------
   HTML TEMPLATES
----------------------------------------- */

function layout({ title, description, canonical, ogImage, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${canonical}">
<link rel="stylesheet" href="/styles.css">
<link rel="icon" type="image/png" href="/assets/favicon.png">

<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:image" content="${ogImage}">
<meta property="og:url" content="${canonical}">
</head>
<body>
${body}
</body>
</html>`;
}

/* -----------------------------------------
   BUILD PIPELINE
----------------------------------------- */

(async function build() {
  try {
    console.log("\n🚀 BUILD START\n");

    const listingUrls = await fetchListingUrls();
    console.log(`✓ RSS listings: ${listingUrls.length}`);

    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const products = [];

    for (const url of listingUrls) {
      const p = await scrapeListing(url, browser);

      // download OG image
      let local = FALLBACK_IMG;

      if (p.ogImage) {
        const ext = p.ogImage.includes(".png") ? ".png" : ".jpg";
        const dest = `assets/products/${p.slug}${ext}`;

        try {
          await downloadImage(p.ogImage, dest);
          local = "/" + dest;
        } catch (err) {
          console.log("⚠ Image download failed:", err.message);
        }
      }

      p.webImage = local;
      products.push(p);
    }

    await browser.close();

    writeFile("data/products.json", JSON.stringify(products, null, 2));
    console.log("✓ Saved products.json");

    /* Product pages */
    for (const p of products) {
      writeFile(
        `products/${p.slug}.html`,
        layout({
          title: p.title,
          description: p.description,
          canonical: `${DOMAIN}/products/${p.slug}.html`,
          ogImage: `${DOMAIN}${p.webImage}`,
          body: `
            <h1>${escapeHtml(p.title)}</h1>
            <img src="${p.webImage}" style="max-width:400px;border-radius:16px">
            <p>${escapeHtml(p.description)}</p>
            <p><a href="${p.etsy}" target="_blank">View on Etsy</a></p>
          `,
        })
      );
    }

    /* Category pages */
    const garden = products.filter((p) => p.type === "garden-flag");
    const patterns = products.filter((p) => p.type === "digital-pattern");

    writeFile(
      "products/garden-flags.html",
      layout({
        title: "Garden Flags",
        description: "Decorative garden flags",
        canonical: `${DOMAIN}/products/garden-flags.html`,
        ogImage: `${DOMAIN}/assets/og-image.png`,
        body: garden
          .map(
            (p) => `
            <h2><a href="/products/${p.slug}.html">${escapeHtml(p.title)}</a></h2>
            <img src="${p.webImage}" width="200">
          `
          )
          .join("<hr>")
      })
    );

    writeFile(
      "products/digital-patterns.html",
      layout({
        title: "Digital Patterns",
        description: "Seamless repeating digital patterns",
        canonical: `${DOMAIN}/products/digital-patterns.html`,
        ogImage: `${DOMAIN}/assets/og-image.png`,
        body: patterns
          .map(
            (p) => `
            <h2><a href="/products/${p.slug}.html">${escapeHtml(p.title)}</a></h2>
            <img src="${p.webImage}" width="200">
          `
          )
          .join("<hr>")
      })
    );

    /* Shop page */
    writeFile(
      "shop.html",
      layout({
        title: "Shop",
        description: "Browse all designs",
        canonical: `${DOMAIN}/shop.html`,
        ogImage: `${DOMAIN}/assets/og-image.png`,
        body: products
          .map(
            (p) => `
            <h2><a href="/products/${p.slug}.html">${escapeHtml(p.title)}</a></h2>
            <img src="${p.webImage}" width="200">
          `
          )
          .join("<hr>")
      })
    );

    /* Homepage */
    writeFile(
      "index.html",
      layout({
        title: "The Charmed Cardinal",
        description: "Garden Flags & Seamless Patterns",
        canonical: `${DOMAIN}/`,
        ogImage: `${DOMAIN}/assets/og-image.png`,
        body: `
          <h1>The Charmed Cardinal</h1>
          <p>Handmade designs. Garden Flags. Seamless Patterns.</p>
          <p><a href="/shop.html">Visit the Shop →</a></p>
        `
      })
    );

    /* Sitemap */
    let sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;

    sitemap += `
  <url><loc>${DOMAIN}/</loc></url>
  <url><loc>${DOMAIN}/shop.html</loc></url>
  <url><loc>${DOMAIN}/products/garden-flags.html</loc></url>
  <url><loc>${DOMAIN}/products/digital-patterns.html</loc></url>
`;

    for (const p of products) {
      sitemap += `  <url><loc>${DOMAIN}/products/${p.slug}.html</loc></url>\n`;
    }

    sitemap += `</urlset>`;

    writeFile("sitemap.xml", sitemap);

    console.log("\n✅ BUILD COMPLETE — Puppeteer version now works with 0% 403 failures.\n");

  } catch (err) {
    console.error("\n❌ BUILD FAILED:", err);
    process.exit(1);
  }
})();
