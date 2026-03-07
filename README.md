# AquaBot

Backend en TypeScript para procesar reportes acuícolas enviados por WhatsApp.

El flujo principal es:
1. Operador elige estanque por chat.
2. Envía foto del formato.
3. AquaBot ejecuta OCR con Gemini.
4. Devuelve borrador editable (correcciones por texto).
5. Al confirmar, persiste el registro en Supabase.

## Estado actual

- Provider recomendado y funcional: `baileys`.
- Provider `twilio`: **stub/no implementado** (si se selecciona, fallará al enviar mensajes).

## Stack

- Node.js 20+
- TypeScript (strict)
- Express (endpoint de health)
- WhatsApp: Baileys (Multi-Device)
- OCR + chat: Google Gemini
- Persistencia: Supabase
- Estado efímero y locks: Redis

## Estructura del proyecto

```text
src/
  index.ts                    # bootstrap de app y servidor HTTP
  config/                     # validación de variables de entorno
  gateway/                    # orquestación de mensajes entrantes
  whatsapp/                   # interfaces y providers (baileys/twilio)
  ocr/                        # pipeline OCR + validación + borradores
  ai/                         # cliente Gemini para chat
  infrastructure/             # clientes Redis y Supabase
  records/                    # servicios de confirmación/cálculos/alertas

database/migrations/
  001_initial_schema.sql
  002_aquabot_additions.sql
```

## Requisitos

- Node.js `>=20`
- Redis accesible (ej: `redis://localhost:6379`)
- Proyecto Supabase con tablas base de AquaData
- API key de Google Gemini

## Configuración

1. Instala dependencias:

```bash
npm install
```

2. Copia variables de entorno:

```bash
cp .env.example .env
```

3. Completa `.env`:

- `WHATSAPP_PROVIDER=baileys`
- `GEMINI_API_KEY` (obligatoria)
- `GOOGLE_GENERATIVE_AI_API_KEY` (opcional; si falta, se deriva de `GEMINI_API_KEY` al iniciar)
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (**service role**, no `anon`)
- `SUPABASE_STORAGE_BUCKET`
- `REDIS_URL`

4. Ejecuta migraciones SQL en Supabase:

- Si ya existe el schema base AquaData: ejecutar `database/migrations/002_aquabot_additions.sql`.
- Si estás montando un entorno nuevo desde cero: revisar y aplicar `001_initial_schema.sql` + `002_aquabot_additions.sql` según tu modelo de datos objetivo.

## Desarrollo

```bash
npm run dev
```

Comandos útiles:

```bash
npm run typecheck
npm run build
npm start
```

Health check:

```bash
curl http://localhost:3000/health
```

Respuesta esperada (ejemplo):

```json
{
  "status": "ok",
  "provider": "baileys",
  "ts": "2026-03-07T15:00:00.000Z"
}
```

## Docker

### Construir imagen

```bash
docker build -t aquabot:latest .
```

### Ejecutar solo el contenedor de app

Si ya tienes Redis externo, usa:

```bash
docker run --rm -it \
  --name aquabot \
  --env-file .env \
  -e BAILEYS_AUTH_FOLDER=/app/baileys-auth \
  -v "$(pwd)/baileys-auth:/app/baileys-auth" \
  -p 3000:3000 \
  aquabot:latest
```

### Levantar app + Redis con Docker Compose

```bash
docker compose up -d --build
```

Esto levanta:
- `aquabot` en `http://localhost:3000`
- `redis` en `localhost:6379`
- sesión de WhatsApp persistida en `./baileys-auth`

Para ver logs:

```bash
docker compose logs -f aquabot
```

Para detener:

```bash
docker compose down
```

## Flujo funcional (Baileys)

1. El usuario envía texto tipo “quiero mandar un reporte”.
2. El bot lista estanques activos y espera selección.
3. Usuario responde con número de estanque.
4. Usuario envía imagen.
5. OCR extrae campos y devuelve borrador.
6. Usuario puede:
   - corregir: `campo: valor`
   - confirmar: `confirmar`
   - cancelar: `cancelar`
7. En `confirmar`, se crea `production_record` y se marca `upload` como procesado.

## Notas operativas

- Sesión de Baileys se guarda en `./baileys-auth`.
- Hay deduplicación por mensaje WhatsApp y rate limit por número.
- Si defines `SUPABASE_DEFAULT_ORG_ID`, números no registrados se auto-crean en `profiles` (recomendado solo en dev/testing).

## Troubleshooting rápido

- `Invalid environment variables`: revisa `.env` y tipos esperados (URL, UUID, etc.).
- Error por `service role`: confirma que `SUPABASE_SERVICE_ROLE_KEY` no sea `anon`.
- No aparecen mensajes en WhatsApp: elimina `baileys-auth` y vuelve a escanear QR.
- Fallos OCR: verifica `GEMINI_API_KEY` y calidad/legibilidad de la imagen.

## Seguridad

- No subir `.env` al repositorio.
- No exponer `SUPABASE_SERVICE_ROLE_KEY` en frontend.
- Limitar acceso de red y credenciales en entornos productivos.
