# WBot — línea base de CI

## Objetivo de la Fase 0

Establecer una validación repetible antes de continuar con cambios funcionales del agente.

## Matriz de compatibilidad

GitHub Actions ejecuta la misma validación sobre Node.js 22 y 26. La instalación usa
`npm ci` y define `PUPPETEER_SKIP_DOWNLOAD=true`: las pruebas unitarias no necesitan
descargar Chromium y deben poder ejecutarse sin una sesión de navegador.

## Validaciones automatizadas

1. Instalación reproducible desde `package-lock.json`.
2. Comprobación sintáctica de `bot.js`, `facebook-pacing.js`, `heartbeat.js` y
   `laravel-api.js`.
3. Suite automatizada con `npm test` (`node --test`).
4. Informe de vulnerabilidades de dependencias con `npm audit`. Este informe es
   informativo y no bloquea CI mientras se clasifica y corrige el inventario heredado.

## Ejecución local

```bash
npm ci
node --check bot.js
node --check facebook-pacing.js
node --check heartbeat.js
node --check laravel-api.js
npm test
npm audit
```

## Contrato de pruebas de integración

Las pruebas de `laravel-api.js` simulan `fetch`; no requieren credenciales reales,
WhatsApp, Facebook, Chromium ni una instancia de SocialPublicator. Los identificadores
`SOCIAL_ACCOUNT_ID` y `BOT_INSTANCE_ID` de las pruebas son valores ficticios.

## Criterio de salida

La Fase 0 se considera validada cuando los dos entornos de Node completan instalación,
sintaxis y pruebas. Los avisos de auditoría se documentan y se priorizan por severidad
y disponibilidad de una actualización compatible; no se ocultan ni se convierten en
fallos artificiales de CI.
