import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseUblInvoice, parseXml, normalizeInvoice, matchProduct, matchSupplier, buildGeminiRequest,
  pickGeminiModel, readInvoiceWithAI, readInvoiceFile,
} from "../public/invoice.js";

// GİB e-Arşiv faturası: 3 satır, ikincisinde %10 satır iskontosu.
const EARSIV = `<?xml version="1.0" encoding="UTF-8"?>
<?xml-stylesheet type="text/xsl" href="general.xslt"?>
<!-- e-Arşiv örneği; <cbc:ID>YANLIS</cbc:ID> yorumda -->
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
  xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
  <ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions>
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>TR1.2</cbc:CustomizationID>
  <cbc:ProfileID>EARSIVFATURA</cbc:ProfileID>
  <cbc:ID>GIB2026000000123</cbc:ID>
  <cbc:CopyIndicator>false</cbc:CopyIndicator>
  <cbc:UUID>3f2b8c1e-5a7d-4e2f-9c1b-0d6e8a4b2c11</cbc:UUID>
  <cbc:IssueDate>2026-10-21</cbc:IssueDate>
  <cbc:IssueTime>14:32:10</cbc:IssueTime>
  <cbc:InvoiceTypeCode>SATIS</cbc:InvoiceTypeCode>
  <cbc:Note><![CDATA[Yalnız #3.373,00# TL <ödeme 30 gün> & teşekkürler]]></cbc:Note>
  <cbc:DocumentCurrencyCode>TRY</cbc:DocumentCurrencyCode>
  <cbc:LineCountNumeric>3</cbc:LineCountNumeric>
  <cac:AdditionalDocumentReference>
    <cbc:ID>GIB2026000000123</cbc:ID>
    <cbc:IssueDate>2026-10-21</cbc:IssueDate>
    <cac:Attachment>
      <cbc:EmbeddedDocumentBinaryObject characterSetCode="UTF-8" encodingCode="Base64" filename="GIB2026000000123.xslt" mimeCode="application/xml">PHhzbDpzdHlsZXNoZWV0Lz4=</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>
  <cac:Signature>
    <cbc:ID schemeID="VKN_TCKN">3900383669</cbc:ID>
    <cac:SignatoryParty>
      <cac:PartyIdentification><cbc:ID schemeID="VKN">3900383669</cbc:ID></cac:PartyIdentification>
    </cac:SignatoryParty>
  </cac:Signature>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cbc:WebsiteURI/>
      <cac:PartyIdentification><cbc:ID schemeID="MERSISNO">0123456789000015</cbc:ID></cac:PartyIdentification>
      <cac:PartyIdentification><cbc:ID schemeID="VKN">1234567890</cbc:ID></cac:PartyIdentification>
      <cac:PartyName><cbc:Name>Doğuş Gıda   Şekerleme
        San. ve Tic. Ltd. Şti.</cbc:Name></cac:PartyName>
      <cac:PostalAddress>
        <cbc:StreetName>Atatürk Cad.</cbc:StreetName>
        <cbc:BuildingNumber>12/A</cbc:BuildingNumber>
        <cbc:CitySubdivisionName>Şahinbey</cbc:CitySubdivisionName>
        <cbc:CityName>Gaziantep</cbc:CityName>
        <cbc:PostalZone>27000</cbc:PostalZone>
        <cac:Country><cbc:Name>Türkiye</cbc:Name></cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme><cac:TaxScheme><cbc:Name>Şehitkamil</cbc:Name></cac:TaxScheme></cac:PartyTaxScheme>
      <cac:Contact><cbc:Telephone>0342 555 12 34</cbc:Telephone><cbc:ElectronicMail>info@dogus.example</cbc:ElectronicMail></cac:Contact>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyIdentification><cbc:ID schemeID="TCKN">11111111111</cbc:ID></cac:PartyIdentification>
      <cac:PostalAddress><cbc:CityName>İstanbul</cbc:CityName></cac:PostalAddress>
      <cac:Person><cbc:FirstName>Ali</cbc:FirstName><cbc:FamilyName>Yılmaz</cbc:FamilyName></cac:Person>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="TRY">443.00</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="TRY">1500.00</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="TRY">300.00</cbc:TaxAmount>
      <cbc:Percent>20</cbc:Percent>
      <cac:TaxCategory><cac:TaxScheme><cbc:Name>KDV</cbc:Name><cbc:TaxTypeCode>0015</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory>
    </cac:TaxSubtotal>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="TRY">1430.00</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="TRY">143.00</cbc:TaxAmount>
      <cbc:Percent>10</cbc:Percent>
      <cac:TaxCategory><cac:TaxScheme><cbc:Name>KDV</cbc:Name><cbc:TaxTypeCode>0015</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="TRY">2930.00</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="TRY">2930.00</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="TRY">3373.00</cbc:TaxInclusiveAmount>
    <cbc:AllowanceTotalAmount currencyID="TRY">120.00</cbc:AllowanceTotalAmount>
    <cbc:PayableAmount currencyID="TRY">3373.00</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="C62">10</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="TRY">1500.00</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="TRY">300.00</cbc:TaxAmount>
      <cac:TaxSubtotal>
        <cbc:TaxableAmount currencyID="TRY">1500.00</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="TRY">300.00</cbc:TaxAmount>
        <cbc:Percent>20</cbc:Percent>
        <cac:TaxCategory><cac:TaxScheme><cbc:Name>KDV</cbc:Name><cbc:TaxTypeCode>0015</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Name>Doğuş Siyah Çay 1 kg</cbc:Name>
      <cac:SellersItemIdentification><cbc:ID>DG-001</cbc:ID></cac:SellersItemIdentification>
      <cac:StandardItemIdentification><cbc:ID schemeID="GTIN">8690000000017</cbc:ID></cac:StandardItemIdentification>
    </cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="TRY">150.00</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>
  <cac:InvoiceLine>
    <cbc:ID>2</cbc:ID>
    <cbc:InvoicedQuantity unitCode='KGM'>2.500</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="TRY">1080.00</cbc:LineExtensionAmount>
    <cac:AllowanceCharge>
      <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
      <cbc:MultiplierFactorNumeric>0.1</cbc:MultiplierFactorNumeric>
      <cbc:Amount currencyID="TRY">120.00</cbc:Amount>
      <cbc:BaseAmount currencyID="TRY">1200.00</cbc:BaseAmount>
    </cac:AllowanceCharge>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="TRY">108.00</cbc:TaxAmount>
      <cac:TaxSubtotal>
        <cbc:TaxableAmount currencyID="TRY">1080.00</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="TRY">108.00</cbc:TaxAmount>
        <cbc:Percent>10</cbc:Percent>
        <cac:TaxCategory><cac:TaxScheme><cbc:Name>KDV</cbc:Name><cbc:TaxTypeCode>0015</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Name>Fındık İç &amp; Kavrulmuş</cbc:Name>
      <cac:SellersItemIdentification><cbc:ID>FN-25</cbc:ID></cac:SellersItemIdentification>
    </cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="TRY">480.00</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>
  <cac:InvoiceLine>
    <cbc:ID>3</cbc:ID>
    <cbc:Note>Hediye paketli</cbc:Note>
    <cbc:InvoicedQuantity unitCode="C62">4</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="TRY">350.00</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="TRY">35.00</cbc:TaxAmount>
      <cac:TaxSubtotal>
        <cbc:TaxableAmount currencyID="TRY">350.00</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="TRY">35.00</cbc:TaxAmount>
        <cbc:Percent>10</cbc:Percent>
        <cac:TaxCategory><cac:TaxScheme><cbc:Name>KDV</cbc:Name><cbc:TaxTypeCode>0015</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:Item><cbc:Name>Lokum Güllü  A&#x11F;ız Tadı</cbc:Name></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="TRY">87.50</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>
</Invoice>
`;

const EXPECTED = {
  number: "GIB2026000000123", date: "2026-10-21", currency: "TRY", source: "xml",
  supplier: {
    name: "Doğuş Gıda Şekerleme San. ve Tic. Ltd. Şti.", taxNo: "1234567890", taxOffice: "Şehitkamil",
    address: "Atatürk Cad. 12/A, Şahinbey/Gaziantep, 27000", phone: "0342 555 12 34",
  },
  lines: [
    { name: "Doğuş Siyah Çay 1 kg", code: "8690000000017", qty: 10, unit: "adet", unitPrice: 15000, vatRate: 20, total: 150000 },
    { name: "Fındık İç & Kavrulmuş", code: "FN-25", qty: 2.5, unit: "kg", unitPrice: 43200, vatRate: 10, total: 108000 },
    { name: "Lokum Güllü Ağız Tadı", code: "", qty: 4, unit: "adet", unitPrice: 8750, vatRate: 10, total: 35000 },
  ],
  totals: { net: 293000, vat: 44300, gross: 337300 },
};

// Tek satırlık küçük fatura.
const mini = (party, lines, currency = "TRY") => `<Invoice xmlns:cbc="c" xmlns:cac="a"><cbc:ID>K-7</cbc:ID>` +
  `<cbc:IssueDate>2026-01-05</cbc:IssueDate><cbc:DocumentCurrencyCode>${currency}</cbc:DocumentCurrencyCode>` +
  `<cac:AccountingSupplierParty><cac:Party>${party}</cac:Party></cac:AccountingSupplierParty>${lines}</Invoice>`;
const line = (unit, qty, price, name = "Ürün") => `<cac:InvoiceLine><cbc:InvoicedQuantity unitCode="${unit}">${qty}</cbc:InvoicedQuantity>` +
  `<cbc:LineExtensionAmount>${(qty * price).toFixed(2)}</cbc:LineExtensionAmount><cac:Item><cbc:Name>${name}</cbc:Name></cac:Item>` +
  `<cac:Price><cbc:PriceAmount>${price}</cbc:PriceAmount></cac:Price></cac:InvoiceLine>`;

test("e-Arşiv XML: her alan doğru okunur", () => {
  assert.deepEqual(parseUblInvoice(EARSIV), EXPECTED);
});

test("e-Arşiv XML: iskontolu satırda birim fiyat net tutar / miktar", () => {
  const l = parseUblInvoice(EARSIV).lines[1];
  assert.equal(l.unitPrice, 43200); // liste fiyatı 480,00 ama %10 iskontolu
  assert.equal(Math.round(l.qty * l.unitPrice), l.total);
});

test("XML okuyucu: CDATA, varlıklar, yorumlar, kendiliğinden kapanan etiketler", () => {
  const root = parseXml(`<?xml version="1.0"?><!DOCTYPE a [ <!ENTITY x "y"> ]><!-- yorum --><a:kök xmlns:a="u" b='1 > 0' c="&quot;&#252;&#x15F;&quot;">` +
    `<a:boş/><a:not><![CDATA[<b>&amp;</b>]]> ve &lt;tamam&gt;</a:not><?pi x?></a:kök>`);
  const el = root.children[0];
  assert.equal(el.name, "kök");
  assert.equal(el.qname, "a:kök");
  assert.deepEqual(el.attrs, { "xmlns:a": "u", b: "1 > 0", c: "\"üş\"" });
  assert.deepEqual(el.children.map((c) => c.name), ["boş", "not"]);
  assert.equal(el.children[1].text, "<b>&amp;</b> ve <tamam>");
});

test("XML: fatura değilse ya da bozuksa xml-invalid", () => {
  for (const bad of ["", "düz metin", "<svg><g/></svg>", "<Invoice><cbc:Note><![CDATA[bitmedi", mini("", "")]) {
    assert.throws(() => parseUblInvoice(bad), { code: "xml-invalid" }, bad);
  }
});

test("XML: şahıs tedarikçi (TCKN), birim kodları, döviz", () => {
  const party = `<cac:PartyIdentification><cbc:ID schemeID="TCKN">12345678901</cbc:ID></cac:PartyIdentification>` +
    `<cac:Person><cbc:FirstName>Ayşe</cbc:FirstName><cbc:FamilyName>Işık</cbc:FamilyName></cac:Person>`;
  const inv = parseUblInvoice(mini(party, line("BX", 3, 12.5) + line("XYZ", 1, 2) + line("LTR", 1.5, 4) + line("PA", 2, 1, ""), "USD"));
  assert.equal(inv.supplier.name, "Ayşe Işık");
  assert.equal(inv.supplier.taxNo, "12345678901");
  assert.equal(inv.currency, "USD");
  assert.deepEqual(inv.lines.map((l) => [l.unit, l.qty, l.unitPrice, l.total]), [["kutu", 3, 1250, 3750], ["adet", 1, 200, 200], ["lt", 1.5, 400, 600]]);
  assert.deepEqual(inv.totals, { net: 0, vat: 0, gross: 0 });
});

test("dosya: türü boş XML içerikten tanınır, windows-1254 çözülür", async () => {
  assert.deepEqual(await readInvoiceFile(new File([EARSIV], "fatura", { type: "" })), EXPECTED);
  assert.deepEqual(await readInvoiceFile(new File([String.fromCharCode(0xfeff), EARSIV], "fatura", { type: "application/octet-stream" })), EXPECTED);
  const xml = `<?xml version="1.0" encoding="windows-1254"?>${mini("<cac:PartyName><cbc:Name>Kervan</cbc:Name></cac:PartyName>", line("C62", 1, 5, "\xDEeker Ya\xF0l\xFD"))}`;
  const inv = await readInvoiceFile(new File([Buffer.from(xml, "latin1")], "f.xml", { type: "application/xml" }));
  assert.equal(inv.lines[0].name, "Şeker Yağlı");
});

test("dosya: desteklenmeyen tür ai-unsupported", async () => {
  await assert.rejects(readInvoiceFile(new File(["merhaba"], "not.txt", { type: "text/plain" }), { apiKey: "k" }), { code: "ai-unsupported" });
  await assert.rejects(readInvoiceWithAI(new File(["GIF89a"], "a.gif", { type: "image/gif" }), { apiKey: "k" }), { code: "ai-unsupported" });
});

test("normalizeInvoice: dağınık yapay zekâ çıktısı", () => {
  const inv = normalizeInvoice({
    number: " ABC 2026 / 15 ", date: "21.10.2026", currency: "TL",
    supplier: { name: "  Kardeşler   Toptan ", taxNo: "123 456 7890", taxOffice: null, phone: 5321234567 },
    lines: [
      { name: "Şeker 50 kg", qty: "2", unit: "Çuval", unitPrice: "1.234,56", vatRate: "%10", total: null },
      { name: "Un", qty: "3", unit: "KG", unitPrice: null, total: "100" },
      { name: "Bozuk", qty: 0, unitPrice: 5 },
      { name: "  ", qty: 1, unitPrice: 5 },
      { name: "Fiyatsız", unitPrice: 5 },
      { name: "Yağ", qty: 1.23456, unit: "lt", unitPrice: 12.345, vatRate: 20, total: 15.24 },
      { name: "İskonto", qty: 1, unitPrice: -50 },
      null,
    ],
    totals: { net: "2.566,36", vat: null, gross: "2.822,99" },
  });
  assert.deepEqual(inv, {
    number: "ABC 2026 / 15", date: "2026-10-21", currency: "TRY", source: "ai",
    supplier: { name: "Kardeşler Toptan", taxNo: "1234567890", taxOffice: "", address: "", phone: "5321234567" },
    lines: [
      { name: "Şeker 50 kg", code: "", qty: 2, unit: "çuval", unitPrice: 123456, vatRate: 10, total: 246912 },
      { name: "Un", code: "", qty: 3, unit: "kg", unitPrice: 3333, vatRate: null, total: 10000 },
      { name: "Yağ", code: "", qty: 1.235, unit: "lt", unitPrice: 1235, vatRate: 20, total: 1524 },
    ],
    totals: { net: 256636, vat: 25663, gross: 282299 },
  });
});

test("normalizeInvoice: boş girdi ve geçersiz tarih", () => {
  const empty = { name: "", taxNo: "", taxOffice: "", address: "", phone: "" };
  assert.deepEqual(normalizeInvoice(null), {
    number: "", date: "", currency: "TRY", source: "ai", supplier: empty, lines: [], totals: { net: 0, vat: 0, gross: 0 },
  });
  assert.equal(normalizeInvoice({ date: "2026-02-30" }).date, "");
  assert.equal(normalizeInvoice({ date: "5/3/2026" }).date, "2026-03-05");
  assert.equal(normalizeInvoice({ currency: "eur" }).currency, "EUR");
  assert.equal(normalizeInvoice({ currency: "lira" }).currency, "TRY");
});

const PRODUCTS = [
  { id: "p1", name: "Çay 1 kg", barcode: "8690000000017" },
  { id: "p2", name: "Çay 5 kg" },
  { id: "p3", name: "Kulaklık", variant: "Beyaz" },
  { id: "p4", name: "Kulaklık", variant: "Siyah" },
  { id: "p5", name: "Şeker" },
];

test("ürün eşleştirme: barkod birebir", () => {
  assert.deepEqual(matchProduct({ name: "başka ad", code: "869 0000 000017" }, PRODUCTS), { id: "p1", score: 1 });
});

test("ürün eşleştirme: Türkçe harfler, boşluk ve büyük harf", () => {
  assert.equal(matchProduct({ name: "ÇAY 1KG" }, PRODUCTS)?.id, "p1");
  assert.equal(matchProduct({ name: "Çay 5 KG." }, PRODUCTS)?.id, "p2");
  assert.equal(matchProduct({ name: "kulaklik siyah" }, PRODUCTS)?.id, "p4");
  assert.equal(matchProduct({ name: "KULAKLIK BEYAZ" }, PRODUCTS)?.id, "p3");
  assert.equal(matchProduct({ name: "Toz Şeker" }, PRODUCTS)?.id, "p5");
  assert.ok(matchProduct({ name: "ÇAY 1KG" }, PRODUCTS).score >= 0.9);
});

test("ürün eşleştirme: benzeri yoksa null", () => {
  assert.equal(matchProduct({ name: "Elma" }, PRODUCTS), null);
  assert.equal(matchProduct({ name: "Çay 10 kg" }, PRODUCTS), null);
  assert.equal(matchProduct({ name: "" }, PRODUCTS), null);
  assert.equal(matchProduct({ name: "Çay" }, []), null);
});

test("tedarikçi eşleştirme: vergi no, sonra ad; sadece tedarikçiler", () => {
  const parties = [
    { id: "s1", name: "Başka Firma", taxNo: "1234567890", kind: "seller" },
    { id: "s2", name: "Doğuş Gıda", taxNo: "1234567890", kind: "supplier" },
    { id: "s3", name: "Kardeşler Toptan Gıda", kind: "supplier" },
  ];
  assert.equal(matchSupplier({ taxNo: "1234567890", name: "alakasız" }, parties), "s2");
  assert.equal(matchSupplier({ taxNo: "", name: "KARDEŞLER TOPTAN GIDA SAN. VE TİC. LTD. ŞTİ." }, parties), "s3");
  assert.equal(matchSupplier(EXPECTED.supplier, parties.slice(0, 1).concat({ ...parties[1], taxNo: "" })), "s2");
  assert.equal(matchSupplier({ name: "Başka Firma" }, parties), null);
  assert.equal(matchSupplier({ name: "Yeni Tedarikçi" }, parties), null);
});

test("Gemini isteği: dosya, istem ve JSON şeması", () => {
  const body = buildGeminiRequest("JVBERi0=", "application/pdf");
  assert.equal(body.contents.length, 1);
  const [file, prompt] = body.contents[0].parts;
  assert.deepEqual(file, { inline_data: { mime_type: "application/pdf", data: "JVBERi0=" } });
  assert.match(prompt.text, /1\.234,56/);
  assert.match(prompt.text, /YYYY-MM-DD/);
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.equal(body.generationConfig.temperature, 0);
  const schema = body.generationConfig.responseSchema;
  assert.deepEqual(Object.keys(schema.properties.lines.items.properties), ["name", "code", "qty", "unit", "unitPrice", "vatRate", "total"]);
  assert.deepEqual(Object.keys(schema.properties.supplier.properties), ["name", "taxNo", "taxOffice", "address", "phone"]);
});

// fetch'i taklit eder; ağa çıkılmaz.
function fakeFetch(t, reply) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const r = reply(url, calls.length);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}
const MODELS = { body: { models: [
  { name: "models/gemini-1.5-flash", supportedGenerationMethods: ["generateContent"] },
  { name: "models/gemini-2.5-flash-lite", supportedGenerationMethods: ["generateContent"] },
  { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent", "countTokens"] },
  { name: "models/gemini-2.5-flash-image-preview", supportedGenerationMethods: ["generateContent"] },
  { name: "models/gemini-3.0-flash-preview", supportedGenerationMethods: ["generateContent"] },
  { name: "models/gemini-9.0-flash", supportedGenerationMethods: ["embedContent"] },
] } };
const answer = (obj) => ({ body: { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] } });
const pdf = () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], "fatura.pdf", { type: "" });

test("model seçimi: en yeni kararlı flash, -latest varsa o; anahtara göre önbellek", async (t) => {
  const calls = fakeFetch(t, () => MODELS);
  assert.equal(await pickGeminiModel("anahtar-1"), "gemini-2.5-flash");
  assert.equal(await pickGeminiModel("anahtar-1"), "gemini-2.5-flash");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers["x-goog-api-key"], "anahtar-1");
  assert.ok(!calls[0].url.includes("anahtar-1"));
  globalThis.fetch = async () => new Response(JSON.stringify({ models: [...MODELS.body.models,
    { name: "models/gemini-flash-latest", supportedGenerationMethods: ["generateContent"] }] }));
  assert.equal(await pickGeminiModel("anahtar-2"), "gemini-flash-latest");
  await assert.rejects(pickGeminiModel(""), { code: "ai-no-key" });
});

test("yapay zekâ: PDF okunur, istek doğru kurulur", async (t) => {
  const calls = fakeFetch(t, (url) => (url.includes(":generateContent") ? answer({
    supplier: { name: "Kervan Toptan", taxNo: "1234567890" }, number: "A-1", date: "2026-10-01", currency: "TRY",
    lines: [{ name: "Çay", code: null, qty: 2, unit: "adet", unitPrice: 10.5, vatRate: 20, total: 21 }],
    totals: { net: 21, vat: 4.2, gross: 25.2 },
  }) : MODELS));
  const inv = await readInvoiceFile(pdf(), { apiKey: "anahtar-3" });
  assert.equal(inv.source, "ai");
  assert.deepEqual(inv.lines, [{ name: "Çay", code: "", qty: 2, unit: "adet", unitPrice: 1050, vatRate: 20, total: 2100 }]);
  assert.deepEqual(inv.totals, { net: 2100, vat: 420, gross: 2520 });
  const gen = calls.find((c) => c.url.includes(":generateContent"));
  assert.equal(gen.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
  assert.equal(gen.init.method, "POST");
  assert.equal(gen.init.headers["x-goog-api-key"], "anahtar-3");
  assert.deepEqual(JSON.parse(gen.init.body).contents[0].parts[0], { inline_data: { mime_type: "application/pdf", data: "JVBERi0=" } });
});

test("yapay zekâ: model kaldırılmışsa liste yenilenir", async (t) => {
  let gone = true;
  fakeFetch(t, (url) => {
    if (!url.includes(":generateContent")) return MODELS;
    if (gone) { gone = false; return { status: 404, body: { error: { status: "NOT_FOUND" } } }; }
    return answer({ supplier: {}, lines: [{ name: "Un", qty: 1, unitPrice: 3 }] });
  });
  assert.equal((await readInvoiceWithAI(pdf(), { apiKey: "anahtar-4" })).lines[0].unitPrice, 300);
});

test("yapay zekâ: hata kodları, mesajda anahtar yok", async (t) => {
  const key = "GIZLI-ANAHTAR-123";
  let reply;
  fakeFetch(t, () => reply);
  const expect = async (r, code, options = { apiKey: key, model: "gemini-x" }) => {
    reply = r;
    const err = await readInvoiceWithAI(pdf(), options).catch((e) => e);
    assert.equal(err.code, code, JSON.stringify(r));
    assert.ok(!String(err.message).includes(key) && !String(err.stack).includes(key));
  };
  await expect(null, "ai-no-key", { apiKey: " " });
  const big = { name: "büyük.pdf", type: "application/pdf", size: 16 * 1024 * 1024 };
  await assert.rejects(readInvoiceWithAI(big, { apiKey: key }), { code: "ai-too-big" });
  await expect({ status: 400, body: { error: { status: "INVALID_ARGUMENT", message: "API key not valid.", details: [{ reason: "API_KEY_INVALID" }] } } }, "ai-bad-key");
  await expect({ status: 403, body: {} }, "ai-bad-key");
  await expect({ status: 429, body: { error: { status: "RESOURCE_EXHAUSTED" } } }, "ai-quota");
  await expect({ status: 500, body: { error: { status: "INTERNAL" } } }, "ai-failed");
  await expect(new TypeError("Failed to fetch"), "ai-network");
  await expect({ body: { candidates: [{ content: { parts: [{ text: "{bozuk" }] } }] } }, "ai-unreadable");
  await expect(answer({ supplier: {}, lines: [] }), "ai-unreadable");
  await expect({ body: { promptFeedback: { blockReason: "SAFETY" } } }, "ai-unreadable");
});

test("anahtarsız yol: dosya türü ve cevap okuma ortak", async () => {
  const { aiFileType, parseAiText } = await import("../public/invoice.js");
  assert.equal(await aiFileType(new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])], "fatura", { type: "" })), "application/pdf");
  assert.equal(await aiFileType(new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], "foto.jpg", { type: "image/jpg" })), "image/jpeg");
  const inv = parseAiText('```json\n{"supplier":{"name":"Doğu Toptan"},"lines":[{"name":"Çay","qty":2,"unitPrice":150.5}]}\n```');
  assert.equal(inv.source, "ai");
  assert.equal(inv.lines[0].unitPrice, 15050);
  assert.throws(() => parseAiText('{"lines":[]}'), (e) => e.code === "ai-unreadable");
  await assert.rejects(aiFileType(new File(["GIF89a"], "x.gif", { type: "image/gif" })), (e) => e.code === "ai-unsupported");
});
