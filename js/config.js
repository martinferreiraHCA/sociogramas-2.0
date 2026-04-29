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
//
// El acceso al panel admin se hace con Google Sign-In limitado al dominio
// que corresponda al colegio. El Apps Script verifica el id_token contra
// Google y rechaza cualquier cuenta de otro dominio.
window.APP_CONFIG = {
  APPS_SCRIPT_URL:   "https://script.google.com/macros/s/AKfycbwJlwMytUFEnAF6M-hvkMRsamdxJdzTh0IL6lwSd4Ji49wXy814vSQU8yBD9KmN66lbow/exec",
  APPS_SCRIPT_TOKEN: "d7d1e6cb97cca059ffcdd126d5f4132a76e99442382f29cf",
  GOOGLE_CLIENT_ID:  "263672487463-2ov3t4ah22caehpnbri341kaiud3n6u3.apps.googleusercontent.com",
  ADMIN_DOMAIN:      "hca.edu.uy",
};
