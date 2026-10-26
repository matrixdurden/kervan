// Anahtarsız fatura okuma: Gemini'ye işletmenin Firebase projesi üzerinden (Firebase AI Logic)
// gidilir; kullanıcı hiçbir anahtar girmez. Kötüye kullanıma karşı App Check (reCAPTCHA v3)
// sadece gerçek uygulamadan gelen isteklere izin verir. Ücretsiz Spark planında Gemini Developer
// API'nin ücretsiz kotası kullanılır (tüm işletmeler için ortak). App Check sağlayıcısı Google
// Cloud Fraud Defense'tır (eski adı reCAPTCHA Enterprise); eski reCAPTCHA v3 kullanımdan kalkıyor.

import { app, isLocal } from "./firebase.js";
import { recaptchaSiteKey } from "./firebase-config.js";
import { prepareAiInput, parseAiText } from "./invoice.js";

const SDK = "https://www.gstatic.com/firebasejs/12.0.0";
// Model adları zamanla değişir; ilki bulunamazsa sıradakine geçilir.
const MODELS = ["gemini-3.8-flash", "gemini-flash-latest", "gemini-2.5-flash"];

export const sharedAiReady = () => Boolean(recaptchaSiteKey) && !isLocal;

let ai = null;
let workingModel = null;

async function getAi() {
  if (ai) return ai;
  const [{ initializeAppCheck, ReCaptchaEnterpriseProvider }, { getAI, GoogleAIBackend }] = await Promise.all([
    import(`${SDK}/firebase-app-check.js`), import(`${SDK}/firebase-ai.js`),
  ]);
  initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(recaptchaSiteKey), isTokenAutoRefreshEnabled: true });
  ai = getAI(app, { backend: new GoogleAIBackend() });
  return ai;
}

const codeError = (code) => Object.assign(new Error(code), { code });

// SDK hatasından uygulamanın hata kodu.
function errorCode(err) {
  const s = `${err?.code ?? ""} ${err?.message ?? ""} ${err?.customErrorData?.status ?? ""}`;
  if (/429|RESOURCE_EXHAUSTED|quota/i.test(s)) return "ai-quota";
  if (/app-check|appCheck|401|403|PERMISSION_DENIED|api-not-enabled|SERVICE_DISABLED/i.test(s)) return "ai-setup";
  if (/fetch|network|Failed to fetch/i.test(s)) return "ai-network";
  return "ai-failed";
}

const notFound = (err) => /404|NOT_FOUND|not found/i.test(`${err?.message ?? ""} ${err?.customErrorData?.status ?? ""}`);

export async function readInvoiceShared(file) {
  if (!sharedAiReady()) throw codeError("ai-no-key");
  const input = await prepareAiInput(file);
  const { getGenerativeModel } = await import(`${SDK}/firebase-ai.js`);
  const instance = await getAi();
  for (const name of workingModel ? [workingModel] : MODELS) {
    try {
      const model = getGenerativeModel(instance, { model: name, generationConfig: input.generationConfig });
      const result = await model.generateContent({ contents: [{ role: "user", parts: input.parts }] });
      workingModel = name;
      return parseAiText(result.response.text());
    } catch (err) {
      if (err?.code === "ai-unreadable") throw err;
      if (notFound(err) && !workingModel) continue; // bu model yok, sıradakini dene
      console.error(err);
      throw codeError(errorCode(err));
    }
  }
  throw codeError("ai-failed");
}
