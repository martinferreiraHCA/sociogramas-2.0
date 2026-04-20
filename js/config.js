// Configuración del frontend.
//
// El backend ahora es un Google Apps Script asociado a una Google Sheet en
// tu Drive (ver apps-script/Code.gs y README.md). Acá va la URL pública de
// la app web y el token compartido.
//
// El token NO es un secreto fuerte (queda en el navegador), pero evita que
// cualquier persona que encuentre la URL de Apps Script pueda escribir en
// tu hoja. Para protección real, la validación fuerte vive del lado del
// Apps Script (chequear código contra los tabs de clase de la Google Sheet
// + hoja "completados" para evitar duplicados).
window.APP_CONFIG = {
  // Completá con la URL .../exec que te da Apps Script al hacer el deploy.
  APPS_SCRIPT_URL:   "https://script.google.com/macros/s/AKfycby8J-q2ZNSv-aR8JDCwaPBucjHSyZ836CdOn6AiKFzLLF3fU7vePRJyrJ3MZ2zOQgsBXg/exec",
  // Tiene que coincidir con CONFIG.TOKEN en apps-script/Code.gs.
  APPS_SCRIPT_TOKEN: "d7d1e6cb97cca059ffcdd126d5f4132a76e99442382f29cf",
};
