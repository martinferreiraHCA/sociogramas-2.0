# Sociogramas (HTML/JS + CSV + Google Sheet)

App estática (sin build) para correr sociogramas en clase. Todo el
front es HTML + JS plano publicado en GitHub Pages.

- **Input**:
  - CSVs en `data/` para preguntas, opciones y flujos (se editan con
    Excel / Google Sheets / cualquier editor y se commitean).
  - **Listado de estudiantes en la Google Sheet**: una hoja por clase
    (nombre del tab = nombre de la clase) con columnas `Nombre` y
    `Código`. El dashboard tiene un botón **Generar códigos** que
    completa los códigos vacíos sin pisar los existentes.
- **Backend**: un Google Apps Script corto que recibe las respuestas por
  POST, anexa filas a la Google Sheet y lee el roster desde los tabs
  por clase.
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
  preguntas.csv          numero,texto,tipo
  opciones.csv           numero_pregunta,orden,texto
  flujos.csv             numero_pregunta,opcion_orden,siguiente_pregunta
  estudiantes.csv        (legado — el roster ahora vive en la Google Sheet)
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
   - `ADMIN_PASSWORD`: contraseña del dashboard del docente.
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

Para probar, crear una hoja en la Google Sheet con el nombre de una clase
(ej: `1A`), headers `Nombre` y `Código`, cargar uno o dos alumnos y
generar sus códigos desde el dashboard. Después usar ese código para
loguearse en `index.html`.

### 5. Publicar en GitHub Pages

**Settings → Pages → Source → Deploy from a branch** (rama `main`,
carpeta `/`). El sitio queda en `https://USUARIO.github.io/REPO/`.

## Cómo gestionar preguntas, flujos y estudiantes

- **Preguntas / opciones / flujos**: editar los CSVs en `data/` (ver
  `data/README.md` para el detalle de cada columna) y hacer commit.
- **Estudiantes / códigos**: en la Google Sheet, una hoja por clase con
  columnas `Nombre` y `Código`.
  - Desde el dashboard (`dashboard.html`), el panel *Estudiantes y
    códigos* permite agregar estudiantes, eliminarlos y **generar los
    códigos que falten** (no pisa los ya cargados).
  - También se puede editar la planilla a mano y recargar el dashboard.
  - Los tabs reservados (`respuestas`, `completados`, `grupos`) no se
    listan como clases.

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
  - Que el `codigo` exista en algún tab de clase de la Google Sheet.
  - Que el `codigo` no haya enviado antes (hoja `completados`).
- Las respuestas viven en tu Google Sheet — solo vos (y a quien compartas
  la hoja) podés leerlas.

## Dashboard del docente

`admin-login.html` pide contraseña (la que configuraste en
`apps-script/Code.gs` como `ADMIN_PASSWORD`). Después redirige a
`dashboard.html`, que trae:

- Resumen (completados, conteos de afinidad por color).
- Sociograma (grafo circular con flechas coloreadas según la pregunta 1).
- Detalle por estudiante (respuestas recibidas por cada alumno).
- **Armado de grupos automático**: botón "Generar automático" que corre
  un algoritmo sociométrico (ver sección siguiente). Los grupos se
  pueden editar con drag&drop y guardar. Al guardar, se escriben en
  la pestaña `grupos` de la misma Google Sheet.

## Algoritmo de armado de grupos

Implementado en `js/groups.js`. Se apoya en literatura de sociometría,
aprendizaje cooperativo y composición de equipos:

- **Moreno (1934)** – test sociométrico: las elecciones declaradas
  predicen cohesión y conflicto en el grupo real.
- **Coie & Dodge (1988)** – peer nomination: categorías
  (popular / rechazado / aislado / controvertido) requieren tratamientos
  distintos en el armado.
- **Johnson & Johnson (1999)** – cooperative learning: grupos
  heterogéneos funcionan mejor cuando la tarea exige interdependencia.
- **Salas, Stagl & Burke (2004)** – composición de equipos: tamaño
  óptimo 3–5 para tareas colaborativas escolares.
- **Kernighan & Lin (1970)** – partición de grafos por swaps: base del
  refinamiento iterativo.

El problema es NP-duro (agrupamiento con peso sujeto a restricciones);
el algoritmo usa un esquema heurístico en 4 fases:

1. **Matriz de afinidad dirigida**: verde=+3, amarillo=+1, rojo=−5,
   pregunta 5 ("ayudan")=+1, pregunta 6 ("sentir parte")=+1,
   pregunta 10 ("cuesta")=−2.
2. **Score de pares** simétrico con bonificaciones por reciprocidad:
   verde mutuo +2, rojo mutuo −5 (además del peso base).
3. **Seeds**: los alumnos más vulnerables (altos en pregunta 8 "sin
   grupo" y 9 "necesita apoyo", o con muchos rojos recibidos y pocos
   verdes) se siembran en grupos distintos.
4. **Inserción greedy** del resto, priorizando opiniones más polarizadas.
   Restricción dura configurable: no permitir rojos mutuos dentro del
   mismo grupo. Restricciones blandas: distribuir líderes
   (pregunta 7) y apoyos (pregunta 9) entre grupos.
5. **Búsqueda local por swaps** (Kernighan-Lin simplificado): intercambia
   pares entre grupos si el swap mejora la cohesión total, iterando
   hasta llegar a un óptimo local.

El dashboard muestra el score total, cuántos rojos mutuos quedaron y
qué alumnos fueron marcados como aislados.

## Sistema anterior (obsoleto)

Los archivos `js/admin.js` y `js/supabase.js` y la carpeta `supabase/`
pertenecen a la versión anterior basada en Supabase. Quedan en el repo
como referencia pero **no forman parte del flujo actual**. Se pueden
borrar sin romper nada.
