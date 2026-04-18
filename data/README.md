# Datos del sistema (CSVs)

Estos CSVs son la única fuente de configuración del cuestionario. Editalos
con Excel / Google Sheets / cualquier editor de texto y hacé commit.

## `estudiantes.csv`
Lista de alumnos autorizados a responder. Columnas:

| columna | descripción |
|---------|-------------|
| `codigo` | Código único con el que el alumno entra (sin espacios). |
| `nombre` | Nombre a mostrar. |
| `clase`  | Grupo/curso. Los compañeros son los alumnos con la misma `clase` (excepto uno mismo). |

## `preguntas.csv`
Lista de preguntas, ordenadas por `numero`. Columnas:

| columna | descripción |
|---------|-------------|
| `numero` | Orden de la pregunta (entero, único). |
| `texto`  | Enunciado que ve el alumno. |
| `tipo`   | `AFINIDAD` (una por compañero, con sub-pregunta), `MULTIPLE` (checkboxes, se muestra como sub-pregunta) o `SELECCION_COMPANEROS` (marcar varios compañeros). |

## `opciones.csv`
Opciones de las preguntas `AFINIDAD` y `MULTIPLE`. Columnas:

| columna | descripción |
|---------|-------------|
| `numero_pregunta` | Referencia a `preguntas.csv`. |
| `orden` | Orden dentro de la pregunta. |
| `texto` | Texto de la opción. Si contiene "Otro motivo", se pide texto libre. |

La pregunta de tipo `AFINIDAD` detecta los colores por el texto de la opción
(`Verde`, `Amarillo`, `Rojo`, `Blanco`).

## `flujos.csv`
Define qué sub-pregunta aparece según la opción elegida en la afinidad.
Columnas:

| columna | descripción |
|---------|-------------|
| `numero_pregunta` | Pregunta que dispara el flujo (típicamente 1). |
| `opcion_orden` | `orden` de la opción elegida en `opciones.csv`. |
| `siguiente_pregunta` | `numero` de la sub-pregunta a mostrar. Vacío = no se muestra nada. |
