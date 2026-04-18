// Configuración del frontend.
//
// El backend ahora es un Google Apps Script asociado a una Google Sheet en
// tu Drive (ver apps-script/Code.gs y README.md). Acá va la URL pública de
// la app web y el token compartido.
//
// El token NO es un secreto fuerte (queda en el navegador), pero evita que
// cualquier persona que encuentre la URL de Apps Script pueda escribir en
// tu hoja. Para protección real, la validación fuerte vive del lado del
// Apps Script (chequear código contra estudiantes.csv + hoja "completados"
// para evitar duplicados).
window.APP_CONFIG = {
  APPS_SCRIPT_URL:   "PEGAR_URL_DE_APPS_SCRIPT_AQUI",
  APPS_SCRIPT_TOKEN: "PEGAR_MISMO_TOKEN_QUE_EN_APPS_SCRIPT",
};
