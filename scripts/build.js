/**
 * FULL CHARMED CARDINAL BUILD SCRIPT
 * -----------------------------------
 * - Pulls Etsy listings via RSS
 * - Scrapes each listing with Puppeteer
 * - Extracts JSON-LD Product (if available)
 * - Robust fallback: scroll page + fetch OG tags + DOM image extraction
 * - Downloads main product image
 * - Generates:
 *      /data/products.json
 *      /products/*.html
 *      /products/garden-flags.html
 *      /products/digital-patterns.html
 *      /shop.html
 *      /index.html
 *      /sitemap.xml
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const xml2js = require("xml2js");
const puppeteer = require("puppeteer");

const DOMAIN = "https://thecharmedcardinal.com";
const SHOP_URL = "https://www.etsy.com/shop/thecharmedcardinal/rss";

const ASSETS_DIR = path.join(__dirname, "..", "assets", "products");
fs.mkdirSync(ASSETS_DIR, { recursive: true });

function slugify(str = "") {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ---------------------------------------
// HELPERS
// ---------------------------------------
async function downloadImage(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);

    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          file.close();
          fs.unlinkSync(destPath);
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        res.pipe(file);
      })
      .on("error", reject);

    file.on("finish", () => {
      file.close();
      resolve(true);
    });
  });
}

async function fetchRSS() {
  console.log(`→ Fetching Etsy RSS: ${SHOP_URL}`);

  return new Promise((resolve, reject) => {
    https
      .get(SHOP_URL, (res) => {
        let xml = "";
        res.on("data", (chunk) => (xml += chunk));
        res.on("end", () => {
          xml2js.parseString(xml, (err, data) => {
            if (err) return reject(err);

            const items = data.rss.channel[0].item;
            const urls = items.map((i) => i.link[0]);

            console.log(`✓ RSS listings: ${urls.length}`);
            resolve(urls);
          });
        });
      })
      .on("error", reject);
  });
}

// ---------------------------------------
// SCRAPE LISTING WITH PUPPETEER
// ---------------------------------------
async function scrapeListing(url, browser) {
  console.log(`→ Scraping listing via Puppeteer: ${url}`);
  const page = await browser.newPage();

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/123.0.0.0 Safari/537.36"
  );

  await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

  // Try to extract JSON-LD Product
  async function getJsonLdProduct() {
    const blocks = await page.$$eval(
      'script[type="application/ld+json"]',
      (nodes) => nodes.map((n) => n.textContent)
    );

    for (const block of blocks) {
      try {
        const parsed = JSON.parse(block);
        if (parsed["@type"] === "Product") return parsed;
      } catch {}
    }

    return null;
  }

  let json = await getJsonLdProduct();

  // If JSON-LD missing → try scroll
  if (!json) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise((res) => setTimeout(res, 1200));
    json = await getJsonLdProduct();
  }

  if (!json) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await new Promise((res) => setTimeout(res, 800));
    json = await getJsonLdProduct();
  }

  // FINAL fallback — pull from OG tags and DOM
  if (!json) {
    console.log("⚠ JSON-LD missing — falling back to OG tags.");

    const html = await page.content();

    function extract(metaName) {
      const r = new RegExp(
        `<meta[^>]+property=["']${metaName}["'][^>]+content=["']([^"']+)["']`,
        "i"
      );
      const m = html.match(r);
      return m ? m[1] : null;
    }

    const title =
      extract("og:title") ||
      "Untitled product";

    const description =
      extract("og:description") ||
      "";

    // Extract image directly from DOM (bulletproof)
    const mainImage = await page.evaluate(() => {
      const img = document.querySelector('img[src*="i.etsystatic.com"]');
      return img ? img.src : null;
    });

    if (!mainImage) {
      console.log("❌ No product image found in DOM either.");
    } else {
      console.log("✓ Using DOM image:", mainImage);
    }

    await page.close();

    const id = (url.match(/listing\/(\d+)/) || [])[1] || "";
    const slug =
      `${slugify(title)}-by-thecharmedcardinal-${id}`.substring(0, 180);

    return {
      id,
      slug,
      title,
      description,
      mainImage,
      etsy: url,
    };
  }

  // JSON-LD success
  const id = (url.match(/listing\/(\d+)/) || [])[1] || "";
  const title = json.name || "Untitled";
  const description = json.description || "";

  let images = [];

  if (Array.isArray(json.image)) {
    images = json.image;
  } else if (typeof json.image === "string") {
    images = [json.image];
  }

  const mainImage = images[0] || null;

  await page.close();

  const slug =
    `${slugify(title)}-by-thecharmedcardinal-${id}`.substring(0, 180);

  return {
    id,
    slug,
    title,
    description,
    mainImage,
    etsy: url,
  };
}

// ---------------------------------------
// SAVE PRODUCT IMAGE
// ---------------------------------------
async function saveMainImage(url, slug) {
  if (!url) return null;

  let ext = ".jpg";
  if (url.includes(".png")) ext = ".png";
  if (url.includes(".webp")) ext = ".webp";

  const filename = `${slug}${ext}`;
  const dest = path.join(ASSETS_DIR, filename);

  try {
    await downloadImage(url, dest);
    return `/assets/products/${filename}`;
  } catch (e) {
    console.log("⚠ Image download failed:", e.message);
    return null;
  }
}

// ---------------------------------------
// GENERATORS (product page, categories, etc.)
// ---------------------------------------
function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderLayout({ title, description, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="stylesheet" href="/styles.css" />
<link rel="icon" type="image/png" href="/assets/favicon.png" />
</head>
<body>
<header>
  <h1><a href="/">The Charmed Cardinal</a></h1>
  <nav>
    <a href="/shop.html">Shop</a>
    <a href="/products/garden-flags.html">Garden Flags</a>
    <a href="/products/digital-patterns.html">Patterns</a>
  </nav>
</header>
<main>${body}</main>
<footer>
  <p>&copy; ${new Date().getFullYear()} The Charmed Cardinal</p>
</footer>
</body>
</html>`;
}

// Single product page
function renderProductPage(p, imageWebPath) {
  return renderLayout({
    title: p.title,
    description: p.description,
    body: `
      <h1>${escapeHtml(p.title)}</h1>
      ${imageWebPath ? `<img src="${imageWebPath}" style="max-width:400px;">` : ""}
      <p>${escapeHtml(p.description)}</p>
      <p><a href="${p.etsy}" target="_blank">View on Etsy →</a></p>
      <p><a href="/shop.html">Back to shop</a></p>
    `,
  });
}

// Category pages
function renderCategory(title, products) {
  return renderLayout({
    title,
    description: `${title} designs from The Charmed Cardinal.`,
    body: `
      <h1>${title}</h1>
      <ul>
      ${products
        .map(
          (p) => `
        <li>
          <a href="/products/${p.slug}.html">${escapeHtml(p.title)}</a>
        </li>
      `
        )
        .join("")}
      </ul>
    `,
  });
}

// Homepage
function renderHome(products) {
  return renderLayout({
    title: "The Charmed Cardinal — Garden Flags & Seamless Patterns",
    description:
      "Handmade garden flags and seamless patterns from The Charmed Cardinal.",
    body: `
      <h1>Welcome to The Charmed Cardinal</h1>
      <p>Explore our handcrafted flags and digital print patterns.</p>
      <h2>Featured Products</h2>
      <ul>
        ${products
          .slice(0, 4)
          .map(
            (p) =>
              `<li><a href="/products/${p.slug}.html">${escapeHtml(
                p.title
              )}</a></li>`
          )
          .join("")}
      </ul>

      <p><a href="/shop.html">View all →</a></p>
    `,
  });
}

// ---------------------------------------
// MAIN BUILD PROCESS
// ---------------------------------------
(async function build() {
  try {
    console.log("\n🚀 BUILD START\n");

    const listingUrls = await fetchRSS();

    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const products = [];

    for (const url of listingUrls) {
      const data = await scrapeListing(url, browser);
      const img = await saveMainImage(data.mainImage, data.slug);
      data.localImage = img;
      products.push(data);
    }

    await browser.close();

    // Save products.json
    const prodPath = path.join(__dirname, "..", "data", "products.json");
    fs.mkdirSync(path.dirname(prodPath), { recursive: true });
    fs.writeFileSync(prodPath, JSON.stringify(products, null, 2));
    console.log("✓ Saved products.json\n");

    // Build product pages
    for (const p of products) {
      const html = renderProductPage(p, p.localImage);
      const out = path.join(__dirname, "..", "products", `${p.slug}.html`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, html);
    }

    // Categories
    const garden = products.filter((p) =>
      p.title.toLowerCase().includes("flag")
    );
    const patterns = products.filter((p) =>
      p.title.toLowerCase().includes("pattern")
    );

    fs.writeFileSync(
      path.join(__dirname, "..", "products", "garden-flags.html"),
      renderCategory("Garden Flags", garden)
    );

    fs.writeFileSync(
      path.join(__dirname, "..", "products", "digital-patterns.html"),
      renderCategory("Digital Patterns", patterns)
    );

    // Shop page
    fs.writeFileSync(
      path.join(__dirname, "..", "shop.html"),
      renderCategory("Shop All Products", products)
    );

    // Home
    fs.writeFileSync(
      path.join(__dirname, "..", "index.html"),
      renderHome(products)
    );

    // Sitemap
    let sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
`;

    sitemap += `  <url><loc>${DOMAIN}/</loc></url>\n`;
    sitemap += `  <url><loc>${DOMAIN}/shop.html</loc></url>\n`;
    sitemap += `  <url><loc>${DOMAIN}/products/garden-flags.html</loc></url>\n`;
    sitemap += `  <url><loc>${DOMAIN}/products/digital-patterns.html</loc></url>\n`;

    for (const p of products) {
      sitemap += `  <url><loc>${DOMAIN}/products/${p.slug}.html</loc></url>\n`;
    }

    sitemap += `</urlset>\n`;

    fs.writeFileSync(
      path.join(__dirname, "..", "sitemap.xml"),
      sitemap
    );

    console.log("✓ Sitemap built.");

    console.log("\n✅ BUILD COMPLETE — full site generated with images.\n");
  } catch (err) {
    console.error("\n❌ BUILD FAILED:", err);
    process.exit(1);
  }
})();
