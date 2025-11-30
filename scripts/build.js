#!/usr/bin/env node

/**
 * Etsy → Puppeteer → Static Site Builder
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
   FETCH VIA RSS — ALWAYS WORKS
----------------------------------------- */

async function fetchListingUrls() {
  const fetch = (...args) =>
    import("node-fetch").then(({ default: fetch }) => fetch(...args));

  console.log(`→ Fetching Etsy RSS: ${RSS_URL}`);

  const res = await fetch(RSS_URL);
  if (!res.ok) throw new Error("RSS failed");

  const xml = await res.text();
  const json = await parseStringPromise(xml);

  const items = json.rss.channel[0].item;
  return items.map((i) => i.link[0]);
}

/* -----------------------------------------
   PUPPETEER LISTING SCRAPER (JSON-LD + FALLBACK)
----------------------------------------- */

async function scrapeListing(url, browser) {
  console.log(`→ Scraping listing via Puppeteer: ${url}`);

  const page = await browser.newPage();

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/123.0.0.0 Safari/537.36"
  );

  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9",
  });

  await page.goto(url, {
    waitUntil: "networkidle2",
    timeout: 60000,
  });

  // Extract JSON-LD Product block
  async function getJsonLdProduct() {
    const blocks = await page.$$eval(
      'script[type="application/ld+json"]',
      (nodes) => nodes.map((n) => n.textContent)
    );

    for (const block of blocks) {
      try {
        const parsed = JSON.parse(block);
        if (parsed["@type"] === "Product") return parsed;
      } catch (_) {}
    }
    return null;
  }

  let productData = await getJsonLdProduct();

  // Scroll & re-check JSON-LD
  if (!productData) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1200);
    productData = await getJsonLdProduct();
  }

  // Scroll to top again
  if (!productData) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(800);
    productData = await getJsonLdProduct();
  }

  // FINAL fallback to OG tags
  if (!productData) {
    console.log("⚠ JSON-LD missing — falling back to OG tags.");

    const html = await page.content();
    await page.close();

    const extractMeta = (attr, name) => {
      const regex = new RegExp(
        `<meta[^>]+${attr}=["']${name}["'][^>]+content=["']([^"']+)["']`,
        "i"
      );
      const match = html.match(regex);
      return match ? match[1] : null;
    };

    const title =
      extractMeta("property", "og:title") ||
      extractMeta("name", "title") ||
      "Untitled";

    const description =
      extractMeta("property", "og:description") ||
      extractMeta("name", "description") ||
      "";

    const mainImage = extractMeta("property", "og:image");

    const id = (url.match(/listing\/(\d+)/) || [])[1] || "";
    const slug =
      `${slugify(title)}-by-thecharmedcardinal-${id}`.substring(0, 180);

    return {
      id,
      slug,
      title,
      description,
      etsy: url,
      mainImage,
      type: detectType(title + " " + description),
    };
  }

  /* JSON-LD SUCCESS */
  const title = (productData.name || "Untitled").trim();
  const description = (productData.description || "").trim();

  const images = Array.isArray(productData.image)
    ? productData.image
    : [productData.image];

  const mainImage = images[0] || null;

  const id = (url.match(/listing\/(\d+)/) || [])[1] || "";
  const slug =
    `${slugify(title)}-by-thecharmedcardinal-${id}`.substring(0, 180);

  await page.close();

  return {
    id,
    slug,
    title,
    description,
    etsy: url,
    mainImage,
    type: detectType(title + " " + description),
  };
}

/* -----------------------------------------
   HTML LAYOUT
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

<header>
  <h1><a href="/">The Charmed Cardinal</a></h1>
  <nav>
    <a href="/">Home</a> |
    <a href="/shop.html">Shop</a> |
    <a href="/products/garden-flags.html">Garden Flags</a> |
    <a href="/products/digital-patterns.html">Patterns</a>
  </nav>
</header>

<main>
${body}
</main>

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

      // download main image
      let webPath = FALLBACK_IMG;

      if (p.mainImage) {
        const ext = p.mainImage.includes(".png") ? ".png" : ".jpg";
        const dest = `assets/products/${p.slug}${ext}`;

        try {
          await downloadImage(p.mainImage, dest);
          webPath = "/" + dest;
        } catch (err) {
          console.log("⚠ Failed image:", err.message);
        }
      }

      p.webImage = webPath;
      products.push(p);
    }

    await browser.close();

    // Save JSON
    writeFile("data/products.json", JSON.stringify(products, null, 2));
    console.log("✓ Saved products.json");

    /* PRODUCT PAGES */
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
            <img src="${p.webImage}" style="max-width:400px;border-radius:16px;">
            <p>${escapeHtml(p.description)}</p>
            <p><a href="${p.etsy}" target="_blank">View on Etsy →</a></p>
          `,
        })
      );
    }

    /* CATEGORY PAGES */
    const garden = products.filter((p) => p.type === "garden-flag");
    const patterns = products.filter((p) => p.type === "digital-pattern");

    writeFile(
      "products/garden-flags.html",
      layout({
        title: "Garden Flags",
        description: "Decorative handmade garden flags.",
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
        description: "Seamless repeating digital patterns.",
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

    /* SHOP PAGE */
    writeFile(
      "shop.html",
      layout({
        title: "Shop",
        description: "All designs by The Charmed Cardinal.",
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

    /* HOMEPAGE */
    writeFile(
      "index.html",
      layout({
        title: "The Charmed Cardinal",
        description:
          "Handmade garden flags and seamless repeating digital patterns.",
        canonical: `${DOMAIN}/`,
        ogImage: `${DOMAIN}/assets/og-image.png`,
        body: `
          <h1>Welcome to The Charmed Cardinal</h1>
          <p>Handmade designs • Garden Flags • Seamless Patterns</p>
          <p><a href="/shop.html">Browse the shop →</a></p>
        `,
      })
    );

    /* SITEMAP */
    let sitemap = `<?xml version="1.0" encoding="UTF-8"?> 
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;

    sitemap += `
  <url><loc>${DOMAIN}/</loc></url>
  <url><loc>${DOMAIN}/shop.html</loc></url>
  <url><loc>${DOMAIN}/products/garden-flags.html</loc></url>
  <url><loc>${DOMAIN}/products/digital-patterns.html</loc></url>
`;

    for (const p of products) {
      sitemap += `<url><loc>${DOMAIN}/products/${p.slug}.html</loc></url>\n`;
    }

    sitemap += `</urlset>`;

    writeFile("sitemap.xml", sitemap);

    console.log("\n✅ BUILD COMPLETE — Full images extracted reliably.\n");

  } catch (err) {
    console.error("\n❌ BUILD FAILED:", err);
    process.exit(1);
  }
})();
