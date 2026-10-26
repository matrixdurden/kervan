// Ürün seçme penceresi: formun üstünde açılan, aranabilir ürün listesi. Dokunulan ürün forma
// eklenir (ikinci dokunuşta adedi artar) ve pencere açık kalır ki birkaç ürün art arda
// eklenebilsin; formdaki adet ürünün yanında görünür. "Tamam" ya da geri oku pencereyi kapatır.

import { $, h, icon, toast } from "./ui.js";
import { t, unitLabel } from "./i18n.js";
import { formatMoney, formatNumber } from "./money.js";
import { productLabel, productByBarcode } from "./data.js";
import { byName, matches, searchBox, productThumb, emptyState } from "./views.js";
import { canScan, scanBarcode } from "./scanner.js";

const dialog = $("#picker");

// products: seçilebilecek ürünler; count(p): formdaki adedi; onpick(p): forma ekler.
// meta(p): ürünün altındaki açıklama (verilmezse depodaki stok).
export function pickProducts({ title = t("pickProducts"), products, count, onpick, meta }) {
  let query = "";
  const list = h("ul", { class: "cards pick-list" });
  const doneLabel = h("span", {});

  const stockMeta = (p) => t("inStockShort", { n: formatNumber(p.stock), unit: unitLabel(p.unit) });
  const added = () => products.filter((p) => count(p) > 0).length;

  const render = () => {
    const shown = products.filter((p) => matches(productLabel(p), query) || (query && p.barcode === query.trim())).sort(byName);
    list.replaceChildren(...(shown.length ? shown.map((p) => {
      const n = count(p);
      return h("li", {}, h("button", { type: "button", class: `card row pick${n ? " picked" : ""}`, onclick: () => pick(p) },
        productThumb(p),
        h("span", { class: "main" },
          h("span", { class: "title" }, h("bdi", {}, productLabel(p))),
          h("span", { class: "meta" },
            h("span", { class: p.stock <= 0 ? "bad" : "" }, (meta ?? stockMeta)(p)),
            p.price ? ` · ${formatMoney(p.price)}` : "")),
        h("span", { class: "pick-mark", "aria-hidden": "true" }, n ? `×${formatNumber(n)}` : icon("plus"))));
    }) : [emptyState("🔍", t("noMatch"))]));
    const n = added();
    doneLabel.textContent = n ? t("pickedDone", { n }) : t("done");
  };

  const pick = (p) => {
    onpick(p);
    navigator.vibrate?.(20);
    render();
  };

  const scan = async () => {
    const code = await scanBarcode();
    if (!code) return;
    const p = productByBarcode(code);
    if (!p || !products.includes(p)) return toast(t("barcodeUnknown", { code }));
    return pick(p);
  };

  dialog.replaceChildren(h("div", { class: "menu" },
    h("header", { class: "sheet-top" },
      h("button", { type: "button", class: "icon back", "aria-label": t("close"), onclick: () => dialog.close() }, icon("back")),
      h("h3", {}, title)),
    h("div", { class: "sheet-body" },
      searchBox(t("searchProducts"), "", (v) => { query = v; render(); }, canScan() ? scan : null),
      list),
    h("div", { class: "sheet-foot" },
      h("button", { type: "button", class: "primary block", onclick: () => dialog.close() }, icon("check"), doneLabel))));
  render();
  dialog.showModal();
  return new Promise((resolve) => { dialog.onclose = () => resolve(); });
}
