/**
 * build.js — Full Site Generator for The Charmed Cardinal
 * Generates:
 *  - products.json (already created)
 *  - product pages
 *  - shop.html
 *  - category pages
 *  - homepage with featured products
 *  - sitemap.xml
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const Parser = require("rss-parser");
const parser = new Parser();

// OUTPUT PATHS
const DATA_DIR = "data";
const PRODUCTS_JSON = path.join(DATA_DIR, "products.json");
const ASSETS_DIR = "assets/products";

// Ensure directories
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync("assets")) fs.mkdirSync("assets");
if (!fs.existsSync(ASSETS_DIR)) fs.mkdirSync(ASSETS_DIR);

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ------------------------------
// Download image helper
// ------------------------------
function downloadImage(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(url, (response) => {
        if (response.statusCode !== 200) {
          return reject(`Image download failed ${url} (status ${response.statusCode})`);
        }
        response.pipe(file);
        file.on("finish", () => resolve());
      })
      .on("error", reject);
  });
}

// ------------------------------
// Product Card Component
// ------------------------------
function productCard(p) {
  return `
  <article class="card">
    <a href="/products/${p.slug}.html" class="thumb">
        <img src="/assets/products/${p.slug}.jpg" alt="${escapeHtml(p.shortTitle)}" loading="lazy">
    </a>

    <h3 class="card-title">
      <a href="/products/${p.slug}.html">${escapeHtml(p.shortTitle)}</a>
    </h3>

    <p class="card-price">${p.price}</p>

    <p class="card-desc">${escapeHtml(p.description.slice(0, 120))}...</p>

    <a class="card-link" href="/products/${p.slug}.html">View details →</a>
  </article>
  `;
}

// ------------------------------
// PAGE WRAPPER LAYOUT
// ------------------------------
function layoutPage(title, body) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/styles.css">
</head>
<body>

<header class="site-header">
  <h1><a href="/">The Charmed Cardinal</a></h1>
  <nav>
    <a href="/shop.html">Shop</a>
    <a href="/about.html">About</a>
    <a href="/blog/">Blog</a>
    <a href="/contact.html">Contact</a>
  </nav>
</header>

<main>${body}</main>

<footer>&copy; 2025 The Charmed Cardinal</footer>

</body>
</html>
`;
}

// ------------------------------
// INDIVIDUAL PRODUCT PAGE
// ------------------------------
function generateProductPage(p) {
  const html = layoutPage(
    p.title,
    `
    <div class="product-page">
      <div class="product-image">
        <img src="/assets/products/${p.slug}.jpg" alt="${escapeHtml(p.title)}">
      </div>

      <div class="product-info">
        <h2>${escapeHtml(p.title)}</h2>

        <p class="price">${p.price}</p>

        <p>${escapeHtml(p.description)}</p>

        <p><strong>Category:</strong> ${p.category}</p>

        <a href="${p.url}" class="etsy-btn" target="_blank">View on Etsy →</a>
        <p><a href="/shop.html">← Back to shop</a></p>
      </div>
    </div>
    `
  );

  const filePath = `products/${p.slug}.html`;
  fs.writeFileSync(filePath, html);
  console.log("✓ Product page:", filePath);
}

// ------------------------------
// SHOP PAGE
// ------------------------------
function generateShopPage(products) {
  const flags = products.filter((p) => p.category === "Garden Flag");
  const patterns = products.filter((p) => p.category === "Digital Pattern");

  const html = layoutPage(
    "Shop The Charmed Cardinal",
    `
    <h2>Shop The Charmed Cardinal</h2>
    <p>Browse nature-inspired garden flags and digital print patterns.</p>

    <h3>Garden Flags</h3>
    <div class="card-grid">
      ${flags.map(productCard).join("")}
    </div>

    <h3>Digital Patterns</h3>
    <div class="card-grid">
      ${patterns.map(productCard).join("")}
    </div>
    `
  );

  fs.writeFileSync("shop.html", html);
  console.log("✓ Shop page");
}

// ------------------------------
// CATEGORY PAGE
// ------------------------------
function generateCategoryPage(products, categoryName, fileName) {
  const html = layoutPage(
    categoryName,
    `
    <h2>${escapeHtml(categoryName)}</h2>

    <div class="card-grid">
      ${products.map(productCard).join("")}
    </div>
    `
  );

  fs.writeFileSync(`products/${fileName}`, html);
  console.log("✓ Category page:", fileName);
}

// ------------------------------
// HOMEPAGE
// ------------------------------
function generateHomePage(products) {
  const featured = products.slice(0, 6);

  const html = layoutPage(
    "The Charmed Cardinal",
    `
    <h2>Welcome to The Charmed Cardinal</h2>
    <p>Explore handcrafted garden flags and digital art patterns.</p>

    <h3>Featured Products</h3>
    <div class="card-grid">
      ${featured.map(productCard).join("")}
    </div>

    <p style="margin-top:20px;"><a href="/shop.html">View all →</a></p>
    `
  );

  fs.writeFileSync("index.html", html);
  console.log("✓ Homepage");
}

// ------------------------------
// SITEMAP
// ------------------------------
function generateSitemap(products) {
  const urls = [
    "https://thecharmedcardinal.com/",
    "https://thecharmedcardinal.com/shop.html",
    "https://thecharmedcardinal.com/products/garden-flags.html",
    "https://thecharmedcardinal.com/products/digital-patterns.html",
    ...products.map((p) => `https://thecharmedcardinal.com/products/${p.slug}.html`),
  ];

  const xml = `
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `<url><loc>${u}</loc></url>`).join("")}
</urlset>`;

  fs.writeFileSync("sitemap.xml", xml);
  console.log("✓ Sitemap");
}

// ------------------------------
// MAIN BUILD — uses Etsy RSS only
// ------------------------------
async function build() {
  console.log("\n🚀 BUILD START\n");

  console.log("→ Fetching Etsy RSS...");
  const feed = await parser.parseURL("https://www.etsy.com/shop/thecharmedcardinal/rss");

  const products = feed.items.map((item) => {
    const slug = item.link
      .replace("https://www.etsy.com/listing/", "")
      .replace(/\?.*/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-");

    return {
      title: item.title,
      shortTitle: item.title.replace(/ by TheCharmedCardinal/i, ""),
      description: item.contentSnippet || "",
      price: item.title.match(/\$?[0-9]+\.[0-9]{2}/)?.[0] || "",
      category: item.title.includes("Flag") ? "Garden Flag" : "Digital Pattern",
      url: item.link,
      slug,
      image: item.enclosure?.url || null,
    };
  });

  console.log(`✓ Parsed products from RSS: ${products.length}`);

  // Download images
  for (const p of products) {
    if (p.image) {
      const dest = `${ASSETS_DIR}/${p.slug}.jpg`;
      if (!fs.existsSync(dest)) {
        console.log(`→ Downloading image for "${p.shortTitle}"`);
        try {
          await downloadImage(p.image, dest);
        } catch (e) {
          console.log("❌ Image download failed:", e);
        }
      }
    }
  }

  // Save JSON
  fs.writeFileSync(PRODUCTS_JSON, JSON.stringify(products, null, 2));
  console.log("✓ Saved products.json");

  // Generate pages
  products.forEach(generateProductPage);

  generateCategoryPage(
    products.filter((p) => p.category === "Garden Flag"),
    "Garden Flags",
    "garden-flags.html"
  );

  generateCategoryPage(
    products.filter((p) => p.category === "Digital Pattern"),
    "Digital Patterns",
    "digital-patterns.html"
  );

  generateShopPage(products);
  generateHomePage(products);
  generateSitemap(products);

  console.log("\n✅ BUILD COMPLETE\n");
}

build();
