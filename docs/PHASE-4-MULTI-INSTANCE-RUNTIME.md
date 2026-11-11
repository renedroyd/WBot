# WBot — Fase 4: runtime multi-instancia y aislamiento de cuentas

## Modelo operativo

El runtime permite ejecutar varios workers WBot dentro del mismo proceso supervisor.
Cada worker es un proceso Node independiente, con:

- Un `BOT_INSTANCE_ID` único y un token de agente individual emitido por SocialPublicator.
- Una cuenta WhatsApp propia y su nombre de sesión WPPConnect.
- Una cuenta de perfil Facebook opcional para la automatización de grupos.
- Un perfil Chromium compartido únicamente entre WhatsApp y Facebook de ese worker.
- Directorios de sesión, tokens, lock, backups, caché e historial local aislados del resto de workers.

No se permite asignar la misma cuenta WhatsApp o perfil Facebook a dos workers. Tampoco
se permite compartir tokens, nombres de sesión o rutas locales. El supervisor elimina
del entorno de cada proceso los tokens correspondientes a los demás workers.

## Configuración

1. Copia `instances.example.json` a `instances.json`.
2. Sustituye los IDs de ejemplo por IDs reales de cuentas del workspace en SocialPublicator.
3. Crea un Bot Agent/instancia por worker y emite un token individual para cada uno.
4. Define los tokens como variables de entorno, sin guardarlos en el JSON.
5. Ejecuta `npm run start:instances`.

Windows PowerShell:

```powershell
$env:WBOT_VENTAS_TOKEN = "TOKEN_EMITIDO_POR_SOCIALPUBLICATOR"
$env:WBOT_MAYORISTA_TOKEN = "OTRO_TOKEN_INDIVIDUAL"
npm run start:instances
```

Linux:

```bash
export WBOT_VENTAS_TOKEN="TOKEN_EMITIDO_POR_SOCIALPUBLICATOR"
export WBOT_MAYORISTA_TOKEN="OTRO_TOKEN_INDIVIDUAL"
npm run start:instances
```

El archivo de configuración puede cambiarse con `BOT_INSTANCES_CONFIG`. No se versiona
`instances.json` ni la carpeta `runtime/`.

## Supervisión y recuperación

El supervisor inicia todos los workers, reinicia procesos que terminan inesperadamente
con backoff exponencial hasta 60 segundos y detiene ordenadamente los procesos ante
SIGINT/SIGTERM. Cada worker conserva su propio historial de publicaciones para evitar
colisiones de estado local.

## Compatibilidad

- `npm start` mantiene el modo independiente/legacy de una sola instancia.
- `npm run start:instances` activa el supervisor multi-instancia.
- Cada worker sigue ejecutando una cuenta WhatsApp y, opcionalmente, un perfil Facebook.
- Facebook Groups conserva el flujo de sesión persistente del navegador; el perfil se
  comparte solo entre WhatsApp y Facebook del mismo worker, nunca entre workers.
- Facebook Pages oficiales permanecen en el flujo OAuth/API de SocialPublicator.
- Dubai-Shop no se conecta directamente a WBot: SocialPublicator mantiene la integración
  comercial y entrega al agente las publicaciones resultantes.

## Criterios de salida

- Validación estricta de IDs, tokens, cuentas, nombres de sesión y rutas.
- Aislamiento de datos locales, sesiones y perfiles Chromium por worker.
- Reinicio automático con backoff y apagado ordenado.
- Pruebas unitarias del mapeo de cuentas y variables de entorno.
