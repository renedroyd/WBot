# WBot — Fase 1: contrato moderno de publicaciones

## Responsabilidades de las tres aplicaciones

- **Dubai-Shop:** fuente de verdad de catálogo, variantes, precios y disponibilidad. No entrega publicaciones directamente a WBot.
- **SocialPublicator:** administra campañas, publicaciones, calendario, destinos, permisos, credenciales y estado de ejecución. Expone la API de agente.
- **WBot:** agente ejecutor. Consulta SocialPublicator y realiza la entrega en los destinos autorizados.

WBot no debe conectarse directamente a la base de datos ni a la API comercial de Dubai-Shop.

## Endpoint de publicaciones

El agente utiliza por defecto:

`GET /api/bot/publications?instance_id={BOT_INSTANCE_ID}`

La ruta está protegida por el token de agente y el contexto de workspace de SocialPublicator. El controlador filtra las publicaciones por las cuentas sociales autorizadas para esa instancia, por conexiones activas y por permisos del usuario creador sobre los destinos.

La ruta anterior `/api/bot/publicaciones` permanece disponible en SocialPublicator para compatibilidad. En WBot se puede seleccionar explícitamente con `BOT_PUBLICATIONS_ENDPOINT=/api/bot/publicaciones` durante una migración gradual.

## Adaptación de payload

`publication-contract.js` traduce el contrato versionado en inglés al formato interno histórico que consume el motor de entrega de WBot. Campos principales:

| Contrato moderno | Alias interno conservado |
|---|---|
| `occurrence_id` | `ocurrencia_id` |
| `date` | `fecha` |
| `time` | `hora` |
| `text` | `texto` |
| `image` | `imagen` |
| `destination` | `destino` |
| `whatsapp_groups` | `whatsapp_groups` |
| `facebook_groups` | `facebook_groups` |

Se conservan los campos originales para que los siguientes canales no pierdan información. La identidad de la ocurrencia se mantiene estable y es la clave usada por la deduplicación local existente.

## Compatibilidad y límites

- La ruta antigua del servidor no se elimina.
- Las publicaciones y destinos existentes siguen procesándose por el mismo motor de entrega.
- WhatsApp continúa usando la sesión WPPConnect persistente.
- Facebook Groups continúa usando la sesión persistente de navegador/Puppeteer de WBot; esta vía no oficial puede cambiar con la interfaz de Meta.
- Las páginas de Facebook deberán utilizar OAuth/API oficial desde SocialPublicator cuando esté habilitado; WBot no debe asumir que la sesión de perfil equivale a una conexión oficial de página.
- La validación actual de WBot todavía requiere una URL de imagen no vacía; publicaciones solo de texto no forman parte de esta fase.

## Validación

`npm test` cubre los payloads modernos y heredados. CI comprueba sintaxis y ejecuta la suite en Node.js 22 y 26.
