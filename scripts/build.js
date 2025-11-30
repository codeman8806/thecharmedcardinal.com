const fs = require("fs");
const path = require("path");

// Base domain
const DOMAIN = "https://thecharmedcardinal.com";

// Template file
const template = fs.readFileSync("./templates/page.html", "utf8");

// Load product data
const products = JSON.parse(fs.readFileSync("./data/products.json", "utf8"));

// Ensure output directory
if (!fs.existsSync("./products")) {
  fs.mkdirSync("./products");
}

// --- Generate product pages ---
products.forEach((p) => {
  const page = template
    .replace(/{TITLE}/g, p.title)
    .replace(/{DESCRIPTION}/g, p.description)
    .replace(/{CANONICAL}/g, `${DOMAIN}/products/${p.slug}.html`)
    .replace(/{CONTENT}/g, `
      <h1>${p.title}</h1>
      <p>${p.description}</p>

      <p><strong>Type:</strong> ${p.type}</p>

      <a class="btn primary" href="${p.etsy}" target="_blank">
        View on Etsy →
      </a>
    `);

  fs.writeFileSync(`./products/${p.slug}.html`, page);
});

// --- Generate sitemap dynamically ---
let sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
`;

// Base static pages
const staticPages = [
  "",
  "shop.html",
  "about.html",
  "blog/",
  "blog/style-your-porch-with-garden-flags.html",
];

staticPages.forEach((p) => {
  sitemap += `  <url><loc>${DOMAIN}/${p}</loc></url>\n`;
});

// Product pages
products.forEach((p) => {
  sitemap += `  <url><loc>${DOMAIN}/products/${p.slug}.html</loc></url>\n`;
});

sitemap += `</urlset>`;

fs.writeFileSync("./sitemap.xml", sitemap);

console.log("Build complete!");
