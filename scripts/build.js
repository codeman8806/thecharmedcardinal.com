#!/usr/bin/env node

/**
 * FULL AUTO-GENERATOR FOR: thecharmedcardinal.com
 *
 * - Pulls Etsy listings via RSS because HTML shop page is blocked
 * - For each listing:
 *      → fetches the HTML page with browser headers (avoids Etsy 403)
 *      → extracts og:title / og:description / og:image
 *      → downloads the image locally to /assets/products/
 * - Generates:
 *      → /products/*.html
 *      → /products/garden-flags.html
 *      → /products/digital-patterns.html
 *      → /shop.html
 *      → /index.html
 *      → /sitemap.xml
 */

const fs = require("fs");
const path = require("path");
const { parseStringPromise } = require("xml2js");

/* -----------------------------------------
   CONFIG
----------------------------------------- */

const DOMAIN = "https://thecharmedcardinal.com";
const SHOP_URL = "https://www.etsy.com/shop/thecharmedcardinal";
const RSS_URL = `${SHOP_URL}/rss`;
const FALLBACK_IMG = "/assets/product-placeholder.jpg";

/* -----------------------------------------
   UTILITIES
----------------------------------------- */

function writeFile(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
}

function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/* -----------------------------------------
   FETCH HTML WITH SPOOFED HEADERS
----------------------------------------- */

async function fetchHtml(url) {
  const fetch = (...args) =>
    import("node-fetch").then(({ default: fetch }) => fetch(...args));

  const res = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
      "Upgrade-Insecure-Requests": "1",
    },
  });

  if (!res.ok) {
    throw new Error(`Failed HTML fetch: ${url} (HTTP ${res.status})`);
  }

  return res.text();
}

/* -----------------------------------------
   IMAGE DOWNLOAD
----------------------------------------- */

const https = require("https");

function downloadImage(url, destPath) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          return reject(
            new Error(`Image download failed ${url} → HTTP ${res.statusCode}`)
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
   PARSE META TAGS
----------------------------------------- */

function extractMeta(html, property, value) {
  const re = new RegExp(
    `<meta[^>]+${property}=["']${value}["'][^>]+content=["']([^"']+)["']`,
    "i"
  );
  const m = html.match(re);
  return m ? m[1] : null;
}

/* -----------------------------------------
   CREATE SLUG
----------------------------------------- */

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/* -----------------------------------------
   TYPE INFERENCE
----------------------------------------- */

function detectType(text) {
  const t = text.toLowerCase();
  if (t.includes("pattern") || t.includes("seamless")) return "digital-pattern";
  if (t.includes("flag")) return "garden-flag";
  return "garden-flag";
}

/* -----------------------------------------
   SCRAPE SINGLE LISTING
----------------------------------------- */

async function scrapeListing(url) {
  console.log(`→ Scraping listing: ${url}`);

  const html = await fetchHtml(url);

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

  return { id, slug, title, description, etsy: url, ogImage, type };
}

/* -----------------------------------------
   FETCH LISTINGS FROM RSS
----------------------------------------- */

async function fetchListingUrls() {
  const fetch = (...args) =>
    import("node-fetch").then(({ default: fetch }) => fetch(...args));

  console.log(`→ Fetching Etsy RSS: ${RSS_URL}`);

  const res = await fetch(RSS_URL);
  if (!res.ok) throw new Error("RSS feed failed");

  const xml = await res.text();
  const json = await parseStringPromise(xml);

  const items = json.rss.channel[0].item || [];
  const urls = items.map((i) => i.link[0]);

  return urls;
}

/* -----------------------------------------
   RENDER HTML TEMPLATES
----------------------------------------- */

function layout({ title, description, canonical, body, ogImage }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="canonical" href="${canonical}" />

<link rel="stylesheet" href="/styles.css" />
<link rel="icon" type="image/png" href="/assets/favicon.png" />

<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:image" content="${ogImage}" />
<meta property="og:url" content="${canonical}" />

</head>
<body>
${body}
</body>
</html>`;
}

/* -----------------------------------------
   BUILD START
----------------------------------------- */

(async function build() {
  try {
    console.log("\n🚀 BUILD START\n");

    /* 1. Fetch RSS listing URLs */
    const listingUrls = await fetchListingUrls();
    console.log(`✓ RSS listings found: ${listingUrls.length}`);

    const products = [];

    /* 2. Scrape individual listings */
    for (const url of listingUrls) {
      const p = await scrapeListing(url);

      /* 3. Download image */
      let webImg = FALLBACK_IMG;

      if (p.ogImage) {
        const ext = p.ogImage.includes(".png") ? ".png" : ".jpg";
        const imgPath = path.join(
          "assets/products",
          `${p.slug}${ext}`
        );

        try {
          await downloadImage(p.ogImage, imgPath);
          webImg = `/${imgPath}`;
        } catch (err) {
          console.log("⚠ Image failed, using fallback");
        }
      }

      p.webImage = webImg;
      products.push(p);
    }

    /* 4. Save products.json */
    writeFile(
      "data/products.json",
      JSON.stringify(products, null, 2)
    );
    console.log("✓ Saved products → data/products.json");

    /* 5. Generate product pages */
    for (const p of products) {
      const html = layout({
        title: p.title,
        description: p.description,
        canonical: `${DOMAIN}/products/${p.slug}.html`,
        ogImage: `${DOMAIN}${p.webImage}`,
        body: `
        <h1>${escapeHtml(p.title)}</h1>
        <img src="${p.webImage}" style="max-width:400px;border-radius:16px" />
        <p>${escapeHtml(p.description)}</p>
        <p><a href="${p.etsy}" target="_blank">View on Etsy</a></p>
        `
      });

      writeFile(`products/${p.slug}.html`, html);
      console.log("✓ Product page:", p.slug);
    }

    /* 6. Category pages */
    const garden = products.filter((p) => p.type === "garden-flag");
    const patterns = products.filter((p) => p.type === "digital-pattern");

    writeFile(
      "products/garden-flags.html",
      layout({
        title: "Garden Flags",
        description: "Explore decorative garden flags.",
        canonical: `${DOMAIN}/products/garden-flags.html`,
        ogImage: `${DOMAIN}/assets/og-image.png`,
        body: garden
          .map(
            (p) => `
        <h2><a href="/products/${p.slug}.html">${escapeHtml(p.title)}</a></h2>
        <img src="${p.webImage}" width="200" />
      `
          )
          .join("<hr/>"),
      })
    );

    writeFile(
      "products/digital-patterns.html",
      layout({
        title: "Digital Patterns",
        description: "Seamless repeating patterns.",
        canonical: `${DOMAIN}/products/digital-patterns.html`,
        ogImage: `${DOMAIN}/assets/og-image.png`,
        body: patterns
          .map(
            (p) => `
        <h2><a href="/products/${p.slug}.html">${escapeHtml(p.title)}</a></h2>
        <img src="${p.webImage}" width="200" />
      `
          )
          .join("<hr/>"),
      })
    );

    console.log("✓ Category pages generated");

    /* 7. Shop page */
    writeFile(
      "shop.html",
      layout({
        title: "Shop",
        description: "Browse all designs.",
        canonical: `${DOMAIN}/shop.html`,
        ogImage: `${DOMAIN}/assets/og-image.png`,
        body: products
          .map(
            (p) => `
        <h2><a href="/products/${p.slug}.html">${escapeHtml(p.title)}</a></h2>
        <img src="${p.webImage}" width="200" />
      `
          )
          .join("<hr/>"),
      })
    );

    console.log("✓ shop.html created");

    /* 8. Homepage */
    writeFile(
      "index.html",
      layout({
        title: "The Charmed Cardinal",
        description: "Garden flags & patterns",
        canonical: `${DOMAIN}/`,
        ogImage: `${DOMAIN}/assets/og-image.png`,
        body: `
        <h1>Welcome to The Charmed Cardinal</h1>
        <p>Handmade designs, garden flags, seamless patterns.</p>
        <a href="/shop.html">Go to Shop →</a>
        `,
      })
    );

    console.log("✓ Homepage: index.html");

    /* 9. Sitemap */
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

    console.log("✓ sitemap.xml built\n");
    console.log("✅ BUILD COMPLETE — full site generated.\n");

  } catch (err) {
    console.error("\n❌ BUILD FAILED:", err);
    process.exit(1);
  }
})();
