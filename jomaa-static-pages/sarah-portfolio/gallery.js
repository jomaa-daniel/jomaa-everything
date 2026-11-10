import { artworks } from "./artworks.js";

const gallery = document.querySelector(".gallery");
const filters = document.querySelector(".filters");
const dialog = document.querySelector(".lightbox");
const image = dialog.querySelector("img");
const title = dialog.querySelector("h3");
const meta = dialog.querySelector(".meta");
const description = dialog.querySelector(".description");

let visible = artworks;
let current = 0;

function render(series) {
  visible = series === "All" ? artworks : artworks.filter((art) => art.series === series);
  gallery.replaceChildren(
    ...visible.map((art, index) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("aria-label", `View ${art.title}, ${art.year}`);
      const img = document.createElement("img");
      img.src = `images/${art.file}`;
      img.alt = `${art.title}: ${art.description}`;
      img.width = art.width;
      img.height = art.height;
      img.loading = "lazy";
      img.decoding = "async";
      const caption = document.createElement("span");
      caption.className = "caption";
      caption.textContent = `${art.title} · ${art.year}`;
      button.append(img, caption);
      button.addEventListener("click", () => open(index));
      item.append(button);
      return item;
    }),
  );
  for (const chip of filters.children) chip.setAttribute("aria-pressed", String(chip.textContent === series));
}

function show(index) {
  current = (index + visible.length) % visible.length;
  const art = visible[current];
  image.src = `images/${art.file}`;
  image.alt = `${art.title}: ${art.description}`;
  title.textContent = art.title;
  meta.textContent = `${art.year} · ${art.medium} · ${art.size}`;
  description.textContent = art.description;
}

function open(index) {
  show(index);
  dialog.showModal();
}

for (const series of ["All", ...new Set(artworks.map((art) => art.series))]) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.textContent = series;
  chip.addEventListener("click", () => render(series));
  filters.append(chip);
}
render("All");

dialog.querySelector(".close").addEventListener("click", () => dialog.close());
dialog.querySelector(".prev").addEventListener("click", () => show(current - 1));
dialog.querySelector(".next").addEventListener("click", () => show(current + 1));
// Clicking the dark backdrop (the dialog itself, not its contents) closes it.
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});
dialog.addEventListener("keydown", (event) => {
  if (event.key === "ArrowLeft") show(current - 1);
  if (event.key === "ArrowRight") show(current + 1);
});
let touchX = null;
dialog.addEventListener("touchstart", (event) => (touchX = event.touches[0].clientX), { passive: true });
dialog.addEventListener("touchend", (event) => {
  if (touchX === null) return;
  const delta = event.changedTouches[0].clientX - touchX;
  if (Math.abs(delta) > 50) show(current + (delta < 0 ? 1 : -1));
  touchX = null;
});

document.querySelector(".year").textContent = String(new Date().getFullYear());
