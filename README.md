# Sociogramas (HTML/JS + CSV + Google Sheet)

App estática (sin build) para correr sociogramas en clase. Todo el
front es HTML + JS plano publicado en GitHub Pages.

- **Input**: CSVs en la carpeta `data/` (preguntas, opciones, flujos,
  estudiantes). Se editan con Excel / Google Sheets / cualquier editor.
- **Backend**: un Google Apps Script corto que recibe las respuestas por
  POST y las anexa a una Google Sheet en tu Drive.
- **Output**: la propia Google Sheet — abrís "Archivo → Descargar →
  Microsoft Excel (.xlsx)" o directo "Abrir con Excel" desde Drive.

## Estructura

```
index.html               Login del estudiante (código)
cuestionario.html        Cuestionario
css/styles.css
js/
  config.js              ⚠️ Editar: URL del Apps Script + token
  utils.js               CSV, toast, helpers DOM
  api.js                 Carga de CSVs y POST al Apps Script
  cuestionario.js
data/
  estudiantes.csv        codigo,nombre,clase
  preguntas.csv          numero,texto,tipo
  opciones.csv           numero_pregunta,orden,texto
  flujos.csv             numero_pregunta,opcion_orden,siguiente_pregunta
  README.md              Detalle del esquema de cada CSV
apps-script/
  Code.gs                Backend que corre en script.google.com
```

## Setup

### 1. Crear la Google Sheet de respuestas

1. En tu Drive, **Nuevo → Google Sheets**, poné un nombre (ej:
   `Sociogramas - respuestas`).
2. Copiar el ID: en la URL, es la parte entre `/d/` y `/edit`.

### 2. Pegar el Apps Script

1. Ir a https://script.google.com → **Nuevo proyecto**.
2. Borrar `Code.gs` de ejemplo y pegar el contenido de
   `apps-script/Code.gs` de este repo.
3. Editar el bloque `CONFIG` al principio del archivo:
   - `SHEET_ID`: el ID copiado en el paso anterior.
   - `TOKEN`: una cadena larga y aleatoria (ej:
     `openssl rand -hex 24`). Este mismo valor va en `js/config.js`.
   - `ESTUDIANTES_URL` (opcional pero recomendado): URL "raw" del
     `estudiantes.csv` en GitHub. Formato:
     `https://raw.githubusercontent.com/USUARIO/REPO/BRANCH/data/estudiantes.csv`.
     Si se completa, el Apps Script valida que el código exista en el CSV
     antes de registrar la respuesta.
4. **Guardar** (💾). La primera vez te pedirá autorizar el script a
   acceder a Sheets y a URL Fetch.
5. **Implementar → Nuevo implementación** → tipo **Aplicación web**.
   - *Ejecutar como*: **Yo** (tu cuenta).
   - *Quién tiene acceso*: **Cualquiera**.
   - Implementar → copiar la URL `.../exec`.

> Cada vez que modifiques `Code.gs` tenés que hacer *Implementar → Administrar
> implementaciones → editar → Versión nueva*. Si no, la URL sigue apuntando
> al código viejo.

### 3. Configurar el front

Editar `js/config.js`:

```js
window.APP_CONFIG = {
  APPS_SCRIPT_URL:   "https://script.google.com/macros/s/AKfycb.../exec",
  APPS_SCRIPT_TOKEN: "el-mismo-token-que-en-apps-script",
};
```

### 4. Probar local

```bash
python3 -m http.server 8080
# abrir http://localhost:8080
```

Usar un código del `data/estudiantes.csv` (ej: `JUAN001`) para entrar.

### 5. Publicar en GitHub Pages

**Settings → Pages → Source → Deploy from a branch** (rama `main`,
carpeta `/`). El sitio queda en `https://USUARIO.github.io/REPO/`.

## Cómo gestionar preguntas, flujos y estudiantes

Editar los CSVs en `data/` (ver `data/README.md` para el detalle de
cada columna) y hacer commit. No hay panel de admin: los cambios viajan
por git.

Para cambiar la lista de alumnos:

1. Abrir `data/estudiantes.csv` (en Excel, Google Sheets, o un editor de
   texto).
2. Agregar/quitar filas. Commit + push.
3. Los alumnos ven los cambios al recargar (se hace cache-busting con un
   query string).

## Cómo ver las respuestas

- Abrí la Google Sheet configurada. La pestaña **`respuestas`** tiene una
  fila por cada respuesta enviada (con timestamp, código, nombre, clase,
  pregunta y opción).
- La pestaña **`completados`** registra qué alumnos ya enviaron (el Apps
  Script usa esto para bloquear reenvíos).
- Para bajarlo como Excel: **Archivo → Descargar → Microsoft Excel
  (.xlsx)**.

## Seguridad (qué protege, qué no)

- El `APPS_SCRIPT_TOKEN` queda en el navegador, así que no es un secreto
  fuerte; evita que un bot aleatorio que encuentre la URL pueda escribir.
- El Apps Script valida:
  - Que el `token` coincida.
  - (Opcional, con `ESTUDIANTES_URL`) que el `codigo` exista en el CSV.
  - Que el `codigo` no haya enviado antes (hoja `completados`).
- Las respuestas viven en tu Google Sheet — solo vos (y a quien compartas
  la hoja) podés leerlas.

## Sistema anterior (obsoleto)

Los archivos `admin-login.html`, `admin.html`, `dashboard.html`,
`js/admin.js`, `js/dashboard.js`, `js/supabase.js` y la carpeta
`supabase/` pertenecen a la versión anterior basada en Supabase. Quedan
en el repo como referencia pero **no forman parte del flujo actual**.
Pueden borrarse sin romper nada.
