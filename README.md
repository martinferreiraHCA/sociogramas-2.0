# Sociogramas (HTML/JS + Supabase + GitHub Pages)

App estática (sin build) que sirve sociogramas para clases. El front es
HTML + JS plano publicado en GitHub Pages, y la base de datos vive en
[Supabase](https://supabase.com) (Postgres + RPC).

- **Estudiantes**: ingresan con su código, responden el cuestionario y
  quedan bloqueados al finalizar (no pueden volver a responder).
- **Docente**: gestiona clases, sube planilla de estudiantes en CSV,
  abre / cierra cuestionarios, ve respuestas y arma grupos con drag &
  drop. Acceso protegido por contraseña compartida.

## Estructura

```
index.html               Login del estudiante (código)
cuestionario.html        Cuestionario con progreso en localStorage
admin-login.html         Login admin (contraseña)
admin.html               Panel del docente: clases, CSV, cuestionarios
dashboard.html           Sociograma + estadísticas + armado de grupos
css/styles.css
js/
  config.js              ⚠️ Editar: URL Supabase + anon key + password
  supabase.js            Cliente y helpers
  utils.js               CSV, toast, helpers DOM
  cuestionario.js
  admin.js
  dashboard.js
supabase/schema.sql      Schema completo + RLS + RPC + semilla
.nojekyll                Indica a GitHub Pages que no procese con Jekyll
.github/workflows/pages.yml  Deploy automático a Pages
```

## Setup

### 1. Crear el proyecto en Supabase

1. Crear un proyecto nuevo en https://supabase.com.
2. En **SQL Editor → New query**, pegar todo el contenido de
   `supabase/schema.sql` y ejecutarlo. Esto crea tablas, RLS, RPCs,
   semilla de preguntas y la contraseña inicial del admin.
3. **Cambiar la contraseña por defecto** (`cambiame`). Editá la última
   línea del archivo antes de ejecutarlo, o corré:

   ```sql
   update app_config
      set value = crypt('TU_PASSWORD_FUERTE', gen_salt('bf'))
    where key = 'admin_password_hash';
   ```

4. En **Project Settings → API** copiá:
   - `Project URL`
   - `anon public` key

### 2. Configurar el front

Editá `js/config.js` y completá:

```js
window.APP_CONFIG = {
  SUPABASE_URL: "https://xxx.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOi...",
  ADMIN_PASSWORD: "TU_PASSWORD_FUERTE"
};
```

> ⚠️ La anon key y la contraseña quedan visibles en el navegador. La
> seguridad real está en Postgres: las RPC SECURITY DEFINER validan
> contraseña y las RLS bloquean accesos directos a las tablas. Aun así,
> tratá la contraseña como compartida entre todos los docentes.

### 3. Probar localmente

GitHub Pages necesita que las URLs sean servidas por HTTP, no `file://`.
Para probar local:

```bash
# Cualquier servidor estático sirve, por ejemplo:
python3 -m http.server 8080
```

Luego abrí http://localhost:8080.

### 4. Publicar en GitHub Pages

Opción A — automático con el workflow incluido:

1. Pusheá la rama (ej. `main`).
2. En GitHub: **Settings → Pages → Source → GitHub Actions**.
3. El workflow `.github/workflows/pages.yml` publica el sitio entero.

Opción B — manual:

1. **Settings → Pages → Source → Deploy from a branch** (rama `main`,
   carpeta `/`).

El sitio queda en `https://USUARIO.github.io/REPO/`.

## Flujo de uso

1. **Docente** entra a `/admin-login.html`, crea una clase,
   sube un CSV con columnas `nombre,codigo_estudiante` y crea un
   cuestionario. Esto asigna el cuestionario a todos los alumnos.
2. **Estudiante** entra a `/`, escribe su código, lee instrucciones y
   responde. El progreso se guarda en `localStorage` por si se
   interrumpe.
3. Al finalizar, el alumno envía las respuestas con un único RPC
   (`submit_respuestas`) que valida server-side que no haya respondido
   antes y marca al alumno como completado.
4. **Docente** abre `/dashboard.html`, ve el sociograma, las
   estadísticas y arma grupos con drag & drop.

## Importar estudiantes

CSV mínimo (UTF-8):

```csv
nombre,codigo_estudiante
Juan Pérez,JUAN001
María García,MARIA002
```

El admin permite "reemplazar todos" o ir agregando.

## Seguridad: lo que cubre el schema

- RLS habilitada en todas las tablas. `anon` solo puede leer
  `pregunta` y `opcion_pregunta`.
- Todo lo demás se accede vía RPCs `SECURITY DEFINER` que requieren la
  contraseña del admin (excepto `login_estudiante` y
  `submit_respuestas`, que son las únicas operaciones públicas).
- `submit_respuestas` corre en transacción: valida estado del
  cuestionario, valida que el estudiante no haya completado, inserta
  todas las respuestas y marca al alumno completado.
- `admin_*` validan la contraseña con `crypt()` (bcrypt) contra
  `app_config.admin_password_hash`.

## Borrar / migrar datos antiguos (opcional)

Si vienés del proyecto Hasura/Next, los CSVs del repo
(`export_public_*.csv`) sirven solo como referencia histórica.
Podés borrarlos cuando quieras.
